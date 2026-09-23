use quick_xml::{escape::unescape, events::Event, Reader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS: usize = 4_000_000;
const CHUNK_CHARACTERS: usize = 1_400;
const CHUNK_OVERLAP: usize = 220;
const MAX_DOCUMENTS_PER_QUERY: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRagDocumentRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRagDocumentsRequest {
    document_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRagDocumentRequest {
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRagDocumentsRequest {
    query: String,
    document_ids: Vec<String>,
    limit: Option<usize>,
    max_characters: Option<usize>,
    whole_if_fits: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagDocumentSummary {
    id: String,
    name: String,
    mime: String,
    size: u64,
    chunk_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchHit {
    document_id: String,
    document_name: String,
    chunk_id: String,
    ordinal: usize,
    text: String,
    excerpt: String,
    score: f64,
    chunk_count: usize,
    full_document: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RagChunk {
    id: String,
    ordinal: usize,
    text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredRagDocument {
    schema_version: u32,
    id: String,
    name: String,
    mime: String,
    size: u64,
    chunks: Vec<RagChunk>,
    #[serde(default)]
    full_text: Option<String>,
}

impl StoredRagDocument {
    fn text(&self) -> String {
        self.full_text
            .clone()
            .unwrap_or_else(|| stitch_chunks(&self.chunks))
    }
}

// Version 1 indexes stored only overlapping chunks. Rebuild their readable text
// without repeating the shared boundary; new indexes retain the exact text.
fn stitch_chunks(chunks: &[RagChunk]) -> String {
    let mut result = String::new();
    for chunk in chunks {
        if result.is_empty() {
            result.push_str(&chunk.text);
            continue;
        }
        let previous = result.chars().collect::<Vec<_>>();
        let next = chunk.text.chars().collect::<Vec<_>>();
        let overlap = (1..=previous.len().min(next.len()).min(CHUNK_OVERLAP))
            .rev()
            .find(|length| previous[previous.len() - length..] == next[..*length])
            .unwrap_or(0);
        if overlap == 0 && !result.ends_with(char::is_whitespace) {
            result.push(' ');
        }
        result.extend(next[overlap..].iter());
    }
    result
}

impl StoredRagDocument {
    fn summary(&self) -> RagDocumentSummary {
        RagDocumentSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            mime: self.mime.clone(),
            size: self.size,
            chunk_count: self.chunks.len(),
        }
    }
}

fn rag_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("rag").join("documents"))
        .map_err(|error| format!("Could not locate local RAG storage: {error}"))
}

fn validate_document_id(id: &str) -> Result<(), String> {
    if id.len() == 64 && id.bytes().all(|value| value.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Invalid RAG document id".into())
    }
}

fn document_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_document_id(id)?;
    Ok(root.join(format!("{id}.json")))
}

fn normalize_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut blank_line = false;
    for line in value.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if !blank_line && !output.is_empty() {
                output.push_str("\n\n");
            }
            blank_line = true;
        } else {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&line);
            blank_line = false;
        }
    }
    output.trim().to_owned()
}

fn chunk_text(value: &str) -> Vec<RagChunk> {
    let characters = value.chars().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < characters.len() {
        let target_end = (start + CHUNK_CHARACTERS).min(characters.len());
        let minimum_end = (start + CHUNK_CHARACTERS / 2).min(target_end);
        let mut end = target_end;
        if target_end < characters.len() {
            if let Some(boundary) = (minimum_end..target_end)
                .rev()
                .find(|index| characters[*index].is_whitespace())
            {
                end = boundary;
            }
        }
        let text = characters[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_owned();
        if !text.is_empty() {
            let ordinal = chunks.len() + 1;
            chunks.push(RagChunk {
                id: format!("chunk-{ordinal}"),
                ordinal,
                text,
            });
        }
        if end >= characters.len() {
            break;
        }
        let next = end.saturating_sub(CHUNK_OVERLAP);
        start = if next > start { next } else { end };
    }
    chunks
}

fn extract_docx(bytes: &[u8]) -> Result<String, String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Could not open DOCX container: {error}"))?;
    let mut document = archive
        .by_name("word/document.xml")
        .map_err(|error| format!("DOCX has no main document: {error}"))?;
    if document.size() > (MAX_EXTRACTED_CHARS * 4) as u64 {
        return Err("DOCX text is too large to index safely".into());
    }
    let mut xml = String::new();
    document
        .read_to_string(&mut xml)
        .map_err(|error| format!("Could not read DOCX text: {error}"))?;
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);
    let mut output = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(value)) => {
                let decoded = value
                    .decode()
                    .map_err(|error| format!("Could not decode DOCX text: {error}"))?;
                output.push_str(
                    &unescape(&decoded)
                        .map_err(|error| format!("Could not unescape DOCX text: {error}"))?,
                );
            }
            Ok(Event::Empty(value)) if value.name().as_ref() == b"w:tab" => output.push('\t'),
            Ok(Event::End(value)) if value.name().as_ref() == b"w:p" => output.push('\n'),
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("Could not parse DOCX XML: {error}")),
            _ => {}
        }
    }
    Ok(output)
}

