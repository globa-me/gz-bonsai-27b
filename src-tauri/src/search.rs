use crate::diagnostics;
use futures_util::StreamExt;
use keyring::{Entry, Error as KeyringError};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, net::IpAddr, time::Duration};
use tauri::{AppHandle, State};

const BRAVE_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";
const KEYCHAIN_SERVICE: &str = "com.bonsai.desktop.brave-search";
const KEYCHAIN_ACCOUNT: &str = "api-key";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub struct SearchState {
    client: Client,
}

impl SearchState {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSearchKeyRequest {
    api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    query: String,
    limit: Option<usize>,
    locale: Option<String>,
    country: Option<String>,
    timezone: Option<String>,
    freshness: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProviderStatus {
    provider: &'static str,
    brave_configured: bool,
    keyless_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    title: String,
    url: String,
    snippet: String,
    provider: &'static str,
    age: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BraveResponse {
    web: Option<BraveWeb>,
}

#[derive(Debug, Deserialize)]
struct BraveWeb {
    #[serde(default)]
    results: Vec<BraveResult>,
}

#[derive(Debug, Deserialize)]
struct BraveResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    description: String,
    family_friendly: Option<bool>,
    page_age: Option<String>,
    age: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TavilyResponse {
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Debug, Deserialize)]
struct TavilyResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    content: String,
    published_date: Option<String>,
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))
}

fn load_api_key() -> Result<Option<String>, String> {
    match keychain_entry()?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!("SEARCH_KEYCHAIN_ERROR: {error}")),
    }
}

fn validate_key_shape(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if !(20..=512).contains(&value.len()) || value.chars().any(char::is_whitespace) {
        return Err("SEARCH_INVALID_KEY: The Brave API key format is invalid".into());
    }
    Ok(value)
}

fn clean_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn unsafe_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }
    if let Ok(address) = host.parse::<IpAddr>() {
        return match address {
            IpAddr::V4(value) => {
                value.is_private()
                    || value.is_loopback()
                    || value.is_link_local()
                    || value.is_unspecified()
            }
            IpAddr::V6(value) => {
                value.is_loopback() || value.is_unspecified() || value.is_unique_local()
            }
        };
    }
    [
        "porn", "xxx", "xhamster", "xnxx", "xvideos", "redtube", "pornhub", "bokep", "hentai",
    ]
    .iter()
    .any(|token| host.contains(token))
}

fn safe_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || unsafe_host(url.host_str()?)
    {
        return None;
    }
    Some(url)
}

fn sanitize_results(
    entries: impl IntoIterator<Item = (String, String, String, Option<String>)>,
    provider: &'static str,
    limit: usize,
) -> Result<Vec<WebSearchResult>, String> {
    let mut seen = HashSet::new();
    let results = entries
        .into_iter()
        .filter_map(|(raw_title, raw_url, raw_snippet, age)| {
            let mut url = safe_url(&raw_url)?;
            url.set_fragment(None);
            let normalized = url.as_str().trim_end_matches('/').to_owned();
            if !seen.insert(normalized) {
                return None;
            }
            let title = clean_text(&raw_title, 240);
            let snippet = clean_text(&raw_snippet, 1_000);
            if title.is_empty() || snippet.is_empty() {
                return None;
            }
            Some(WebSearchResult {
                title,
                url: url.to_string(),
                snippet,
                provider,
                age: age.map(|value| clean_text(&value, 80)),
            })
        })
        .take(limit)
        .collect::<Vec<_>>();
    if results.is_empty() {
        return Err(format!(
            "SEARCH_NO_RESULTS: {provider} returned no safe relevant sources"
        ));
    }
    Ok(results)
}

fn parse_brave_results(body: &[u8], limit: usize) -> Result<Vec<WebSearchResult>, String> {
    let response: BraveResponse = serde_json::from_slice(body)
        .map_err(|_| "SEARCH_BAD_RESPONSE: Brave returned an unreadable response".to_string())?;
    sanitize_results(
        response
            .web
            .map(|web| web.results)
            .unwrap_or_default()
            .into_iter()
            .filter(|result| result.family_friendly != Some(false))
            .map(|result| {
                (
                    result.title,
                    result.url,
                    result.description,
                    result.page_age.or(result.age),
                )
            }),
        "brave",
        limit,
    )
}

