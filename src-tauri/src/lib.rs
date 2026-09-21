use futures_util::StreamExt;
mod installer;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

const HOST: &str = "127.0.0.1";
const HEALTH_ATTEMPTS: usize = 180;

#[derive(Default)]
struct ManagedServer {
    child: Option<Child>,
    status: ServerStatus,
}

struct AppState {
    server: Mutex<ManagedServer>,
    client: reqwest::Client,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    phase: ServerPhase,
    port: u16,
    detail: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "lowercase")]
enum ServerPhase {
    #[default]
    Stopped,
    Starting,
    Ready,
    Stopping,
    Error,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartConfig {
    runtime_path: String,
    model_path: String,
    projector_path: Option<String>,
    port: u16,
    context_size: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    request_id: String,
    port: u16,
    messages: Vec<ChatMessage>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent {
    request_id: String,
    content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    app_version: String,
    architecture: String,
    macos_version: String,
    chip: String,
    memory_bytes: u64,
    free_disk_bytes: u64,
}

fn command_text(program: &str, args: &[&str]) -> Option<String> {
    let output = StdCommand::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[tauri::command]
fn system_info() -> SystemInfo {
    let memory_bytes = command_text("/usr/sbin/sysctl", &["-n", "hw.memsize"])
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    let free_disk_bytes = command_text("/bin/df", &["-Pk", "/"])
        .and_then(|output| output.lines().last().map(ToOwned::to_owned))
        .and_then(|line| line.split_whitespace().nth(3)?.parse::<u64>().ok())
        .unwrap_or_default()
        .saturating_mul(1024);
    SystemInfo {
        app_version: env!("CARGO_PKG_VERSION").into(),
        architecture: std::env::consts::ARCH.into(),
        macos_version: command_text("/usr/bin/sw_vers", &["-productVersion"])
            .unwrap_or_else(|| "unknown".into()),
        chip: command_text("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"])
            .unwrap_or_else(|| "unknown".into()),
        memory_bytes,
        free_disk_bytes,
    }
}

fn validate_file(path: &str, label: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err(format!("{label}: path is empty"));
    }
    let canonical = Path::new(path)
        .canonicalize()
        .map_err(|error| format!("{label}: {error}"))?;
    if !canonical.is_file() {
        return Err(format!("{label}: not a file"));
    }
    Ok(canonical)
}

fn validate_config(config: &StartConfig) -> Result<(PathBuf, PathBuf, Option<PathBuf>), String> {
    if config.port < 1024 {
        return Err("Port must be between 1024 and 65535".into());
    }
    if !(1024..=262_144).contains(&config.context_size) {
        return Err("Context must be between 1024 and 262144 tokens".into());
    }
    let runtime = validate_file(&config.runtime_path, "llama-server")?;
    let model = validate_file(&config.model_path, "model")?;
    if model.extension().and_then(|value| value.to_str()) != Some("gguf") {
        return Err("The model must be a .gguf file".into());
    }
    let projector = config
        .projector_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .map(|path| validate_file(path, "vision projector"))
        .transpose()?;
    Ok((runtime, model, projector))
}

fn server_args(config: &StartConfig, model: &Path, projector: Option<&Path>) -> Vec<String> {
    let mut args = vec![
        "--host".into(),
        HOST.into(),
        "--port".into(),
        config.port.to_string(),
        "-m".into(),
        model.display().to_string(),
        "-c".into(),
        config.context_size.to_string(),
        "-ngl".into(),
        "99".into(),
    ];
    if let Some(projector) = projector {
        args.push("--mmproj".into());
        args.push(projector.display().to_string());
    }
    args
}

fn emit_status(app: &AppHandle, status: &ServerStatus) {
    let _ = app.emit("server-status", status);
}

fn pipe_logs<R>(app: AppHandle, reader: R, prefix: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app.emit("server-log", format!("[{prefix}] {line}"));
        }
    });
}

#[tauri::command]
async fn start_server(
    app: AppHandle,
    state: State<'_, AppState>,
    config: StartConfig,
) -> Result<ServerStatus, String> {
    let (runtime, model, projector) = validate_config(&config)?;
    let mut managed = state.server.lock().await;
    if let Some(child) = managed.child.as_mut() {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err("A server process is already running".into());
        }
        managed.child = None;
    }
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    TcpListener::bind(address)
        .map_err(|error| format!("Port {} is unavailable: {error}", config.port))?;

    managed.status = ServerStatus {
        phase: ServerPhase::Starting,
        port: config.port,
        detail: Some("Loading model and waiting for health check".into()),
    };
    emit_status(&app, &managed.status);

    let args = server_args(&config, &model, projector.as_deref());
    let _ = app.emit(
        "server-log",
        format!("Starting {} on {HOST}:{}", runtime.display(), config.port),
    );
    let mut command = Command::new(&runtime);
    command
        .args(&args)
        .current_dir(runtime.parent().unwrap_or_else(|| Path::new("/")))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start llama-server: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        pipe_logs(app.clone(), stdout, "server");
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_logs(app.clone(), stderr, "server");
    }
    managed.child = Some(child);
    drop(managed);

    let health_url = format!("http://{HOST}:{}/health", config.port);
    for _ in 0..HEALTH_ATTEMPTS {
        tokio::time::sleep(Duration::from_secs(1)).await;
        {
            let mut managed = state.server.lock().await;
            if let Some(child) = managed.child.as_mut() {
                if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
                    managed.child = None;
                    managed.status = ServerStatus {
                        phase: ServerPhase::Error,
                        port: config.port,
                        detail: Some(format!("llama-server exited before becoming ready: {exit}")),
                    };
                    emit_status(&app, &managed.status);
                    return Err(managed.status.detail.clone().unwrap_or_default());
                }
            }
        }
        if state
            .client
            .get(&health_url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            let mut managed = state.server.lock().await;
            managed.status = ServerStatus {
                phase: ServerPhase::Ready,
                port: config.port,
                detail: Some(format!("OpenAI endpoint: http://{HOST}:{}/v1", config.port)),
            };
            emit_status(&app, &managed.status);
            return Ok(managed.status.clone());
        }
    }

    let mut managed = state.server.lock().await;
    if let Some(mut child) = managed.child.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    managed.status = ServerStatus {
        phase: ServerPhase::Error,
        port: config.port,
        detail: Some("Health check timed out after 180 seconds".into()),
    };
    emit_status(&app, &managed.status);
    Err(managed.status.detail.clone().unwrap_or_default())
}

