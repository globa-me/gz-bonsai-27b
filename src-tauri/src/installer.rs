use futures_util::StreamExt;
use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
    sync::Mutex,
};

const RUNTIME_VERSION: &str = "prism-b10709-9a9394a";
const DISK_RESERVE: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
struct ModelDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    url: &'static str,
    filename: &'static str,
    size: u64,
    sha256: &'static str,
    estimated_memory: u64,
    context_size: u32,
}

#[derive(Clone, Copy)]
struct ProjectorDefinition {
    url: &'static str,
    filename: &'static str,
    size: u64,
    sha256: &'static str,
}

const MODELS: [ModelDefinition; 6] = [
    ModelDefinition {
        id: "bonsai-1.7b-q1",
        name: "Bonsai 1.7B · Q1_0",
        description: "Самая лёгкая модель для знакомства и быстрых локальных задач.",
        url: "https://huggingface.co/prism-ml/Bonsai-1.7B-gguf/resolve/210a9e99f79cb184909d49595906526eb2b3dd9a/Bonsai-1.7B-Q1_0.gguf?download=true",
        filename: "Bonsai-1.7B-Q1_0.gguf",
        size: 248_302_272,
        sha256: "3d7c6c90dd98717a203adb22d5eacd2581850e40aa5327e144b97766cae5f7e3",
        estimated_memory: 8 * 1024 * 1024 * 1024,
        context_size: 4_096,
    },
    ModelDefinition {
        id: "bonsai-4b-q1",
        name: "Bonsai 4B · Q1_0",
        description: "Компактный баланс скорости и качества.",
        url: "https://huggingface.co/prism-ml/Bonsai-4B-gguf/resolve/78f2c2bacd0904ffaba24b4873ed975e5818354a/Bonsai-4B-Q1_0.gguf?download=true",
        filename: "Bonsai-4B-Q1_0.gguf",
        size: 572_270_624,
        sha256: "4524b3f997f0f06444e568d1f26e2efd69effa3218c7ad3047432fb171e42168",
        estimated_memory: 12 * 1024 * 1024 * 1024,
        context_size: 8_192,
    },
    ModelDefinition {
        id: "bonsai-8b-q1",
        name: "Bonsai 8B · Q1_0",
        description: "Более сильная компактная модель для Mac с запасом памяти.",
        url: "https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/48516770dd04643643e9f9019a2a349cf26c5dbd/Bonsai-8B-Q1_0.gguf?download=true",
        filename: "Bonsai-8B-Q1_0.gguf",
        size: 1_158_654_496,
        sha256: "284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54",
        estimated_memory: 16 * 1024 * 1024 * 1024,
        context_size: 16_384,
    },
    ModelDefinition {
        id: "bonsai-27b-q1",
        name: "Bonsai 27B · 1-bit Q1_0",
        description: "Полная 27B-модель с бинарными весами и минимальным размером.",
        url: "https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/f10afb355f104535e3e3e98cf7ab7795c72bd292/Bonsai-27B-Q1_0.gguf?download=true",
        filename: "Bonsai-27B-Q1_0.gguf",
        size: 3_803_452_480,
        sha256: "17ef842e47450caeb8eaa3ebfbbab5d2f2278b62b79be107985fb69a2f819aa0",
        estimated_memory: 16 * 1024 * 1024 * 1024,
        context_size: 8_192,
    },
    ModelDefinition {
        id: "bonsai-2-27b-ptq1",
        name: "Bonsai 2 27B · ternary PTQ1_0",
        description: "Тернарная 27B-модель в самой компактной плотной упаковке trits.",
        url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PTQ1_0.gguf?download=true",
        filename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf",
        size: 5_946_648_928,
        sha256: "53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3",
        estimated_memory: 24 * 1024 * 1024 * 1024,
        context_size: 8_192,
    },
    ModelDefinition {
        id: "bonsai-2-27b-pq2",
        name: "Bonsai 2 27B · ternary PQ2_0",
        description: "Тернарная 27B-модель в упаковке, измеренной PrismML на Apple Silicon.",
        url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true",
        filename: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
        size: 7_206_168_928,
        sha256: "3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1",
        estimated_memory: 32 * 1024 * 1024 * 1024,
        context_size: 16_384,
    },
];