fn parse_tavily_results(body: &[u8], limit: usize) -> Result<Vec<WebSearchResult>, String> {
    let response: TavilyResponse = serde_json::from_slice(body)
        .map_err(|_| "SEARCH_BAD_RESPONSE: Tavily returned an unreadable response".to_string())?;
    sanitize_results(
        response.results.into_iter().map(|result| {
            (
                result.title,
                result.url,
                result.content,
                result.published_date,
            )
        }),
        "tavily",
        limit,
    )
}

fn locale_parameters(locale: Option<&str>) -> (&'static str, &'static str) {
    if locale
        .unwrap_or_default()
        .to_ascii_lowercase()
        .starts_with("ru")
    {
        ("ru", "ru-RU")
    } else {
        ("en", "en-US")
    }
}

fn valid_country(value: Option<&str>) -> Option<String> {
    let value = value?.trim().to_ascii_uppercase();
    (value.len() == 2
        && value
            .chars()
            .all(|character| character.is_ascii_alphabetic()))
    .then_some(value)
}

fn valid_timezone(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    (!value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/_+-".contains(character)))
    .then_some(value)
}

fn valid_freshness(value: Option<&str>) -> Option<&str> {
    value.filter(|value| matches!(*value, "pd" | "pw" | "pm" | "py"))
}

async fn request_brave(
    client: &Client,
    api_key: &str,
    request: &WebSearchRequest,
    count: usize,
) -> Result<Vec<u8>, String> {
    let (search_lang, ui_lang) = locale_parameters(request.locale.as_deref());
    let mut query = vec![
        ("q", request.query.trim().to_owned()),
        ("count", count.to_string()),
        ("country", "ALL".into()),
        ("search_lang", search_lang.into()),
        ("ui_lang", ui_lang.into()),
        ("safesearch", "strict".into()),
        ("spellcheck", "true".into()),
        ("result_filter", "web".into()),
    ];
    if let Some(freshness) = valid_freshness(request.freshness.as_deref()) {
        query.push(("freshness", freshness.into()));
    }
    let mut builder = client
        .get(BRAVE_ENDPOINT)
        .header("X-Subscription-Token", api_key)
        .header("Accept", "application/json")
        .query(&query)
        .timeout(Duration::from_secs(12));
    if let Some(country) = valid_country(request.country.as_deref()) {
        builder = builder.header("X-Loc-Country", country);
    }
    if let Some(timezone) = valid_timezone(request.timezone.as_deref()) {
        builder = builder.header("X-Loc-Timezone", timezone);
    }
    let response = builder.send().await.map_err(|error| {
        if error.is_timeout() {
            "SEARCH_TIMEOUT: Brave did not respond in time".to_string()
        } else {
            "SEARCH_UNAVAILABLE: Could not reach Brave Search".to_string()
        }
    })?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err("SEARCH_AUTH: The Brave API key was rejected".into())
        }
        StatusCode::TOO_MANY_REQUESTS => {
            return Err("SEARCH_QUOTA: The Brave API quota or rate limit was reached".into())
        }
        status if status.is_server_error() => {
            return Err("SEARCH_UNAVAILABLE: Brave Search is temporarily unavailable".into())
        }
        status if !status.is_success() => {
            return Err(format!("SEARCH_HTTP: Brave Search returned HTTP {status}"))
        }
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("SEARCH_BAD_RESPONSE: Brave response was too large".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "SEARCH_BAD_RESPONSE: Could not read Brave response")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("SEARCH_BAD_RESPONSE: Brave response was too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_limited_response(
    response: reqwest::Response,
    provider: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "SEARCH_BAD_RESPONSE: {provider} response was too large"
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| format!("SEARCH_BAD_RESPONSE: Could not read {provider} response"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(format!(
                "SEARCH_BAD_RESPONSE: {provider} response was too large"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn request_tavily(
    client: &Client,
    request: &WebSearchRequest,
    count: usize,
) -> Result<Vec<u8>, String> {
    let time_range = valid_freshness(request.freshness.as_deref()).map(|value| match value {
        "pd" => "day",
        "pw" => "week",
        "pm" => "month",
        _ => "year",
    });
    let mut payload = serde_json::json!({
        "query": request.query.trim(),
        "search_depth": "basic",
        "max_results": count,
        "safe_search": true,
        "include_answer": false,
        "include_raw_content": false,
        "include_published_date": true,
    });
    if let Some(value) = time_range {
        payload["time_range"] = serde_json::Value::String(value.into());
    }
    let response = client
        .post(TAVILY_ENDPOINT)
        .header("X-Tavily-Access-Mode", "keyless")
        .header("Accept", "application/json")
        .json(&payload)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "SEARCH_TIMEOUT: Tavily did not respond in time".to_string()
            } else {
                "SEARCH_UNAVAILABLE: Could not reach Tavily Search".to_string()
            }
        })?;
    match response.status() {
        StatusCode::TOO_MANY_REQUESTS => {
            return Err("SEARCH_QUOTA: Tavily Keyless rate limit was reached".into())
        }
        status if status.is_server_error() => {
            return Err("SEARCH_UNAVAILABLE: Tavily Search is temporarily unavailable".into())
        }
        status if !status.is_success() => {
            return Err(format!("SEARCH_HTTP: Tavily Search returned HTTP {status}"))
        }
        _ => {}
    }
    read_limited_response(response, "Tavily").await
}

#[tauri::command]
pub async fn search_provider_status() -> Result<SearchProviderStatus, String> {
    let configured = tauri::async_runtime::spawn_blocking(load_api_key)
        .await
        .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))??
        .is_some();
    Ok(SearchProviderStatus {
        provider: if configured { "brave" } else { "tavily" },
        brave_configured: configured,
        keyless_available: true,
    })
}