fn extract_document(bytes: &[u8], extension: &str) -> Result<(String, &'static str), String> {
    match extension {
        "pdf" => std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes))
            .map_err(|_| "PDF text extraction failed".to_string())?
            .map(|text| (text, "application/pdf"))
            .map_err(|error| format!("Could not extract PDF text: {error}")),
        "docx" => extract_docx(bytes).map(|text| {
            (
                text,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        }),
        "txt" => String::from_utf8(bytes.to_vec())
            .map(|text| (text, "text/plain"))
            .map_err(|error| format!("Text document must be UTF-8: {error}")),
        "md" | "markdown" => String::from_utf8(bytes.to_vec())
            .map(|text| (text, "text/markdown"))
            .map_err(|error| format!("Markdown document must be UTF-8: {error}")),
        "csv" => String::from_utf8(bytes.to_vec())
            .map(|text| (text, "text/csv"))
            .map_err(|error| format!("CSV document must be UTF-8: {error}")),
        "json" => String::from_utf8(bytes.to_vec())
            .map(|text| (text, "application/json"))
            .map_err(|error| format!("JSON document must be UTF-8: {error}")),
        _ => Err("RAG supports PDF, DOCX, TXT, Markdown, CSV and JSON".into()),
    }
}

fn tokenize(value: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "the",
        "and",
        "for",
        "that",
        "with",
        "this",
        "from",
        "what",
        "как",
        "что",
        "это",
        "для",
        "или",
        "при",
        "его",
        "она",
        "они",
        "где",
        "когда",
        "который",
    ];
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter_map(|word| {
            let word = word.to_lowercase();
            (word.chars().count() >= 2 && !STOP_WORDS.contains(&word.as_str())).then_some(word)
        })
        .collect()
}

fn excerpt(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    normalized.chars().take(260).collect()
}

fn full_document_hits(
    documents: &[StoredRagDocument],
    limit: usize,
    max_characters: usize,
) -> Option<Vec<RagSearchHit>> {
    let texts = documents
        .iter()
        .map(StoredRagDocument::text)
        .collect::<Vec<_>>();
    let total = texts.iter().map(|text| text.chars().count()).sum::<usize>();
    if total > max_characters || documents.len() > limit {
        return None;
    }
    Some(
        documents
            .iter()
            .zip(texts)
            .map(|(document, text)| RagSearchHit {
                document_id: document.id.clone(),
                document_name: document.name.clone(),
                chunk_id: "full-document".into(),
                ordinal: 0,
                excerpt: excerpt(&text),
                text,
                score: 0.0,
                chunk_count: document.chunks.len(),
                full_document: true,
            })
            .collect(),
    )
}

fn chunk_hit(document: &StoredRagDocument, chunk: &RagChunk, score: f64) -> RagSearchHit {
    RagSearchHit {
        document_id: document.id.clone(),
        document_name: document.name.clone(),
        chunk_id: chunk.id.clone(),
        ordinal: chunk.ordinal,
        text: chunk.text.clone(),
        excerpt: excerpt(&chunk.text),
        score,
        chunk_count: document.chunks.len(),
        full_document: false,
    }
}

fn edge_window(text: &str, from_end: bool, characters: usize) -> String {
    if from_end {
        text.chars()
            .rev()
            .take(characters)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        text.chars().take(characters).collect()
    }
}

