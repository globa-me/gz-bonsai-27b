use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_EVENTS: usize = 500;
const ALLOWED_LAYERS: &[&str] = &[
    "frontend",
    "chat",
    "search",
    "rag",
    "installer",
    "runtime",
    "storage",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticEvent {
    timestamp_ms: u64,
    layer: String,
    level: String,
    event: String,
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRequest {
    layer: String,
    level: String,
    event: String,
    detail: Option<String>,
}

#[derive(Default)]
pub struct DiagnosticsState {
    events: Mutex<VecDeque<DiagnosticEvent>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn clean_field(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n' || *character == '\t')
        .take(max_chars)
        .collect::<String>()
}

pub fn redact(value: &str) -> String {
    let mut redacted = value.to_owned();
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            redacted = redacted.replace(&home, "<home>");
        }
    }
    for marker in ["X-Subscription-Token:", "x-subscription-token:", "Bearer "] {
        let mut cursor = 0;
        while let Some(offset) = redacted[cursor..].find(marker) {
            let start = cursor + offset;
            let value_start = start + marker.len();
            let leading_space = redacted[value_start..]
                .chars()
                .take_while(|character| character.is_whitespace())
                .map(char::len_utf8)
                .sum::<usize>();
            let secret_start = value_start + leading_space;
            let secret_end = redacted[secret_start..]
                .find(|character: char| character.is_whitespace())
                .map(|offset| secret_start + offset)
                .unwrap_or(redacted.len());
            redacted.replace_range(secret_start..secret_end, "<redacted>");
            cursor = secret_start + "<redacted>".len();
        }
    }
    clean_field(&redacted, 2_000)
}

pub fn push(app: &AppHandle, layer: &str, level: &str, event: &str, detail: Option<String>) {
    let entry = DiagnosticEvent {
        timestamp_ms: now_ms(),
        layer: clean_field(layer, 24),
        level: clean_field(level, 12),
        event: clean_field(event, 64),
        detail: detail.map(|value| redact(&value)),
    };
    let state = app.state::<DiagnosticsState>();
    if let Ok(mut events) = state.events.lock() {
        if events.len() >= MAX_EVENTS {
            events.pop_front();
        }
        events.push_back(entry.clone());
    }
    let _ = app.emit("diagnostic-event", entry);
}

#[tauri::command]
pub fn record_diagnostic(app: AppHandle, request: DiagnosticRequest) -> Result<(), String> {
    if !ALLOWED_LAYERS.contains(&request.layer.as_str()) {
        return Err("Unsupported diagnostic layer".into());
    }
    if !matches!(request.level.as_str(), "debug" | "info" | "warn" | "error") {
        return Err("Unsupported diagnostic level".into());
    }
    if request.event.trim().is_empty() {
        return Err("Diagnostic event is empty".into());
    }
    push(
        &app,
        &request.layer,
        &request.level,
        &request.event,
        request.detail,
    );
    Ok(())
}

#[tauri::command]
pub fn diagnostic_snapshot(state: State<'_, DiagnosticsState>) -> Vec<DiagnosticEvent> {
    state
        .events
        .lock()
        .map(|events| events.iter().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn clear_diagnostics(state: State<'_, DiagnosticsState>) {
    if let Ok(mut events) = state.events.lock() {
        events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_home_and_authentication_values() {
        let home = std::env::var("HOME").unwrap_or_default();
        let input = format!(
            "model={home}/Models/a.gguf X-Subscription-Token: secret-value Bearer another-secret"
        );
        let output = redact(&input);
        assert!(!home.is_empty());
        assert!(!output.contains(&home));
        assert!(!output.contains("secret-value"));
        assert!(!output.contains("another-secret"));
        assert!(output.contains("<home>"));
    }
}