#[tauri::command]
pub async fn save_brave_api_key(
    app: AppHandle,
    state: State<'_, SearchState>,
    request: SaveSearchKeyRequest,
) -> Result<SearchProviderStatus, String> {
    let api_key = validate_key_shape(&request.api_key)?.to_owned();
    let validation_request = WebSearchRequest {
        query: "Bonsai local AI".into(),
        limit: Some(1),
        locale: Some("en".into()),
        country: None,
        timezone: None,
        freshness: None,
    };
    diagnostics::push(&app, "search", "info", "key_validation_started", None);
    let body = request_brave(&state.client, &api_key, &validation_request, 1).await?;
    parse_brave_results(&body, 1)?;
    tauri::async_runtime::spawn_blocking(move || {
        keychain_entry()?
            .set_password(&api_key)
            .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))
    })
    .await
    .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))??;
    diagnostics::push(&app, "search", "info", "key_validation_succeeded", None);
    Ok(SearchProviderStatus {
        provider: "brave",
        brave_configured: true,
        keyless_available: true,
    })
}

#[tauri::command]
pub async fn delete_brave_api_key(app: AppHandle) -> Result<SearchProviderStatus, String> {
    tauri::async_runtime::spawn_blocking(|| match keychain_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("SEARCH_KEYCHAIN_ERROR: {error}")),
    })
    .await
    .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))??;
    diagnostics::push(&app, "search", "info", "key_removed", None);
    Ok(SearchProviderStatus {
        provider: "tavily",
        brave_configured: false,
        keyless_available: true,
    })
}