pub struct InstallerState {
    client: Client,
    active: Mutex<HashMap<String, Arc<DownloadControl>>>,
}

#[derive(Default)]
struct DownloadControl {
    stop: AtomicBool,
    discard: AtomicBool,
}

impl InstallerState {
    pub fn new(client: Client) -> Self {
        Self {
            client,
            active: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    id: String,
    name: String,
    description: String,
    filename: String,
    size_bytes: u64,
    estimated_memory_bytes: u64,
    context_size: u32,
    installed: bool,
    installed_path: Option<String>,
    vision_capable: bool,
    projector_installed: bool,
    projector_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCatalog {
    runtime_version: String,
    runtime_installed: bool,
    runtime_path: Option<String>,
    models: Vec<CatalogModel>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    phase: String,
    downloaded_bytes: u64,
    total_bytes: u64,
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequest {
    model_id: String,
}

fn model_definition(id: &str) -> Result<ModelDefinition, String> {
    MODELS
        .iter()
        .copied()
        .find(|model| model.id == id)
        .ok_or_else(|| "Unknown model identifier".to_string())
}

fn projector_definition(model: ModelDefinition) -> Option<ProjectorDefinition> {
    match model.id {
        "bonsai-27b-q1" => Some(ProjectorDefinition {
            url: "https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/f10afb355f104535e3e3e98cf7ab7795c72bd292/Bonsai-27B-mmproj-Q8_0.gguf?download=true",
            filename: "Bonsai-27B-mmproj-Q8_0.gguf",
            size: 629_246_880,
            sha256: "eb561d41a7bbeb0fcf04883c8af11078ef6ca0a66862a0b68443cfca495269d",
        }),
        "bonsai-2-27b-ptq1" | "bonsai-2-27b-pq2" => Some(ProjectorDefinition {
            url: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf?download=true",
            filename: "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
            size: 629_246_976,
            sha256: "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903",
        }),
        _ => None,
    }
}

fn managed_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("managed"))
        .map_err(|error| format!("Could not resolve application data directory: {error}"))
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|root| {
            root.join("runtime")
                .join(RUNTIME_VERSION)
                .join("llama-server")
        })
        .map_err(|error| format!("Could not resolve bundled runtime: {error}"))
}

fn model_path(root: &Path, model: ModelDefinition) -> PathBuf {
    root.join("models").join(model.id).join(model.filename)
}

fn projector_path(root: &Path, model: ModelDefinition, projector: ProjectorDefinition) -> PathBuf {
    root.join("models").join(model.id).join(projector.filename)
}

fn verified_marker(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.sha256",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ))
}

fn is_verified(path: &Path, expected_size: u64, expected_sha: &str) -> bool {
    path.metadata()
        .is_ok_and(|metadata| metadata.len() == expected_size)
        && std::fs::read_to_string(verified_marker(path))
            .is_ok_and(|value| value.trim() == expected_sha)
}

#[tauri::command]
pub fn managed_catalog(app: AppHandle) -> Result<ManagedCatalog, String> {
    let root = managed_root(&app)?;
    let runtime = runtime_path(&app)?;
    let runtime_installed = runtime.is_file();
    Ok(ManagedCatalog {
        runtime_version: RUNTIME_VERSION.into(),
        runtime_installed,
        runtime_path: runtime_installed.then(|| runtime.display().to_string()),
        models: MODELS
            .iter()
            .copied()
            .map(|model| {
                let path = model_path(&root, model);
                let installed = is_verified(&path, model.size, model.sha256);
                let projector = projector_definition(model);
                let projector_status = projector.map(|definition| {
                    let path = projector_path(&root, model, definition);
                    let installed = is_verified(&path, definition.size, definition.sha256);
                    (installed, installed.then(|| path.display().to_string()))
                });
                CatalogModel {
                    id: model.id.into(),
                    name: model.name.into(),
                    description: model.description.into(),
                    filename: model.filename.into(),
                    size_bytes: model.size,
                    estimated_memory_bytes: model.estimated_memory,
                    context_size: model.context_size,
                    installed,
                    installed_path: installed.then(|| path.display().to_string()),
                    vision_capable: projector.is_some(),
                    projector_installed: projector_status.as_ref().is_some_and(|value| value.0),
                    projector_path: projector_status.and_then(|value| value.1),
                }
            })
            .collect(),
    })
}

async fn register_download(
    state: &InstallerState,
    id: &str,
) -> Result<Arc<DownloadControl>, String> {
    let mut active = state.active.lock().await;
    if active.contains_key(id) {
        return Err("This download is already running".into());
    }
    let control = Arc::new(DownloadControl::default());
    active.insert(id.to_string(), control.clone());
    Ok(control)
}

async fn finish_download(state: &InstallerState, id: &str) {
    state.active.lock().await.remove(id);
}

fn emit_progress(
    app: &AppHandle,
    id: &str,
    phase: &str,
    downloaded: u64,
    total: u64,
    detail: Option<String>,
) {
    let _ = app.emit(
        "download-progress",
        DownloadProgress {
            id: id.into(),
            phase: phase.into(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            detail,
        },
    );
}

fn free_disk_bytes() -> u64 {
    std::process::Command::new("/bin/df")
        .args(["-Pk", "/"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| {
            output
                .lines()
                .last()?
                .split_whitespace()
                .nth(3)?
                .parse::<u64>()
                .ok()
        })
        .unwrap_or_default()
        .saturating_mul(1024)
}

#[allow(clippy::too_many_arguments)]
async fn download_file(
    app: &AppHandle,
    client: &Client,
    id: &str,
    url: &str,
    destination: &Path,
    expected_size: u64,
    expected_sha: &str,
    control: &DownloadControl,
) -> Result<(), String> {
    if is_verified(destination, expected_size, expected_sha) {
        emit_progress(app, id, "complete", expected_size, expected_size, None);
        return Ok(());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Invalid download destination".to_string())?;
    fs::create_dir_all(parent)
        .await
        .map_err(|error| format!("Could not create download directory: {error}"))?;
    let partial = destination.with_extension(format!(
        "{}.part",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    let mut downloaded = fs::metadata(&partial)
        .await
        .map(|value| value.len())
        .unwrap_or(0);
    if downloaded > expected_size {
        fs::remove_file(&partial)
            .await
            .map_err(|error| format!("Could not reset partial download: {error}"))?;
        downloaded = 0;
    }
    if downloaded == expected_size {
        return verify_and_finalize(app, id, &partial, destination, expected_size, expected_sha)
            .await;
    }
    let needed = expected_size
        .saturating_sub(downloaded)
        .saturating_add(DISK_RESERVE);
    let free = free_disk_bytes();
    if free > 0 && free < needed {
        return Err(format!(
            "Not enough free disk space: {} bytes needed including reserve",
            needed
        ));
    }

    let mut request = client.get(url);
    if downloaded > 0 {
        request = request.header(header::RANGE, format!("bytes={downloaded}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Download request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download server returned {}", response.status()));
    }
    let final_url = response.url();
    let host = final_url.host_str().unwrap_or_default();
    let trusted_host = host == "huggingface.co"
        || host.ends_with(".huggingface.co")
        || host.ends_with(".hf.co")
        || host.ends_with(".xethub.hf.co")
        || host.ends_with(".amazonaws.com");
    if final_url.scheme() != "https" || !trusted_host {
        return Err(format!("Download redirected to an untrusted host: {host}"));
    }
    let should_append = downloaded > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    if should_append {
        let expected_prefix = format!("bytes {downloaded}-");
        let content_range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if !content_range.starts_with(&expected_prefix)
            || !content_range.ends_with(&format!("/{expected_size}"))
        {
            return Err("Download server returned an invalid Content-Range".into());
        }
    }
    if downloaded > 0 && !should_append {
        downloaded = 0;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(should_append)
        .truncate(!should_append)
        .open(&partial)
        .await
        .map_err(|error| format!("Could not open partial download: {error}"))?;
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    emit_progress(app, id, "downloading", downloaded, expected_size, None);
    while let Some(chunk) = stream.next().await {
        if control.stop.load(Ordering::Relaxed) {
            file.flush().await.ok();
            file.sync_all().await.ok();
            drop(file);
            if control.discard.load(Ordering::Relaxed) {
                fs::remove_file(&partial).await.ok();
                emit_progress(app, id, "cancelled", downloaded, expected_size, None);
                return Err("Download cancelled".into());
            }
            emit_progress(app, id, "paused", downloaded, expected_size, None);
            return Err("Download paused".into());
        }
        let chunk = chunk.map_err(|error| format!("Download interrupted: {error}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not save download: {error}"))?;
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if last_emit.elapsed() >= Duration::from_millis(120) {
            emit_progress(app, id, "downloading", downloaded, expected_size, None);
            last_emit = Instant::now();
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("Could not flush download: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Could not sync download: {error}"))?;
    drop(file);
    if downloaded != expected_size {
        return Err(format!(
            "Downloaded file has unexpected size: {downloaded} instead of {expected_size}"
        ));
    }

    verify_and_finalize(app, id, &partial, destination, expected_size, expected_sha).await
}

async fn verify_and_finalize(
    app: &AppHandle,
    id: &str,
    partial: &Path,
    destination: &Path,
    expected_size: u64,
    expected_sha: &str,
) -> Result<(), String> {
    emit_progress(app, id, "verifying", expected_size, expected_size, None);
    let partial_for_hash = partial.to_path_buf();
    let actual_sha = tauri::async_runtime::spawn_blocking(move || sha256_file(&partial_for_hash))
        .await
        .map_err(|error| format!("Checksum task failed: {error}"))??;
    if actual_sha != expected_sha {
        fs::remove_file(partial).await.ok();
        return Err(format!(
            "SHA-256 mismatch: expected {expected_sha}, got {actual_sha}"
        ));
    }
    if destination.exists() {
        fs::remove_file(destination)
            .await
            .map_err(|error| format!("Could not replace old download: {error}"))?;
    }
    fs::rename(partial, destination)
        .await
        .map_err(|error| format!("Could not finalize download: {error}"))?;
    fs::write(verified_marker(destination), expected_sha)
        .await
        .map_err(|error| format!("Could not save checksum marker: {error}"))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("Could not verify file: {error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Could not read file for verification: {error}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub fn install_runtime(app: AppHandle) -> Result<String, String> {
    let runtime = runtime_path(&app)?;
    runtime
        .is_file()
        .then(|| runtime.display().to_string())
        .ok_or_else(|| "The signed bundled runtime is missing".into())
}

#[tauri::command]
pub async fn install_model(
    app: AppHandle,
    state: State<'_, InstallerState>,
    request: ModelRequest,
) -> Result<String, String> {
    let model = model_definition(&request.model_id)?;
    let control = register_download(&state, model.id).await?;
    let result: Result<String, String> = async {
        let root = managed_root(&app)?;
        let destination = model_path(&root, model);
        download_file(
            &app,
            &state.client,
            model.id,
            model.url,
            &destination,
            model.size,
            model.sha256,
            &control,
        )
        .await?;
        emit_progress(&app, model.id, "complete", model.size, model.size, None);
        Ok(destination.display().to_string())
    }
    .await;
    if let Err(error) = &result {
        if error != "Download paused" && error != "Download cancelled" {
            emit_progress(&app, model.id, "error", 0, model.size, Some(error.clone()));
        }
    }
    finish_download(&state, model.id).await;
    result
}

#[tauri::command]
pub async fn install_projector(
    app: AppHandle,
    state: State<'_, InstallerState>,
    request: ModelRequest,
) -> Result<String, String> {
    let model = model_definition(&request.model_id)?;
    let projector = projector_definition(model)
        .ok_or_else(|| "This model does not support image attachments".to_string())?;
    let download_id = format!("{}-vision", model.id);
    let control = register_download(&state, &download_id).await?;
    let result: Result<String, String> = async {
        let root = managed_root(&app)?;
        let destination = projector_path(&root, model, projector);
        download_file(
            &app,
            &state.client,
            &download_id,
            projector.url,
            &destination,
            projector.size,
            projector.sha256,
            &control,
        )
        .await?;
        emit_progress(
            &app,
            &download_id,
            "complete",
            projector.size,
            projector.size,
            None,
        );
        Ok(destination.display().to_string())
    }
    .await;
    if let Err(error) = &result {
        if error != "Download paused" && error != "Download cancelled" {
            emit_progress(
                &app,
                &download_id,
                "error",
                0,
                projector.size,
                Some(error.clone()),
            );
        }
    }
    finish_download(&state, &download_id).await;
    result
}

#[tauri::command]
pub async fn pause_install(state: State<'_, InstallerState>, id: String) -> Result<(), String> {
    let active = state.active.lock().await;
    let control = active
        .get(&id)
        .ok_or_else(|| "No active download with this identifier".to_string())?;
    control.stop.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn cancel_install(state: State<'_, InstallerState>, id: String) -> Result<(), String> {
    let active = state.active.lock().await;
    let control = active
        .get(&id)
        .ok_or_else(|| "No active download with this identifier".to_string())?;
    control.discard.store(true, Ordering::Relaxed);
    control.stop.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn remove_model(app: AppHandle, request: ModelRequest) -> Result<(), String> {
    let model = model_definition(&request.model_id)?;
    let root = managed_root(&app)?;
    let directory = root.join("models").join(model.id);
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .await
            .map_err(|error| format!("Could not remove model: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique_and_paths_are_flat() {
        let mut ids = std::collections::HashSet::new();
        for model in MODELS {
            assert!(ids.insert(model.id));
            assert!(!model.filename.contains('/'));
            assert!(model.filename.ends_with(".gguf"));
            assert_eq!(model.sha256.len(), 64);
            assert!(model.url.starts_with("https://huggingface.co/prism-ml/"));
            assert!(model.size > 0);
        }
    }

    #[test]
    fn catalog_contains_binary_and_both_ternary_27b_packs() {
        let binary = model_definition("bonsai-27b-q1").expect("binary 27B must be available");
        assert_eq!(binary.filename, "Bonsai-27B-Q1_0.gguf");

        let compact_ternary =
            model_definition("bonsai-2-27b-ptq1").expect("PTQ1 ternary 27B must be available");
        assert_eq!(compact_ternary.filename, "Ternary-Bonsai-2-27B-PTQ1_0.gguf");

        let apple_ternary =
            model_definition("bonsai-2-27b-pq2").expect("PQ2 ternary 27B must be available");
        assert_eq!(apple_ternary.filename, "Ternary-Bonsai-2-27B-PQ2_0.gguf");
        assert!(projector_definition(binary).is_some());
        assert!(projector_definition(compact_ternary).is_some());
        assert!(projector_definition(model_definition("bonsai-8b-q1").unwrap()).is_none());
    }

    #[test]
    fn runtime_archive_name_and_version_match() {
        assert!(RUNTIME_VERSION.starts_with("prism-b"));
    }
}
