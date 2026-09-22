use futures_util::StreamExt;
mod installer;
mod rag;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    time::{Duration, Instant},
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
    model_name: Option<String>,
    context_size: Option<u32>,
    memory_bytes: Option<u64>,
    backend: Option<String>,
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
    content: serde_json::Value,
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
struct ChatMetrics {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    elapsed_ms: u64,
    tokens_per_second: f64,
    prompt_tokens_per_second: Option<f64>,
}

#[derive(Debug, Default, PartialEq)]
struct SseChunk {
    content: Option<String>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    tokens_per_second: Option<f64>,
    prompt_tokens_per_second: Option<f64>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRequest {
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentPayload {
    name: String,
    mime: String,
    size: u64,
    kind: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchRequest {
    query: String,
    limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
struct SearchRss {
    channel: SearchChannel,
}

#[derive(Clone, Debug, Deserialize)]
struct SearchChannel {
    #[serde(default)]
    item: Vec<SearchItem>,
}

#[derive(Clone, Debug, Deserialize)]
struct SearchItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn command_text(program: &str, args: &[&str]) -> Option<String> {
    let output = StdCommand::new(program).args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

fn process_memory_bytes(pid: u32) -> Option<u64> {
    let pid = pid.to_string();
    command_text("/bin/ps", &["-o", "rss=", "-p", &pid])
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|kilobytes| kilobytes.saturating_mul(1024))
}

fn clean_search_snippet(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut inside_tag = false;
    for character in value.chars() {
        match character {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => result.push(character),
            _ => {}
        }
    }
    result
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

#[tauri::command]
async fn read_attachment(request: AttachmentRequest) -> Result<AttachmentPayload, String> {
    let path = validate_file(&request.path, "attachment")?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect attachment: {error}"))?;
    let size = metadata.len();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_owned();
    let image_mime = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(mime) = image_mime {
        if size > 12 * 1024 * 1024 {
            return Err("Images are limited to 12 MB".into());
        }
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("Could not read image: {error}"))?;
        return Ok(AttachmentPayload {
            name,
            mime: mime.into(),
            size,
            kind: "image".into(),
            content: format!("data:{mime};base64,{}", BASE64.encode(bytes)),
        });
    }
    let mime =
        match extension.as_str() {
            "txt" => "text/plain",
            "md" | "markdown" => "text/markdown",
            "csv" => "text/csv",
            "json" => "application/json",
            "rs" | "swift" | "js" | "jsx" | "ts" | "tsx" | "py" | "sh" | "toml" | "yaml"
            | "yml" | "xml" | "html" | "css" => "text/plain",
            _ => return Err(
                "Supported attachments: PNG, JPEG, WebP, TXT, Markdown, CSV, JSON and source code"
                    .into(),
            ),
        };
    if size > 2 * 1024 * 1024 {
        return Err("Text attachments are limited to 2 MB".into());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| format!("Attachment must contain valid UTF-8 text: {error}"))?;
    Ok(AttachmentPayload {
        name,
        mime: mime.into(),
        size,
        kind: "text".into(),
        content,
    })
}

#[tauri::command]
async fn web_search(
    state: State<'_, AppState>,
    request: WebSearchRequest,
) -> Result<Vec<WebSearchResult>, String> {
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 500 {
        return Err("Search query must contain between 1 and 500 characters".into());
    }
    let response = state
        .client
        .get("https://www.bing.com/search")
        .query(&[("q", query), ("format", "rss")])
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|error| format!("Web search failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Web search returned {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read search response: {error}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("Search response exceeded 1 MB".into());
    }
    let feed: SearchRss = quick_xml::de::from_reader(bytes.as_ref())
        .map_err(|error| format!("Could not parse search response: {error}"))?;
    let limit = request.limit.unwrap_or(5).clamp(1, 5);
    Ok(feed
        .channel
        .item
        .into_iter()
        .filter(|item| item.link.starts_with("https://") || item.link.starts_with("http://"))
        .take(limit)
        .map(|item| WebSearchResult {
            title: item.title,
            url: item.link,
            snippet: clean_search_snippet(&item.description),
        })
        .collect())
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
        model_name: model
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned),
        context_size: Some(config.context_size),
        memory_bytes: None,
        backend: Some("llama.cpp · Metal · optimized for Apple Silicon".into()),
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
                        model_name: model
                            .file_name()
                            .and_then(|value| value.to_str())
                            .map(ToOwned::to_owned),
                        context_size: Some(config.context_size),
                        memory_bytes: None,
                        backend: Some("llama.cpp · Metal · optimized for Apple Silicon".into()),
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
            let memory_bytes = managed
                .child
                .as_ref()
                .and_then(|child| child.id())
                .and_then(process_memory_bytes);
            managed.status = ServerStatus {
                phase: ServerPhase::Ready,
                port: config.port,
                detail: Some(format!("OpenAI endpoint: http://{HOST}:{}/v1", config.port)),
                model_name: model
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(ToOwned::to_owned),
                context_size: Some(config.context_size),
                memory_bytes,
                backend: Some("llama.cpp · Metal · optimized for Apple Silicon".into()),
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
        model_name: model
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToOwned::to_owned),
        context_size: Some(config.context_size),
        memory_bytes: None,
        backend: Some("llama.cpp · Metal · optimized for Apple Silicon".into()),
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
        model_name: None,
        context_size: None,
        memory_bytes: None,
        backend: None,
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
            managed.status.memory_bytes = None;
        } else if let Some(pid) = child.id() {
            managed.status.memory_bytes = process_memory_bytes(pid);
        }
    }
    Ok(managed.status.clone())
}

fn parse_sse_line(line: &[u8]) -> Result<Option<SseChunk>, String> {
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
    let content = value["choices"][0]["delta"]["content"]
        .as_str()
        .map(ToOwned::to_owned);
    let usage = value.get("usage");
    let timings = value.get("timings");
    Ok(Some(SseChunk {
        content,
        prompt_tokens: usage
            .and_then(|item| item.get("prompt_tokens"))
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                timings.map(|item| {
                    let prompt = item
                        .get("prompt_n")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or_default();
                    let cached = item
                        .get("cache_n")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or_default();
                    prompt.saturating_add(cached)
                })
            }),
        completion_tokens: usage
            .and_then(|item| item.get("completion_tokens"))
            .and_then(serde_json::Value::as_u64)
            .or_else(|| {
                timings
                    .and_then(|item| item.get("predicted_n"))
                    .and_then(serde_json::Value::as_u64)
            }),
        total_tokens: usage
            .and_then(|item| item.get("total_tokens"))
            .and_then(serde_json::Value::as_u64),
        tokens_per_second: timings
            .and_then(|item| item.get("predicted_per_second"))
            .and_then(serde_json::Value::as_f64),
        prompt_tokens_per_second: timings
            .and_then(|item| item.get("prompt_per_second"))
            .and_then(serde_json::Value::as_f64),
    }))
}