#[tauri::command]
async fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<ServerStatus, String> {
    let mut managed = state.server.lock().await;
    managed.status.phase = ServerPhase::Stopping;
    emit_status(&app, &managed.status);
    if let Some(mut child) = managed.child.take() {
        child
            .kill()
            .await
            .map_err(|error| format!("Could not stop llama-server: {error}"))?;
        let _ = child.wait().await;
    }
    managed.status = ServerStatus {
        phase: ServerPhase::Stopped,
        port: managed.status.port,
        detail: None,
    };
    emit_status(&app, &managed.status);
    Ok(managed.status.clone())
}

#[tauri::command]
async fn server_status(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    let mut managed = state.server.lock().await;
    if let Some(child) = managed.child.as_mut() {
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            managed.child = None;
            managed.status.phase = ServerPhase::Error;
            managed.status.detail = Some(format!("llama-server exited: {exit}"));
        }
    }
    Ok(managed.status.clone())
}

fn parse_sse_line(line: &[u8]) -> Result<Option<String>, String> {
    let line = std::str::from_utf8(line)
        .map_err(|error| error.to_string())?
        .trim();
    let Some(data) = line.strip_prefix("data:") else {
        return Ok(None);
    };
    let data = data.trim();
    if data == "[DONE]" {
        return Ok(None);
    }
    let value: serde_json::Value = serde_json::from_str(data)
        .map_err(|error| format!("Invalid streaming response: {error}"))?;
    Ok(value["choices"][0]["delta"]["content"]
        .as_str()
        .map(ToOwned::to_owned))
}

#[tauri::command]
async fn stream_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ChatRequest,
) -> Result<(), String> {
    {
        let managed = state.server.lock().await;
        if !matches!(managed.status.phase, ServerPhase::Ready)
            || managed.status.port != request.port
        {
            return Err("The local model is not ready".into());
        }
    }
    let response = state
        .client
        .post(format!(
            "http://{HOST}:{}/v1/chat/completions",
            request.port
        ))
        .json(&json!({
            "model": "bonsai",
            "messages": request.messages,
            "stream": true,
            "temperature": 0.5,
            "top_p": 0.85,
            "top_k": 20,
            "thinking_budget_tokens": 512
        }))
        .send()
        .await
        .map_err(|error| format!("Chat request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("llama-server returned {status}: {body}"));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk.map_err(|error| format!("Stream interrupted: {error}"))?);
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            if let Some(content) = parse_sse_line(&line)? {
                app.emit(
                    "chat-token",
                    TokenEvent {
                        request_id: request.request_id.clone(),
                        content,
                    },
                )
                .map_err(|error| error.to_string())?;
            }
        }
    }
    if !buffer.is_empty() {
        if let Some(content) = parse_sse_line(&buffer)? {
            app.emit(
                "chat-token",
                TokenEvent {
                    request_id: request.request_id,
                    content,
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub fn run() {
    let http_client = reqwest::Client::builder()
        .user_agent(format!("GZ-Bonsai-27B/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("could not create HTTP client");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            server: Mutex::new(ManagedServer::default()),
            client: http_client.clone(),
        })
        .manage(installer::InstallerState::new(http_client))
        .invoke_handler(tauri::generate_handler![
            system_info,
            start_server,
            stop_server,
            server_status,
            stream_chat,
            installer::managed_catalog,
            installer::install_runtime,
            installer::install_model,
            installer::pause_install,
            installer::cancel_install,
            installer::remove_model
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                if let Ok(mut managed) = state.server.try_lock() {
                    if let Some(child) = managed.child.as_mut() {
                        let _ = child.start_kill();
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Bonsai Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_arguments_always_bind_to_loopback() {
        let config = StartConfig {
            runtime_path: "/tmp/llama-server".into(),
            model_path: "/tmp/model.gguf".into(),
            projector_path: None,
            port: 8080,
            context_size: 8192,
        };
        let args = server_args(&config, Path::new("/tmp/model.gguf"), None);
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        assert!(!args.iter().any(|argument| argument == "0.0.0.0"));
    }

    #[test]
    fn server_arguments_include_optional_projector() {
        let config = StartConfig {
            runtime_path: "/tmp/llama-server".into(),
            model_path: "/tmp/model.gguf".into(),
            projector_path: Some("/tmp/mmproj.gguf".into()),
            port: 8080,
            context_size: 4096,
        };
        let args = server_args(
            &config,
            Path::new("/tmp/model.gguf"),
            Some(Path::new("/tmp/mmproj.gguf")),
        );
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--mmproj", "/tmp/mmproj.gguf"]));
    }

    #[test]
    fn parses_openai_stream_content() {
        let line = br#"data: {"choices":[{"delta":{"content":"hello"}}]}"#;
        assert_eq!(parse_sse_line(line).unwrap(), Some("hello".into()));
        assert_eq!(parse_sse_line(b"data: [DONE]").unwrap(), None);
        assert_eq!(parse_sse_line(b": keep-alive").unwrap(), None);
    }
}