#[tauri::command]
pub async fn web_search(
    app: AppHandle,
    state: State<'_, SearchState>,
    request: WebSearchRequest,
) -> Result<Vec<WebSearchResult>, String> {
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 400 || query.split_whitespace().count() > 50 {
        return Err(
            "SEARCH_INVALID_QUERY: Search query must contain 1–400 characters and at most 50 words"
                .into(),
        );
    }
    let limit = request.limit.unwrap_or(5).clamp(1, 5);
    let request_count = (limit * 2).clamp(5, 10);
    let api_key = tauri::async_runtime::spawn_blocking(load_api_key)
        .await
        .map_err(|error| format!("SEARCH_KEYCHAIN_ERROR: {error}"))??;
    let provider = if api_key.is_some() { "brave" } else { "tavily" };
    diagnostics::push(
        &app,
        "search",
        "info",
        "request_started",
        Some(format!(
            "provider={provider} query_chars={} limit={limit} safesearch=strict freshness={}",
            query.chars().count(),
            request.freshness.as_deref().unwrap_or("none")
        )),
    );
    let started = std::time::Instant::now();
    let response = if let Some(api_key) = api_key.as_deref() {
        request_brave(&state.client, api_key, &request, request_count).await
    } else {
        request_tavily(&state.client, &request, request_count).await
    };
    let body = match response {
        Ok(body) => body,
        Err(error) => {
            diagnostics::push(
                &app,
                "search",
                "error",
                "request_failed",
                Some(format!(
                    "elapsed_ms={} code={}",
                    started.elapsed().as_millis(),
                    error.split(':').next().unwrap_or("SEARCH_ERROR")
                )),
            );
            return Err(error);
        }
    };
    let results = if provider == "brave" {
        parse_brave_results(&body, limit)?
    } else {
        parse_tavily_results(&body, limit)?
    };
    diagnostics::push(
        &app,
        "search",
        "info",
        "request_succeeded",
        Some(format!(
            "elapsed_ms={} accepted={}",
            started.elapsed().as_millis(),
            results.len()
        )),
    );
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_filters_and_deduplicates_brave_results() {
        let body = br#"{
          "web": {"results": [
            {"title":"Safe result","url":"https://example.com/news","description":"Useful  context","family_friendly":true,"page_age":"2026-09-21"},
            {"title":"Duplicate","url":"https://example.com/news#fragment","description":"Duplicate context","family_friendly":true},
            {"title":"Adult","url":"https://xhamster.example/post","description":"Bad","family_friendly":true},
            {"title":"Local","url":"https://127.0.0.1/private","description":"Bad","family_friendly":true},
            {"title":"Flagged","url":"https://safe.example/post","description":"Bad","family_friendly":false}
          ]}
        }"#;
        let results = parse_brave_results(body, 5).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Safe result");
        assert_eq!(results[0].provider, "brave");
    }

    #[test]
    fn rejects_empty_safe_result_set() {
        let body = br#"{"web":{"results":[{"title":"Bad","url":"http://example.com","description":"No TLS"}]}}"#;
        assert!(parse_brave_results(body, 5)
            .unwrap_err()
            .starts_with("SEARCH_NO_RESULTS"));
    }

    #[test]
    fn parses_and_filters_tavily_results() {
        let body = br#"{"results":[
          {"title":"Government","url":"https://gov.kz/news","content":"Official update","published_date":"2026-09-20"},
          {"title":"Unsafe","url":"http://example.com","content":"No TLS"}
        ]}"#;
        let results = parse_tavily_results(body, 5).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].provider, "tavily");
        assert_eq!(results[0].age.as_deref(), Some("2026-09-20"));
    }

    #[test]
    fn validates_localization_and_request_options() {
        assert_eq!(locale_parameters(Some("ru-KZ")), ("ru", "ru-RU"));
        assert_eq!(valid_country(Some("kz")).as_deref(), Some("KZ"));
        assert_eq!(valid_timezone(Some("Asia/Almaty")), Some("Asia/Almaty"));
        assert_eq!(valid_freshness(Some("pm")), Some("pm"));
        assert_eq!(valid_freshness(Some("all")), None);
    }

    #[test]
    fn rejects_bad_key_shapes_and_unsafe_urls() {
        assert!(validate_key_shape("short").is_err());
        assert!(safe_url("https://user:secret@example.com").is_none());
        assert!(safe_url("https://192.168.1.2/page").is_none());
        assert!(safe_url("https://example.com:8443/page").is_none());
        assert!(safe_url("https://example.com/page").is_some());
    }
}