fn coverage_hits(
    query: &str,
    document: &StoredRagDocument,
    limit: usize,
    max_characters: usize,
) -> Option<Vec<RagSearchHit>> {
    let words = tokenize(query);
    let start = words.iter().any(|word| {
        word.starts_with("начал")
            || word.starts_with("перв")
            || matches!(word.as_str(), "first" | "beginning" | "start" | "opening")
    });
    let end = words.iter().any(|word| {
        word.starts_with("конц")
            || word.starts_with("послед")
            || matches!(
                word.as_str(),
                "last" | "end" | "ending" | "final" | "closing"
            )
    });
    let document_question = words.iter().any(|word| {
        word.starts_with("документ")
            || word.starts_with("файл")
            || matches!(word.as_str(), "pdf" | "document" | "file")
    });
    let whole = document_question
        && words.iter().any(|word| {
            word.starts_with("весь")
                || word.starts_with("целик")
                || word.starts_with("полност")
                || word.starts_with("суммир")
                || matches!(word.as_str(), "whole" | "entire" | "summarize" | "summary")
        });
    if !((start && end) || whole) || document.chunks.is_empty() {
        return None;
    }

    let last = document.chunks.len() - 1;
    let mut priorities = vec![0];
    if last > 0 {
        priorities.push(last);
    }
    if whole && limit > priorities.len() {
        let count = limit.min(document.chunks.len());
        for position in 0..count {
            let index = position * last / (count - 1).max(1);
            if !priorities.contains(&index) {
                priorities.push(index);
            }
        }
    }

    let mut used = 0;
    let mut hits = Vec::new();
    for index in priorities {
        if hits.len() >= limit {
            break;
        }
        let chunk = &document.chunks[index];
        let mut hit = chunk_hit(document, chunk, 0.0);
        if !whole && last > 0 {
            hit.text = edge_window(&chunk.text, index == last, 640);
            hit.excerpt = hit.text.clone();
        }
        let length = hit.text.chars().count();
        if !hits.is_empty() && used + length > max_characters {
            continue;
        }
        used += length;
        hits.push(hit);
    }
    hits.sort_by_key(|hit| hit.ordinal);
    Some(hits)
}

async fn load_document(root: &Path, id: &str) -> Result<StoredRagDocument, String> {
    let path = document_path(root, id)?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read indexed document: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not decode indexed document: {error}"))
}

#[tauri::command]
pub async fn import_rag_document(
    app: AppHandle,
    request: ImportRagDocumentRequest,
) -> Result<RagDocumentSummary, String> {
    let path = PathBuf::from(&request.path);
    if !path.is_file() {
        return Err("RAG document must be an existing file".into());
    }
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect RAG document: {error}"))?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err("RAG documents are limited to 20 MB".into());
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document")
        .to_owned();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read RAG document: {error}"))?;
    let id = format!("{:x}", Sha256::digest(&bytes));
    let root = rag_root(&app)?;
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|error| format!("Could not create local RAG storage: {error}"))?;
    let destination = document_path(&root, &id)?;
    if destination.is_file() {
        return Ok(load_document(&root, &id).await?.summary());
    }
    let (text, mime) =
        tauri::async_runtime::spawn_blocking(move || extract_document(&bytes, &extension))
            .await
            .map_err(|error| format!("Document extraction task failed: {error}"))??;
    let text = normalize_text(&text);
    if text.is_empty() {
        return Err("The document contains no extractable text; scanned PDFs need OCR".into());
    }
    if text.chars().count() > MAX_EXTRACTED_CHARS {
        return Err("Extracted document text is limited to 4 million characters".into());
    }
    let chunks = chunk_text(&text);
    let document = StoredRagDocument {
        schema_version: 2,
        id: id.clone(),
        name,
        mime: mime.into(),
        size: metadata.len(),
        chunks,
        full_text: Some(text),
    };
    let encoded = serde_json::to_vec(&document)
        .map_err(|error| format!("Could not encode RAG index: {error}"))?;
    let temporary = destination.with_extension("json.part");
    tokio::fs::write(&temporary, encoded)
        .await
        .map_err(|error| format!("Could not save RAG index: {error}"))?;
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(|error| format!("Could not finalize RAG index: {error}"))?;
    Ok(document.summary())
}