#[tauri::command]
async fn stream_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ChatRequest,
) -> Result<Option<ChatMetrics>, String> {
    {
        let managed = state.server.lock().await;
        if !matches!(managed.status.phase, ServerPhase::Ready)
            || managed.status.port != request.port
        {
            return Err("The local model is not ready".into());
        }
    }
    let started_at = Instant::now();
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
            "stream_options": { "include_usage": true },
            "timings_per_token": true,
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
    let mut prompt_tokens = None;
    let mut completion_tokens = None;
    let mut total_tokens = None;
    let mut tokens_per_second = None;
    let mut prompt_tokens_per_second = None;
    while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk.map_err(|error| format!("Stream interrupted: {error}"))?);
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            if let Some(parsed) = parse_sse_line(&line)? {
                if let Some(content) = parsed.content {
                    app.emit(
                        "chat-token",
                        TokenEvent {
                            request_id: request.request_id.clone(),
                            content,
                        },
                    )
                    .map_err(|error| error.to_string())?;
                }
                prompt_tokens = parsed.prompt_tokens.or(prompt_tokens);
                completion_tokens = parsed.completion_tokens.or(completion_tokens);
                total_tokens = parsed.total_tokens.or(total_tokens);
                tokens_per_second = parsed.tokens_per_second.or(tokens_per_second);
                prompt_tokens_per_second =
                    parsed.prompt_tokens_per_second.or(prompt_tokens_per_second);
            }
        }
    }
    if !buffer.is_empty() {
        if let Some(parsed) = parse_sse_line(&buffer)? {
            if let Some(content) = parsed.content {
                app.emit(
                    "chat-token",
                    TokenEvent {
                        request_id: request.request_id.clone(),
                        content,
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            prompt_tokens = parsed.prompt_tokens.or(prompt_tokens);
            completion_tokens = parsed.completion_tokens.or(completion_tokens);
            total_tokens = parsed.total_tokens.or(total_tokens);
            tokens_per_second = parsed.tokens_per_second.or(tokens_per_second);
            prompt_tokens_per_second = parsed.prompt_tokens_per_second.or(prompt_tokens_per_second);
        }
    }
    let prompt_tokens = prompt_tokens.unwrap_or_default();
    let completion_tokens = completion_tokens.unwrap_or_default();
    if prompt_tokens == 0 && completion_tokens == 0 {
        return Ok(None);
    }
    let elapsed_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let tokens_per_second = tokens_per_second.unwrap_or_else(|| {
        if elapsed_ms == 0 {
            0.0
        } else {
            completion_tokens as f64 / (elapsed_ms as f64 / 1000.0)
        }
    });
    Ok(Some(ChatMetrics {
        prompt_tokens,
        completion_tokens,
        total_tokens: total_tokens.unwrap_or(prompt_tokens.saturating_add(completion_tokens)),
        elapsed_ms,
        tokens_per_second,
        prompt_tokens_per_second,
    }))
}

pub fn run() {
    let http_client = reqwest::Client::builder()
        .user_agent(format!("GZ-Bonsai-27B/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("could not create HTTP client");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
            read_attachment,
            web_search,
            rag::import_rag_document,
            rag::list_rag_documents,
            rag::search_rag_documents,
            installer::managed_catalog,
            installer::install_runtime,
            installer::install_model,
            installer::install_projector,
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
        let parsed = parse_sse_line(line).unwrap().unwrap();
        assert_eq!(parsed.content.as_deref(), Some("hello"));
        assert_eq!(parse_sse_line(b"data: [DONE]").unwrap(), None);
        assert_eq!(parse_sse_line(b": keep-alive").unwrap(), None);
    }

    #[test]
    fn parses_openai_stream_usage_and_timings() {
        let line = br#"data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150},"timings":{"prompt_per_second":48.5,"predicted_per_second":12.25}}"#;
        let parsed = parse_sse_line(line).unwrap().unwrap();
        assert!(parsed.content.is_none());
        assert_eq!(parsed.prompt_tokens, Some(120));
        assert_eq!(parsed.completion_tokens, Some(30));
        assert_eq!(parsed.total_tokens, Some(150));
        assert_eq!(parsed.tokens_per_second, Some(12.25));
        assert_eq!(parsed.prompt_tokens_per_second, Some(48.5));
    }
}