#[tauri::command]
pub async fn list_rag_documents(
    app: AppHandle,
    request: ListRagDocumentsRequest,
) -> Result<Vec<RagDocumentSummary>, String> {
    if request.document_ids.len() > MAX_DOCUMENTS_PER_QUERY {
        return Err(format!(
            "A chat can use up to {MAX_DOCUMENTS_PER_QUERY} RAG documents"
        ));
    }
    let root = rag_root(&app)?;
    let mut documents = Vec::new();
    for id in request.document_ids {
        let path = document_path(&root, &id)?;
        if path.is_file() {
            documents.push(load_document(&root, &id).await?.summary());
        }
    }
    Ok(documents)
}

#[tauri::command]
pub async fn remove_rag_document(
    app: AppHandle,
    request: RemoveRagDocumentRequest,
) -> Result<(), String> {
    let path = document_path(&rag_root(&app)?, &request.document_id)?;
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete local document: {error}")),
    }
}

#[tauri::command]
pub async fn search_rag_documents(
    app: AppHandle,
    request: SearchRagDocumentsRequest,
) -> Result<Vec<RagSearchHit>, String> {
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 2_000 {
        return Err("RAG query must contain between 1 and 2000 characters".into());
    }
    if request.document_ids.is_empty() {
        return Ok(Vec::new());
    }
    if request.document_ids.len() > MAX_DOCUMENTS_PER_QUERY {
        return Err(format!(
            "A chat can use up to {MAX_DOCUMENTS_PER_QUERY} RAG documents"
        ));
    }
    let limit = request.limit.unwrap_or(5).clamp(1, 8);
    let max_characters = request.max_characters.unwrap_or(7_000).clamp(3_000, 12_000);
    let root = rag_root(&app)?;
    let mut documents = Vec::new();
    for id in request.document_ids {
        documents.push(load_document(&root, &id).await?);
    }
    if request.whole_if_fits.unwrap_or(true) {
        if let Some(hits) = full_document_hits(&documents, limit, max_characters) {
            return Ok(hits);
        }
    }
    if documents.len() == 1 {
        if let Some(hits) = coverage_hits(query, &documents[0], limit, max_characters) {
            return Ok(hits);
        }
    }
    let query_tokens = tokenize(query);
    let chunks = documents
        .iter()
        .flat_map(|document| document.chunks.iter().map(move |chunk| (document, chunk)))
        .collect::<Vec<_>>();
    if chunks.is_empty() {
        return Ok(Vec::new());
    }
    let tokenized = chunks
        .iter()
        .map(|(_, chunk)| tokenize(&chunk.text))
        .collect::<Vec<_>>();
    let average_length =
        tokenized.iter().map(Vec::len).sum::<usize>() as f64 / tokenized.len() as f64;
    let unique_query = query_tokens.iter().cloned().collect::<HashSet<_>>();
    let mut document_frequency = HashMap::new();
    for term in &unique_query {
        let frequency = tokenized
            .iter()
            .filter(|tokens| tokens.iter().any(|token| token == term))
            .count();
        document_frequency.insert(term.clone(), frequency);
    }
    let normalized_query = query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let mut scored = chunks
        .iter()
        .zip(tokenized.iter())
        .map(|((document, chunk), tokens)| {
            let counts = tokens.iter().fold(HashMap::new(), |mut counts, token| {
                *counts.entry(token).or_insert(0usize) += 1;
                counts
            });
            let mut score = 0.0;
            for term in &unique_query {
                let frequency = *counts.get(term).unwrap_or(&0) as f64;
                if frequency == 0.0 {
                    continue;
                }
                let df = *document_frequency.get(term).unwrap_or(&0) as f64;
                let idf = ((chunks.len() as f64 - df + 0.5) / (df + 0.5) + 1.0).ln();
                let denominator = frequency
                    + 1.2 * (1.0 - 0.75 + 0.75 * tokens.len() as f64 / average_length.max(1.0));
                score += idf * (frequency * 2.2 / denominator);
            }
            if normalized_query.chars().count() >= 8
                && chunk.text.to_lowercase().contains(&normalized_query)
            {
                score += 3.0;
            }
            (*document, *chunk, score)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| right.2.partial_cmp(&left.2).unwrap_or(Ordering::Equal));
    if scored.first().is_some_and(|value| value.2 <= 0.0) {
        scored.sort_by_key(|(document, chunk, _)| (document.name.clone(), chunk.ordinal));
    }
    let mut used_characters = 0;
    let mut hits = Vec::new();
    for (document, chunk, score) in scored {
        if hits.len() >= limit {
            break;
        }
        let length = chunk.text.chars().count();
        if !hits.is_empty() && used_characters + length > max_characters {
            continue;
        }
        used_characters += length;
        hits.push(chunk_hit(document, chunk, score));
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn chunks_long_unicode_text_with_overlap() {
        let text = "абзац ".repeat(600);
        let chunks = chunk_text(&text);
        assert!(chunks.len() > 2);
        assert!(chunks.iter().all(|chunk| !chunk.text.is_empty()));
        assert_eq!(chunks[0].ordinal, 1);
    }

    #[test]
    fn version_one_chunks_can_be_read_without_duplicate_overlap() {
        let text = "Первый абзац с фактами. ".repeat(150);
        let chunks = chunk_text(&text);
        let stitched = stitch_chunks(&chunks);
        assert!(chunks.len() > 2);
        assert_eq!(stitched, text.trim());
    }

    #[test]
    fn four_chunk_document_is_sent_as_one_when_it_fits() {
        let text = "Предложение с данными. ".repeat(170);
        let document = StoredRagDocument {
            schema_version: 2,
            id: "a".into(),
            name: "guide.pdf".into(),
            mime: "application/pdf".into(),
            size: 1024,
            chunks: chunk_text(&text),
            full_text: Some(text.clone()),
        };
        assert!(document.chunks.len() >= 3);
        let hits = full_document_hits(std::slice::from_ref(&document), 5, 9_000).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].full_document);
        assert_eq!(hits[0].text, text);
        assert!(full_document_hits(&[document], 5, 3_000).is_none());
    }

    #[test]
    fn boundary_question_keeps_both_ends_when_full_text_does_not_fit() {
        let text = format!(
            "TOPAZ-311 begins the file. {} OPAL-722 ends the file.",
            "Long local document with repeated neutral details. ".repeat(250)
        );
        let document = StoredRagDocument {
            schema_version: 2,
            id: "a".into(),
            name: "guide.pdf".into(),
            mime: "application/pdf".into(),
            size: 1024,
            chunks: chunk_text(&text),
            full_text: Some(text),
        };
        let hits =
            coverage_hits("Назови маркеры в начале и конце PDF", &document, 5, 9_000).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].ordinal, 1);
        assert_eq!(hits[1].ordinal, document.chunks.len());
        assert!(hits[0].text.contains("TOPAZ-311"));
        assert!(hits[1].text.contains("OPAL-722"));
        assert!(hits.iter().all(|hit| hit.text.chars().count() <= 640));
        let english = coverage_hits(
            "What are the opening and closing markers of the document?",
            &document,
            5,
            9_000,
        )
        .unwrap();
        assert_eq!(
            english.iter().map(|hit| hit.ordinal).collect::<Vec<_>>(),
            vec![1, document.chunks.len()]
        );
    }

    #[test]
    fn whole_document_question_samples_middle_and_both_ends() {
        let text = "Long local document with repeated neutral details. ".repeat(250);
        let document = StoredRagDocument {
            schema_version: 2,
            id: "a".into(),
            name: "guide.pdf".into(),
            mime: "application/pdf".into(),
            size: 1024,
            chunks: chunk_text(&text),
            full_text: Some(text),
        };
        let hits = coverage_hits("Summarize the whole document", &document, 5, 9_000).unwrap();
        assert_eq!(hits.len(), 5);
        assert_eq!(hits.first().unwrap().ordinal, 1);
        assert_eq!(hits.last().unwrap().ordinal, document.chunks.len());
        assert!(hits
            .iter()
            .any(|hit| hit.ordinal > 1 && hit.ordinal < document.chunks.len()));
    }

    #[test]
    fn tokenization_is_unicode_aware_and_removes_stop_words() {
        assert_eq!(
            tokenize("Что такое локальный RAG и private search?"),
            vec!["такое", "локальный", "rag", "private", "search"]
        );
    }

    #[test]
    fn extracts_text_from_docx_container() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Первый</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>"#;
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(xml.as_bytes()).unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        let text = extract_docx(&bytes).unwrap();
        assert_eq!(normalize_text(&text), "Первый\nSecond");
    }
}
