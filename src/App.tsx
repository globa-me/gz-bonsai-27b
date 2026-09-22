import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Locale, translate } from "./i18n";
import appIcon from "./assets/app-icon.png";
import { MarkdownMessage } from "./MarkdownMessage";
import { createChat, loadChats, normalizeChatTitle, renameChatSession, restoreAutoChatTitle, saveChats, type Attachment, type ChatMessage, type ChatSession, type SearchSource } from "./chatStore";
import { summarizeMetrics, type MessageMetrics } from "./chatMetrics";
import { buildRagContext, type RagDocument, type RagSearchHit } from "./rag";
import { resolveRuntimePath } from "./runtimeSelection";
import { inferSearchFreshness, resolveSearchCountry, searchErrorCode } from "./webSearch";
import { classifyDroppedPaths } from "./fileDrop";

type ServerPhase = "stopped" | "starting" | "ready" | "stopping" | "error";
type View = "chat" | "models" | "diagnostics" | "about";

interface ServerStatus {
  phase: ServerPhase;
  port: number;
  detail?: string | null;
  modelName?: string | null;
  contextSize?: number | null;
  memoryBytes?: number | null;
  backend?: string | null;
}

interface TokenEvent {
  requestId: string;
  content: string;
}

interface SystemInfo {
  appVersion: string;
  architecture: string;
  macosVersion: string;
  chip: string;
  memoryBytes: number;
  freeDiskBytes: number;
}

interface CatalogModel {
  id: string;
  name: string;
  description: string;
  filename: string;
  sizeBytes: number;
  estimatedMemoryBytes: number;
  contextSize: number;
  installed: boolean;
  installedPath?: string | null;
  visionCapable?: boolean;
  projectorInstalled?: boolean;
  projectorPath?: string | null;
}

interface ManagedCatalog {
  runtimeVersion: string;
  runtimeInstalled: boolean;
  runtimePath?: string | null;
  models: CatalogModel[];
}

interface DownloadProgress {
  id: string;
  phase: "downloading" | "verifying" | "complete" | "paused" | "cancelled" | "error";
  downloadedBytes: number;
  totalBytes: number;
  detail?: string | null;
}

interface AttachmentPayload {
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text";
  content: string;
}

type WebSearchResult = SearchSource;

interface SearchProviderStatus {
  provider: "brave" | "tavily";
  braveConfigured: boolean;
  keylessAvailable: boolean;
}

interface DiagnosticEvent {
  timestampMs: number;
  layer: "frontend" | "chat" | "search" | "rag" | "installer" | "runtime" | "storage";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  detail?: string | null;
}

const storageKey = "bonsai-desktop-settings-v1";
const isTauri = "__TAURI_INTERNALS__" in window;

const previewCatalog: ManagedCatalog = {
  runtimeVersion: "prism-b10709-9a9394a",
  runtimeInstalled: true,
  runtimePath: "/Applications/GZ Bonsai 27B.app/Contents/Resources/runtime/llama-server",
  models: [
    { id: "bonsai-1.7b-q1", name: "Bonsai 1.7B · Q1_0", description: "", filename: "Bonsai-1.7B-Q1_0.gguf", sizeBytes: 248302272, estimatedMemoryBytes: 8 * 1024 ** 3, contextSize: 4096, installed: false },
    { id: "bonsai-4b-q1", name: "Bonsai 4B · Q1_0", description: "", filename: "Bonsai-4B-Q1_0.gguf", sizeBytes: 572270624, estimatedMemoryBytes: 12 * 1024 ** 3, contextSize: 8192, installed: false },
    { id: "bonsai-8b-q1", name: "Bonsai 8B · Q1_0", description: "", filename: "Bonsai-8B-Q1_0.gguf", sizeBytes: 1158654496, estimatedMemoryBytes: 16 * 1024 ** 3, contextSize: 16384, installed: false },
    { id: "bonsai-27b-q1", name: "Bonsai 27B · 1-bit Q1_0", description: "", filename: "Bonsai-27B-Q1_0.gguf", sizeBytes: 3803452480, estimatedMemoryBytes: 16 * 1024 ** 3, contextSize: 8192, installed: false },
    { id: "bonsai-2-27b-ptq1", name: "Bonsai 2 27B · ternary PTQ1_0", description: "", filename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", sizeBytes: 5946648928, estimatedMemoryBytes: 24 * 1024 ** 3, contextSize: 8192, installed: false },
    { id: "bonsai-2-27b-pq2", name: "Bonsai 2 27B · ternary PQ2_0", description: "", filename: "Ternary-Bonsai-2-27B-PQ2_0.gguf", sizeBytes: 7206168928, estimatedMemoryBytes: 32 * 1024 ** 3, contextSize: 16384, installed: false },
  ],
};

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function initialLocale(): Locale {
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function formatBytes(bytes: number, locale: Locale) {
  if (!bytes) return "—";
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3) + " GB";
}

function formatCount(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatSpeed(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

function formatDuration(milliseconds: number, locale: Locale) {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(milliseconds / 1000)} ${locale === "ru" ? "с" : "s"}`;
}

export default function App() {
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      return {};
    }
  }, []);
  const [locale, setLocale] = useState<Locale>(saved.locale ?? initialLocale());
  const [runtimePath, setRuntimePath] = useState(saved.runtimePath ?? "");
  const [modelPath, setModelPath] = useState(saved.modelPath ?? "");
  const [projectorPath, setProjectorPath] = useState(saved.projectorPath ?? "");
  const [contextSize, setContextSize] = useState(saved.contextSize ?? 8192);
  const [port, setPort] = useState(saved.port ?? 8080);
  const [status, setStatus] = useState<ServerStatus>({ phase: "stopped", port });
  const [logs, setLogs] = useState<string[]>([]);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [editingChatTitle, setEditingChatTitle] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [ragDocuments, setRagDocuments] = useState<RagDocument[]>([]);
  const [ragBusy, setRagBusy] = useState(false);
  const [ragError, setRagError] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchProviderStatus>({ provider: "tavily", braveConfigured: false, keylessAvailable: true });
  const [searchApiKey, setSearchApiKey] = useState("");
  const [searchSettingsBusy, setSearchSettingsBusy] = useState(false);
  const [searchSettingsMessage, setSearchSettingsMessage] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [ephemeralSources, setEphemeralSources] = useState<Record<string, SearchSource[]>>({});
  const [diagnosticEvents, setDiagnosticEvents] = useState<DiagnosticEvent[]>([]);
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [catalog, setCatalog] = useState<ManagedCatalog | null>(null);
  const [activeDownload, setActiveDownload] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const messages = activeChat?.messages ?? [];
  const chatMetrics = useMemo(
    () => summarizeMetrics(messages.map((message) => message.role === "assistant" ? message.metrics : undefined)),
    [messages],
  );
  const activeRagDocumentKey = (activeChat?.ragDocumentIds ?? []).join(",");
  const searchProviderName = searchStatus.provider === "brave" ? "Brave" : "Tavily Keyless";

  function recordDiagnostic(layer: DiagnosticEvent["layer"], level: DiagnosticEvent["level"], event: string, detail?: string) {
    if (!isTauri) {
      setDiagnosticEvents((current) => [...current.slice(-199), { timestampMs: Date.now(), layer, level, event, detail }]);
      return;
    }
    void invoke("record_diagnostic", { request: { layer, level, event, detail: detail ?? null } }).catch(() => undefined);
  }

  function localizedSearchError(error: unknown) {
    const code = searchErrorCode(error);
    if (code === "SEARCH_NOT_CONFIGURED" || code === "SEARCH_AUTH") return t("searchKeyRequired");
    if (code === "SEARCH_QUOTA") return t("searchQuotaError");
    if (code === "SEARCH_TIMEOUT") return t("searchTimeoutError");
    if (code === "SEARCH_NO_RESULTS") return t("searchNoResultsError");
    return t("searchUnavailableError");
  }

  async function refreshCatalog() {
    const next = await invoke<ManagedCatalog>("managed_catalog");
    setCatalog(next);
    if (next.runtimePath) {
      setRuntimePath((current: string) => resolveRuntimePath(
        current,
        modelPath,
        next.runtimePath,
        next.models.map((model) => model.installedPath),
      ));
    }
    return next;
  }

  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ locale, runtimePath, modelPath, projectorPath, contextSize, port }),
    );
    document.documentElement.lang = locale;
  }, [locale, runtimePath, modelPath, projectorPath, contextSize, port]);

  useEffect(() => {
    void loadChats()
      .then((stored) => {
        const initial = stored.length ? stored.map(restoreAutoChatTitle) : [createChat(translate(locale, "untitledChat"))];
        setChats(initial);
        setActiveChatId(initial[0].id);
        recordDiagnostic("storage", "info", "chat_history_loaded", `chats=${initial.length}`);
      })
      .catch(() => {
        const initial = createChat(translate(locale, "untitledChat"));
        setChats([initial]);
        setActiveChatId(initial.id);
        recordDiagnostic("storage", "error", "chat_history_load_failed");
      })
      .finally(() => setHistoryLoaded(true));
  }, []);

  useEffect(() => {
    if (historyLoaded) void saveChats(chats).catch(() => recordDiagnostic("storage", "error", "chat_history_save_failed"));
  }, [chats, historyLoaded]);

  useEffect(() => {
    const documentIds = activeChat?.ragDocumentIds ?? [];
    if (!isTauri || !documentIds.length) {
      setRagDocuments([]);
      return;
    }
    let cancelled = false;
    void invoke<RagDocument[]>("list_rag_documents", { request: { documentIds } })
      .then((documents) => {
        if (!cancelled) setRagDocuments(documents);
      })
      .catch((error) => {
        if (!cancelled) setRagError(String(error));
      });
    return () => { cancelled = true; };
  }, [activeChatId, activeRagDocumentKey]);

  useEffect(() => {
    if (!isTauri) {
      setSystemInfo({ appVersion: "0.5.1", architecture: "aarch64", macosVersion: "26.5", chip: "Apple M3 Pro", memoryBytes: 18 * 1024 ** 3, freeDiskBytes: 115 * 1024 ** 3 });
      setCatalog(previewCatalog);
      setRuntimePath(previewCatalog.runtimePath ?? "");
      return;
    }
    const unlistenLog = listen<string>("server-log", ({ payload }) => {
      setLogs((current) => [...current.slice(-199), payload]);
    });
    const unlistenStatus = listen<ServerStatus>("server-status", ({ payload }) => {
      setStatus(payload);
    });
    const unlistenToken = listen<TokenEvent>("chat-token", ({ payload }) => {
      setChats((current) => current.map((chat) => ({
        ...chat,
        messages: chat.messages.map((message) => message.id === payload.requestId
          ? { ...message, content: message.content + payload.content }
          : message),
      })),
      );
    });
    const unlistenDiagnostic = listen<DiagnosticEvent>("diagnostic-event", ({ payload }) => {
      setDiagnosticEvents((current) => [...current.slice(-499), payload]);
    });
    void invoke("record_diagnostic", { request: { layer: "frontend", level: "info", event: "app_initialized", detail: null } }).catch(() => undefined);
    invoke<ServerStatus>("server_status").then(setStatus).catch(() => undefined);
    invoke<SystemInfo>("system_info").then(setSystemInfo).catch(() => undefined);
    invoke<SearchProviderStatus>("search_provider_status").then(setSearchStatus).catch(() => undefined);
    invoke<DiagnosticEvent[]>("diagnostic_snapshot").then(setDiagnosticEvents).catch(() => undefined);
    void refreshCatalog().catch((error) => setInstallError(String(error)));
    return () => {
      void unlistenLog.then((fn) => fn());
      void unlistenStatus.then((fn) => fn());
      void unlistenToken.then((fn) => fn());
      void unlistenDiagnostic.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isTauri || status.phase !== "ready") return;
    const timer = window.setInterval(() => {
      void invoke<ServerStatus>("server_status").then(setStatus).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [status.phase]);

  useEffect(() => {
    if (!isTauri) return;
    const unlistenProgress = listen<DownloadProgress>("download-progress", ({ payload }) => {
      setDownloadProgress((current) => ({ ...current, [payload.id]: payload }));
    });
    return () => {
      void unlistenProgress.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        setIsDraggingFiles(view === "chat" && !activeRequest && !ragBusy);
        return;
      }
      setIsDraggingFiles(false);
      if (payload.type !== "drop") return;
      if (view !== "chat" || activeRequest || ragBusy) {
        setAttachmentError(t("dropUnavailable"));
        return;
      }
      void handleDroppedPaths(payload.paths);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => recordDiagnostic("frontend", "error", "file_drop_listener_failed"));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [view, activeRequest, ragBusy, activeChatId, activeRagDocumentKey, pendingAttachments.length, status.phase, locale]);

  async function copyDiagnosticReport() {
    const events = isTauri
      ? await invoke<DiagnosticEvent[]>("diagnostic_snapshot").catch(() => diagnosticEvents)
      : diagnosticEvents;
    const safeReport = [
      "GZ Bonsai 27B diagnostic report",
      `App: ${systemInfo?.appVersion ?? "unknown"}`,
      `macOS: ${systemInfo?.macosVersion ?? "unknown"}`,
      `Architecture: ${systemInfo?.architecture ?? "unknown"}`,
      `Chip: ${systemInfo?.chip ?? "unknown"}`,
      `Memory: ${formatBytes(systemInfo?.memoryBytes ?? 0, "en")}`,
      `Free disk: ${formatBytes(systemInfo?.freeDiskBytes ?? 0, "en")}`,
      `Server: ${status.phase} on 127.0.0.1:${status.port}`,
      `Context: ${contextSize}`,
      `Runtime file: ${runtimePath ? fileName(runtimePath) : "not selected"}`,
      `Model file: ${modelPath ? fileName(modelPath) : "not selected"}`,
      `Projector file: ${projectorPath ? fileName(projectorPath) : "not selected"}`,
      `Web search: ${searchProviderName} · Brave key ${searchStatus.braveConfigured ? "configured" : "not configured"}`,
      "Recent application events:",
      ...events.slice(-120).map((event) => `${new Date(event.timestampMs).toISOString()} [${event.level}] [${event.layer}] ${event.event}${event.detail ? ` · ${event.detail}` : ""}`),
      "Recent runtime log:",
      ...logs.slice(-80),
    ].join("\n");
    await navigator.clipboard.writeText(safeReport);
    setReportCopied(true);
    window.setTimeout(() => setReportCopied(false), 1800);
  }

  async function saveSearchApiKey() {
    if (!searchApiKey.trim() || searchSettingsBusy) return;
    setSearchSettingsBusy(true);
    setSearchSettingsMessage(null);
    try {
      const next = await invoke<SearchProviderStatus>("save_brave_api_key", { request: { apiKey: searchApiKey } });
      setSearchStatus(next);
      setSearchApiKey("");
      setSearchSettingsMessage(t("searchKeySaved"));
      setSearchError(null);
    } catch (error) {
      setSearchSettingsMessage(localizedSearchError(error));
    } finally {
      setSearchApiKey("");
      setSearchSettingsBusy(false);
    }
  }

  async function removeSearchApiKey() {
    if (searchSettingsBusy) return;
    setSearchSettingsBusy(true);
    setSearchSettingsMessage(null);
    try {
      const next = await invoke<SearchProviderStatus>("delete_brave_api_key");
      setSearchStatus(next);
      setSearchSettingsMessage(t("searchKeyRemoved"));
    } catch (error) {
      setSearchSettingsMessage(localizedSearchError(error));
    } finally {
      setSearchApiKey("");
      setSearchSettingsBusy(false);
    }
  }

  function toggleWebSearch() {
    setSearchError(null);
    setWebSearchEnabled((value) => !value);
  }

  async function copyEndpoint() {
    await navigator.clipboard.writeText(`http://127.0.0.1:${port}/v1`);
    setEndpointCopied(true);
    window.setTimeout(() => setEndpointCopied(false), 1800);
  }

  async function chooseFile(kind: "runtime" | "model" | "projector") {
    const selected = await open({
      multiple: false,
      directory: false,
      title: kind === "runtime" ? t("selectRuntime") : t("selectModel"),
      filters: kind === "runtime" ? undefined : [{ name: "GGUF", extensions: ["gguf"] }],
    });
    if (!selected) return;
    if (kind === "runtime") setRuntimePath(selected);
    if (kind === "model") setModelPath(selected);
    if (kind === "projector") setProjectorPath(selected);
  }

  async function startServer() {
    setLogs([]);
    setStatus({ phase: "starting", port, detail: t("healthWaiting") });
    try {
      const next = await invoke<ServerStatus>("start_server", {
        config: { runtimePath, modelPath, projectorPath: projectorPath || null, port, contextSize },
      });
      setStatus(next);
      recordDiagnostic("runtime", "info", "server_ready", `port=${next.port}`);
    } catch (error) {
      setStatus({ phase: "error", port, detail: String(error) });
      recordDiagnostic("runtime", "error", "server_start_failed");
    }
  }

  async function stopServer() {
    setStatus({ phase: "stopping", port });
    try {
      setStatus(await invoke<ServerStatus>("stop_server"));
      recordDiagnostic("runtime", "info", "server_stopped");
    } catch (error) {
      setStatus({ phase: "error", port, detail: String(error) });
      recordDiagnostic("runtime", "error", "server_stop_failed");
    }
  }

  async function installManagedModel(model: CatalogModel) {
    setInstallError(null);
    setActiveDownload(model.id);
    recordDiagnostic("installer", "info", "model_install_started", `model_id=${model.id}`);
    try {
      const managedRuntime = await invoke<string>("install_runtime");
      const installedModel = await invoke<string>("install_model", {
        request: { modelId: model.id },
      });
      const installedProjector = model.visionCapable
        ? await invoke<string>("install_projector", { request: { modelId: model.id } })
        : "";
      setRuntimePath(managedRuntime);
      setModelPath(installedModel);
      setProjectorPath(installedProjector);
      setContextSize(model.contextSize);
      await refreshCatalog();
      recordDiagnostic("installer", "info", "model_install_succeeded", `model_id=${model.id}`);
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("cancel") && !message.includes("paused")) setInstallError(String(error));
      recordDiagnostic("installer", "error", "model_install_failed", `model_id=${model.id}`);
    } finally {
      setActiveDownload(null);
    }
  }

  async function pauseDownload(id: string) {
    try {
      await invoke("pause_install", { id });
    } catch (error) {
      setInstallError(String(error));
    }
  }

  async function cancelDownload(id: string) {
    try {
      await invoke("cancel_install", { id });
    } catch (error) {
      setInstallError(String(error));
    }
  }

  async function removeManagedModel(model: CatalogModel) {
    setInstallError(null);
    try {
      await invoke("remove_model", { request: { modelId: model.id } });
      if (modelPath === model.installedPath) setModelPath("");
      await refreshCatalog();
    } catch (error) {
      setInstallError(String(error));
    }
  }

  async function installManagedProjector(model: CatalogModel) {
    setInstallError(null);
    setActiveDownload(`${model.id}-vision`);
    try {
      const path = await invoke<string>("install_projector", { request: { modelId: model.id } });
      if (model.installedPath === modelPath) setProjectorPath(path);
      await refreshCatalog();
    } catch (error) {
      setInstallError(String(error));
    } finally {
      setActiveDownload(null);
    }
  }

  function useManagedModel(model: CatalogModel) {
    if (!model.installedPath || !catalog?.runtimePath) return;
    setRuntimePath(catalog.runtimePath);
    setModelPath(model.installedPath);
    setProjectorPath(model.projectorPath ?? "");
    setContextSize(model.contextSize);
  }

  function beginNewChat() {
    const chat = createChat(t("untitledChat"));
    setChats((current) => [chat, ...current]);
    setActiveChatId(chat.id);
    setPendingAttachments([]);
    setDraft("");
    setView("chat");
  }

  async function addAttachmentsFromPaths(paths: string[]) {
    setAttachmentError(null);
    const available = Math.max(0, 6 - pendingAttachments.length);
    if (!available) {
      setAttachmentError(t("attachmentLimit"));
      return;
    }
    const attachments: Attachment[] = [];
    let importError: string | null = paths.length > available ? t("attachmentLimit") : null;
    for (const path of paths.slice(0, available)) {
      try {
        const payload = await invoke<AttachmentPayload>("read_attachment", { request: { path } });
        attachments.push({ ...payload, id: crypto.randomUUID() });
      } catch (error) {
        importError = String(error);
      }
    }
    if (attachments.length) {
      setPendingAttachments((current) => [...current, ...attachments].slice(0, 6));
      recordDiagnostic("frontend", "info", "prompt_attachments_added", `count=${attachments.length}`);
    }
    if (importError) setAttachmentError(importError);
  }

  async function chooseAttachments() {
    setAttachmentError(null);
    const selected = await open({
      multiple: true,
      directory: false,
      title: t("attachFiles"),
      filters: [
        { name: t("supportedFiles"), extensions: ["png", "jpg", "jpeg", "webp", "txt", "md", "markdown", "csv", "json", "rs", "swift", "js", "jsx", "ts", "tsx", "py", "sh", "toml", "yaml", "yml", "xml", "html", "css"] },
      ],
    });
    if (!selected) return;
    await addAttachmentsFromPaths(Array.isArray(selected) ? selected : [selected]);
  }

  async function importRagDocuments(paths: string[]) {
    if (!activeChat || ragBusy) return;
    setRagError(null);
    const selectedPaths = paths
      .slice(0, Math.max(0, 12 - (activeChat.ragDocumentIds?.length ?? 0)));
    if (!selectedPaths.length) {
      setRagError(t("ragDocumentLimit"));
      return;
    }
    setRagBusy(true);
    recordDiagnostic("rag", "info", "document_import_started", `count=${selectedPaths.length}`);
    const imported: RagDocument[] = [];
    let importError: string | null = null;
    for (const path of selectedPaths) {
      try {
        imported.push(await invoke<RagDocument>("import_rag_document", { request: { path } }));
      } catch (error) {
        importError = String(error);
        recordDiagnostic("rag", "error", "document_import_failed");
      }
    }
    if (imported.length) {
      const importedIds = imported.map((document) => document.id);
      setChats((current) => current.map((chat) => chat.id === activeChat.id
        ? { ...chat, ragDocumentIds: [...new Set([...(chat.ragDocumentIds ?? []), ...importedIds])], updatedAt: Date.now() }
        : chat));
      setRagDocuments((current) => [...new Map([...current, ...imported].map((document) => [document.id, document])).values()]);
      recordDiagnostic("rag", "info", "document_import_succeeded", `count=${imported.length}`);
    }
    if (importError) setRagError(importError);
    setRagBusy(false);
  }

  async function chooseRagDocuments() {
    const selected = await open({
      multiple: true,
      directory: false,
      title: t("addRagDocuments"),
      filters: [{ name: t("ragSupportedFiles"), extensions: ["pdf", "docx", "txt", "md", "markdown", "csv", "json"] }],
    });
    if (!selected) return;
    await importRagDocuments(Array.isArray(selected) ? selected : [selected]);
  }

  async function handleDroppedPaths(paths: string[]) {
    if (!paths.length) return;
    const { ragPaths, attachmentPaths } = classifyDroppedPaths(paths);
    recordDiagnostic("frontend", "info", "files_dropped", `count=${paths.length}`);
    if (ragPaths.length) await importRagDocuments(ragPaths);
    if (attachmentPaths.length) {
      if (status.phase !== "ready") {
        setAttachmentError(t("dropStartModel"));
        return;
      }
      await addAttachmentsFromPaths(attachmentPaths);
    }
  }

  function detachRagDocument(documentId: string) {
    if (!activeChat) return;
    setChats((current) => current.map((chat) => chat.id === activeChat.id
      ? { ...chat, ragDocumentIds: (chat.ragDocumentIds ?? []).filter((id) => id !== documentId), updatedAt: Date.now() }
      : chat));
    setRagDocuments((current) => current.filter((document) => document.id !== documentId));
  }

  function updateChatMessages(chatId: string, update: (messages: ChatMessage[]) => ChatMessage[], title?: string) {
    setChats((current) => current.map((chat) => chat.id === chatId
      ? {
        ...chat,
        title: title && chat.titleSource !== "user" ? title : chat.title,
        updatedAt: Date.now(),
        messages: update(chat.messages),
      }
      : chat));
  }

  function startRenamingChat(chat: ChatSession) {
    setEditingChatId(chat.id);
    setEditingChatTitle(chat.title);
  }

  function commitChatRename() {
    if (!editingChatId) return;
    setChats((current) => current.map((chat) => chat.id === editingChatId
      ? renameChatSession(chat, editingChatTitle)
      : chat));
    setEditingChatId(null);
    setEditingChatTitle("");
  }

  function deleteChat(chat: ChatSession) {
    if (!window.confirm(`${t("confirmDeleteChat")} “${chat.title}”?`)) return;
    const remaining = chats.filter((item) => item.id !== chat.id);
    if (activeChatId === chat.id) {
      const next = [...remaining].sort((a, b) => b.updatedAt - a.updatedAt)[0]
        ?? createChat(t("untitledChat"));
      if (!remaining.length) remaining.push(next);
      setActiveChatId(next.id);
      setDraft("");
      setPendingAttachments([]);
      setAttachmentError(null);
      setView("chat");
    }
    setChats(remaining);
  }

  function apiContent(message: ChatMessage): string | Array<Record<string, unknown>> {
    const textAttachments = message.attachments?.filter((attachment) => attachment.kind === "text") ?? [];
    const imageAttachments = message.attachments?.filter((attachment) => attachment.kind === "image") ?? [];
    const combinedText = [
      message.content,
      ...textAttachments.map((attachment) => `\n\n<attached_file name="${attachment.name}">\n${attachment.content}\n</attached_file>`),
    ].join("").trim();
    if (!imageAttachments.length) return combinedText;
    return [
      { type: "text", text: combinedText || t("describeImages") },
      ...imageAttachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.content } })),
    ];
  }

  async function sendMessage() {
    const content = draft.trim();
    if ((!content && !pendingAttachments.length) || activeRequest || status.phase !== "ready" || !activeChat) return;
    if (pendingAttachments.some((attachment) => attachment.kind === "image") && !projectorPath) {
      setAttachmentError(t("visionProjectorRequired"));
      return;
    }
    const requestId = crypto.randomUUID();
    const chatId = activeChat.id;
    setActiveRequest(requestId);
    setSearchError(null);
    let sources: WebSearchResult[] = [];
    if (webSearchEnabled && content) {
      setSearching(true);
      try {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        sources = await invoke<WebSearchResult[]>("web_search", {
          request: {
            query: content,
            limit: 5,
            locale,
            country: resolveSearchCountry(navigator.language, timezone),
            timezone,
            freshness: inferSearchFreshness(content),
          },
        });
      } catch (error) {
        setSearchError(localizedSearchError(error));
        setActiveRequest(null);
        setSearching(false);
        return;
      }
      setSearching(false);
    }
    const ragContext = content && activeChat.ragDocumentIds?.length
      ? await (async () => {
        setRagBusy(true);
        setRagError(null);
        try {
          const hits = await invoke<RagSearchHit[]>("search_rag_documents", {
            request: {
              query: content,
              documentIds: activeChat.ragDocumentIds,
              limit: 5,
              maxCharacters: Math.min(9_000, Math.max(3_000, contextSize)),
            },
          });
          return buildRagContext(content, hits, locale);
        } catch (error) {
          setRagError(String(error));
          return null;
        } finally {
          setRagBusy(false);
        }
      })()
      : null;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, attachments: pendingAttachments };
    const assistantMessage: ChatMessage = { id: requestId, role: "assistant", content: "", documentSources: ragContext?.sources };
    const history: Array<{ role: string; content: unknown }> = [...activeChat.messages, userMessage]
      .map((message) => ({ role: message.role, content: apiContent(message) }));
    if (sources.length) {
      history.push({
        role: "user",
        content: `${t("webResultsInstruction").replace("{provider}", sources[0]?.provider === "brave" ? "Brave" : "Tavily")}\n${sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet}`).join("\n\n")}`,
      });
      setEphemeralSources((current) => ({ ...current, [requestId]: sources }));
    }
    if (ragContext) {
      history.push({ role: "user", content: ragContext.prompt });
    }
    const nextTitle = activeChat.messages.length === 0 && content
      ? normalizeChatTitle(content)
      : undefined;
    updateChatMessages(chatId, (current) => [...current, userMessage, assistantMessage], nextTitle);
    setDraft("");
    setPendingAttachments([]);
    setAttachmentError(null);
    recordDiagnostic("chat", "info", "request_started", `web=${sources.length > 0} rag=${Boolean(ragContext)}`);
    try {
      const metrics = await invoke<MessageMetrics | null>("stream_chat", { request: { requestId, port, messages: history } });
      if (metrics) {
        updateChatMessages(chatId, (current) => current.map((message) =>
          message.id === requestId ? { ...message, metrics } : message,
        ));
      }
      recordDiagnostic("chat", "info", "request_succeeded", metrics ? `total_tokens=${metrics.totalTokens}` : undefined);
    } catch (error) {
      updateChatMessages(chatId, (current) => current.map((message) =>
          message.id === requestId ? { ...message, content: String(error) } : message,
      ));
      recordDiagnostic("chat", "error", "request_failed");
    } finally {
      setActiveRequest(null);
    }
  }

  const phaseLabel = status.phase === "ready" ? t("ready") : status.phase === "starting" ? t("starting") : status.phase === "stopping" ? t("stopping") : status.phase === "error" ? t("error") : t("stopped");
  const canStart = runtimePath && modelPath && status.phase !== "starting" && status.phase !== "ready";
  const recommendedModel = useMemo(() => {
    if (!catalog?.models.length) return null;
    const memory = systemInfo?.memoryBytes ?? 0;
    return [...catalog.models]
      .filter((model) => memory >= model.estimatedMemoryBytes)
      .sort((a, b) => b.estimatedMemoryBytes - a.estimatedMemoryBytes || b.sizeBytes - a.sizeBytes)[0] ?? catalog.models[0];
  }, [catalog, systemInfo]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><Logo /><span>{t("appName")}</span></div>
        <nav>
          <NavButton icon="chat" label={t("navChat")} active={false} onClick={beginNewChat} />
          <NavButton icon="models" label={t("navModels")} active={view === "models"} onClick={() => setView("models")} />
          <NavButton icon="debug" label={t("navDiagnostics")} active={view === "diagnostics"} onClick={() => setView("diagnostics")} />
          <NavButton icon="info" label={t("navAbout")} active={view === "about"} onClick={() => setView("about")} />
        </nav>
        <div className="chat-history">
          <small>{t("recentChats")}</small>
          <div>{[...chats].sort((a, b) => b.updatedAt - a.updatedAt).map((chat) => editingChatId === chat.id
            ? <form className="chat-title-form" key={chat.id} onSubmit={(event) => { event.preventDefault(); commitChatRename(); }}>
              <input
                className="chat-title-input"
                value={editingChatTitle}
                maxLength={80}
                autoFocus
                aria-label={t("renameChat")}
                onChange={(event) => setEditingChatTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setEditingChatId(null);
                    setEditingChatTitle("");
                  }
                }}
              />
              <button type="submit" aria-label={t("save")}>✓</button>
              <button type="button" aria-label={t("cancel")} onClick={() => { setEditingChatId(null); setEditingChatTitle(""); }}>×</button>
            </form>
            : <div className="chat-history-row" key={chat.id}>
              <button className={view === "chat" && activeChatId === chat.id ? "active" : ""} title={chat.title} onClick={() => { setActiveChatId(chat.id); setView("chat"); }}>{chat.title}</button>
              <div className="chat-actions">
                <button aria-label={`${t("renameChat")}: ${chat.title}`} title={t("renameChat")} onClick={() => startRenamingChat(chat)}>✎</button>
                <button aria-label={`${t("deleteChat")}: ${chat.title}`} title={t("deleteChat")} onClick={() => deleteChat(chat)} disabled={Boolean(activeRequest && activeChatId === chat.id)}>×</button>
              </div>
            </div>)}</div>
        </div>
        <div className="sidebar-footer">
          <div className="privacy"><span className="privacy-dot" />{webSearchEnabled ? t("privacyWithSearch").replace("{provider}", searchProviderName) : t("privacy")}</div>
          <div className="locale-switch" aria-label="Language">{(["ru", "en"] as const).map((item) => <button className={locale === item ? "active" : ""} onClick={() => setLocale(item)} key={item}>{item.toUpperCase()}</button>)}</div>
          <ExternalLink href="https://zakharov.asia/ru/">{t("developedBy")} <ExternalIcon /></ExternalLink>
        </div>
      </aside>
      <section className={`main-pane ${isDraggingFiles ? "drop-active" : ""}`}>
        {isDraggingFiles && <div className="drop-overlay" role="status" aria-live="polite"><FileIcon /><strong>{t("dropFiles")}</strong><span>{t("dropFilesHint")}</span></div>}
        {view === "chat" && <>
          <header className="pane-bar"><button className="model-picker" onClick={() => setView("models")}><Logo small /><span><small>{t("localModel")}</small>{status.modelName ?? (modelPath ? fileName(modelPath) : t("notSelected"))}</span><ChevronIcon /></button>{chatMetrics && <details className="chat-statistics"><summary>{formatCount(chatMetrics.totalTokens, locale)} {t("tokensShort")} · {formatSpeed(chatMetrics.tokensPerSecond, locale)} {t("tokensPerSecond")}</summary><div><InfoRow label={t("responses")} value={formatCount(chatMetrics.responses, locale)} /><InfoRow label={t("promptTokens")} value={formatCount(chatMetrics.promptTokens, locale)} /><InfoRow label={t("outputTokens")} value={formatCount(chatMetrics.completionTokens, locale)} /><InfoRow label={t("totalTokens")} value={formatCount(chatMetrics.totalTokens, locale)} /><InfoRow label={t("averageSpeed")} value={`${formatSpeed(chatMetrics.tokensPerSecond, locale)} ${t("tokensPerSecond")}`} /><InfoRow label={t("totalTime")} value={formatDuration(chatMetrics.elapsedMs, locale)} /></div></details>}<details className="status-menu"><summary className={`status ${status.phase}`}><i /><span>{phaseLabel}</span><ChevronIcon /></summary><div className="status-popover"><InfoRow label={t("currentModel")} value={status.modelName ?? (modelPath ? fileName(modelPath) : t("notSelected"))} /><InfoRow label={t("backend")} value={status.backend?.includes("llama.cpp · Metal") ? t("metalBackend") : (status.backend ?? t("metalBackend"))} /><InfoRow label={t("processMemory")} value={status.memoryBytes ? formatBytes(status.memoryBytes, locale) : "—"} /><InfoRow label={t("context")} value={status.contextSize ? `${Math.round(status.contextSize / 1024)}K` : "—"} /><InfoRow label="Endpoint" value={`127.0.0.1:${status.port}`} />{status.phase === "ready" && <button className="stop-inline" onClick={stopServer}>{t("stopModel")}</button>}</div></details></header>
          <div className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}>
            {messages.length === 0 ? <div className="welcome"><Logo /><h1>{status.phase === "ready" ? t("chatWelcome") : t("chooseModelFirst")}</h1>{status.phase !== "ready" && <button onClick={() => setView("models")}>{t("openModels")}</button>}</div> : messages.map((message) => {
              const sources = ephemeralSources[message.id] ?? message.sources;
              return <article className={`message ${message.role}`} key={message.id}><div className="avatar">{message.role === "user" ? "GZ" : <Logo small />}</div><div className="message-body"><div className="message-role">{message.role === "user" ? t("you") : t("assistant")}</div>{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => attachment.kind === "image" ? <img key={attachment.id} src={attachment.content} alt={attachment.name} /> : <span key={attachment.id}>{attachment.name}</span>)}</div> : null}{message.role === "assistant" ? message.content ? <MarkdownMessage>{message.content}</MarkdownMessage> : activeRequest === message.id ? <GeneratingIndicator label={t("generating")} /> : null : <div className="plain-message">{message.content}</div>}{sources?.length ? <div className="sources"><small>{t("sources")}</small>{sources.map((source, index) => <ExternalLink href={source.url} key={`${message.id}-${index}-${source.url}`}>{index + 1}. {source.title}{source.age ? ` · ${source.age}` : ""}</ExternalLink>)}<em>{t("sourcesSessionOnly")}</em></div> : null}{message.documentSources?.length ? <div className="document-sources"><small>{t("documentSources")}</small>{message.documentSources.map((source) => <span key={`${source.documentId}-${source.chunkId}`} title={source.excerpt}>[{source.label}] {source.documentName} · {t("fragment")} {source.ordinal}</span>)}</div> : null}{message.role === "assistant" && message.metrics && <div className="message-metrics" title={`${t("promptTokens")}: ${formatCount(message.metrics.promptTokens, locale)} · ${t("totalTokens")}: ${formatCount(message.metrics.totalTokens, locale)}`}>{formatCount(message.metrics.completionTokens, locale)} {t("outputTokensUnit")} · {formatSpeed(message.metrics.tokensPerSecond, locale)} {t("tokensPerSecond")} · {formatDuration(message.metrics.elapsedMs, locale)}</div>}</div></article>;
            })}
          </div>
          <div className="composer-wrap">{ragDocuments.length ? <details className="rag-documents"><summary>{t("ragReady").replace("{count}", String(ragDocuments.length))}</summary><div>{ragDocuments.map((document) => <span key={document.id}><span><strong>{document.name}</strong><small>{document.chunkCount} {t("fragments")}</small></span><button onClick={() => detachRagDocument(document.id)} aria-label={`${t("detachRagDocument")}: ${document.name}`}>×</button></span>)}</div></details> : null}{pendingAttachments.length ? <div className="pending-attachments">{pendingAttachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? <img src={attachment.content} alt="" /> : <FileIcon />}<span>{attachment.name}</span><button onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={t("removeAttachment")}>×</button></span>)}</div> : null}{(attachmentError || ragError || searchError) && <div className="composer-error">{searchError || attachmentError || ragError}</div>}<div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={t("placeholder")} disabled={status.phase !== "ready" || Boolean(activeRequest)} rows={2} /><div className="composer-actions"><button className="tool-button" onClick={chooseAttachments} disabled={status.phase !== "ready" || Boolean(activeRequest)} aria-label={t("attachFiles")} title={t("attachFiles")}><PlusIcon /></button><button className="tool-button rag-button" onClick={chooseRagDocuments} disabled={Boolean(activeRequest) || ragBusy || (activeChat?.ragDocumentIds?.length ?? 0) >= 12} aria-label={t("addRagDocuments")} title={t("addRagDocuments")}><KnowledgeIcon /></button><button className={`tool-button search-toggle ${webSearchEnabled ? "active" : ""}`} onClick={toggleWebSearch} disabled={Boolean(activeRequest)} aria-pressed={webSearchEnabled} aria-label={t("webSearch")} title={t("webSearch")}><GlobeIcon /></button><button className="send-button" onClick={sendMessage} disabled={(!draft.trim() && !pendingAttachments.length) || status.phase !== "ready" || Boolean(activeRequest) || searching || ragBusy} aria-label={t("send")}><SendIcon /></button></div></div>{ragBusy && <div className="rag-disclosure">{t("ragIndexing")}</div>}{webSearchEnabled && <div className="search-disclosure">{searching ? t("searchingWeb").replace("{provider}", searchProviderName) : t("webSearchDisclosure").replace("{provider}", searchProviderName)}</div>}</div>
        </>}
        {view === "models" && <div className="content-page">
          <header className="page-heading"><div><h1>{t("modelsTitle")}</h1><p>{t("modelsDescription")}</p></div><div className={`status ${status.phase}`}><i /><span>{phaseLabel}</span></div></header>
          <div className="system-strip"><div><small>{t("system")}</small><strong>{systemInfo?.chip ?? "—"}</strong><span>{systemInfo?.architecture ?? "—"} · macOS {systemInfo?.macosVersion ?? "—"}</span></div><div><small>{t("memory")}</small><strong>{formatBytes(systemInfo?.memoryBytes ?? 0, locale)}</strong></div><div><small>{t("disk")}</small><strong>{formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)}</strong></div></div>
          <section className="endpoint-card"><div><small>{t("openAiEndpoint")}</small><strong>http://127.0.0.1:{port}/v1</strong><p>{status.phase === "ready" ? t("endpointReady") : t("endpointStartsWithModel")}</p></div><div><span className={`endpoint-state ${status.phase === "ready" ? "ready" : ""}`}>{status.phase === "ready" ? t("available") : t("offline")}</span><button className="quiet" onClick={copyEndpoint}>{endpointCopied ? t("endpointCopied") : t("copyEndpoint")}</button></div></section>
          <section className="catalog-section">
            <div className="section-heading"><div><h2>{t("catalogTitle")}</h2><p>{t("catalogDescription")}</p></div>{catalog && <span className={`runtime-pill ${catalog.runtimeInstalled ? "ready" : ""}`}>{catalog.runtimeInstalled ? t("runtimeIncluded") : t("runtimeMissing")}</span>}</div>
            <div className="model-grid">{catalog?.models.map((model) => {
              const isActive = activeDownload === model.id || activeDownload === `${model.id}-vision`;
              const progress = downloadProgress[activeDownload === `${model.id}-vision` ? `${model.id}-vision` : model.id];
              const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : 0;
              const selected = model.installedPath === modelPath;
              return <article className={`model-card ${recommendedModel?.id === model.id ? "recommended" : ""}`} key={model.id}>
                <div className="model-card-title"><div><strong>{model.name}</strong>{recommendedModel?.id === model.id && <span>{t("recommended")}</span>}</div><small>{formatBytes(model.sizeBytes, locale)}</small></div>
                <p>{model.id.includes("1.7b") ? t("modelHint17") : model.id.includes("4b") ? t("modelHint4") : model.id.includes("8b") ? t("modelHint8") : model.id === "bonsai-27b-q1" ? t("modelHint1bit") : model.id.includes("ptq1") ? t("modelHintTernaryCompact") : t("modelHintTernaryFast")}</p>
                <div className="model-meta"><span>{t("memoryEstimate")}: {formatBytes(model.estimatedMemoryBytes, locale)}+</span><span>{t("context")}: {model.contextSize / 1024}K</span><span>{model.visionCapable ? t("textAndImages") : t("textOnly")}</span></div>
                {isActive && progress && <div className="download-state"><div><span>{progress.phase === "verifying" ? t("verifying") : t("downloading")}</span><strong>{percent}%</strong></div><progress max="100" value={percent} /></div>}
                <div className="model-actions">{isActive ? <><button className="quiet" onClick={() => activeDownload && pauseDownload(activeDownload)}>{t("pause")}</button><button className="quiet danger" onClick={() => activeDownload && cancelDownload(activeDownload)}>{t("cancel")}</button></> : model.installed ? <>{model.visionCapable && !model.projectorInstalled && <button className="quiet install" onClick={() => installManagedProjector(model)}>{t("installVision")}</button>}<button className="quiet" onClick={() => useManagedModel(model)} disabled={selected}>{selected ? t("selected") : t("useModel")}</button><button className="quiet danger" onClick={() => removeManagedModel(model)} disabled={status.phase === "ready" || selected}>{t("remove")}</button></> : <button className="quiet install" onClick={() => installManagedModel(model)} disabled={Boolean(activeDownload)}>{progress?.phase === "paused" ? t("resume") : t("install")}</button>}</div>
              </article>;
            })}</div>
            {installError && <p className="status-detail">{installError}</p>}
          </section>
          <details className="manual-setup"><summary>{t("advancedSetup")}</summary><section className="settings-form"><FileField label={t("runtime")} value={runtimePath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("runtime")} /><FileField label={t("model")} value={modelPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("model")} /><FileField label={t("projector")} value={projectorPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("projector")} /><div className="field-row"><label>{t("context")}<select value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))} disabled={status.phase === "ready"}><option value={4096}>4K</option><option value={8192}>8K</option><option value={16384}>16K</option><option value={32768}>32K</option></select></label><label>{t("port")}<input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={status.phase === "ready"} /></label></div><div className="compatibility-note"><strong>{t("compatibleNote")}</strong><span>{t("manualNote")}</span></div></section></details>
          {status.detail && <p className="status-detail model-status">{status.detail}</p>}<div className="form-actions model-start">{status.phase === "ready" || status.phase === "stopping" ? <button className="primary stop" onClick={stopServer} disabled={status.phase === "stopping"}>{t("stop")}</button> : <button className="primary" onClick={startServer} disabled={!canStart}>{status.phase === "starting" ? t("starting") : t("start")}</button>}</div>
        </div>}
        {view === "diagnostics" && <div className="content-page narrow">
          <header className="page-heading"><div><h1>{t("diagnostics")}</h1><p>{t("debugPrivacy")}</p></div><button className="primary" onClick={copyDiagnosticReport}>{reportCopied ? t("reportCopied") : t("copyReport")}</button></header>
          <section className="search-settings">
            <div className="section-heading"><div><h2>{t("searchSettingsTitle")}</h2><p>{t("searchSettingsDescription")}</p></div><span className="endpoint-state ready">{searchProviderName}</span></div>
            <p className="search-keyless-note">{t("searchKeylessNotice")}</p>
            <div className="search-key-form"><input type="password" autoComplete="off" spellCheck={false} value={searchApiKey} onChange={(event) => setSearchApiKey(event.target.value)} placeholder={t("searchKeyPlaceholder")} aria-label={t("searchKeyPlaceholder")} /><button className="primary" onClick={saveSearchApiKey} disabled={!searchApiKey.trim() || searchSettingsBusy}>{searchSettingsBusy ? t("searchChecking") : t("searchSaveAndCheck")}</button>{searchStatus.braveConfigured && <button className="quiet danger" onClick={removeSearchApiKey} disabled={searchSettingsBusy}>{t("searchRemoveKey")}</button>}</div>
            {searchSettingsMessage && <p className="search-settings-message">{searchSettingsMessage}</p>}
            <ExternalLink href="https://api-dashboard.search.brave.com/app/keys">{t("searchOpenDashboard")} <ExternalIcon /></ExternalLink>
          </section>
          <div className="diagnostic-list"><InfoRow label={t("system")} value={`${systemInfo?.chip ?? "—"} · ${systemInfo?.architecture ?? "—"} · macOS ${systemInfo?.macosVersion ?? "—"}`} /><InfoRow label={t("memory")} value={formatBytes(systemInfo?.memoryBytes ?? 0, locale)} /><InfoRow label={t("disk")} value={formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)} /><InfoRow label={t("localModel")} value={modelPath ? fileName(modelPath) : t("notSelected")} /><InfoRow label={t("webSearch")} value={searchProviderName} /><InfoRow label="Endpoint" value={`http://127.0.0.1:${port}/v1`} /></div>
          <details className="logs"><summary>{t("applicationEvents")}<button onClick={(event) => { event.preventDefault(); setDiagnosticEvents([]); if (isTauri) void invoke("clear_diagnostics"); }}>{t("clear")}</button></summary><pre>{diagnosticEvents.slice(-200).map((event) => `${new Date(event.timestampMs).toLocaleTimeString()} [${event.level}] [${event.layer}] ${event.event}${event.detail ? ` · ${event.detail}` : ""}`).join("\n") || "—"}</pre></details>
          <details className="logs"><summary>{t("logs")}<button onClick={(event) => { event.preventDefault(); setLogs([]); }}>{t("clear")}</button></summary><pre>{logs.join("\n") || "—"}</pre></details>
        </div>}
        {view === "about" && <div className="content-page narrow about-page"><Logo /><h1>{t("aboutTitle")}</h1><p>{t("aboutText")}</p><div className="about-links"><ExternalLink href="https://zakharov.asia/ru/">{t("website")} <ExternalIcon /></ExternalLink><ExternalLink href="https://github.com/globa-me/gz-bonsai-27b">{t("sourceCode")} <ExternalIcon /></ExternalLink></div><small>{t("developedBy")}</small></div>}
      </section>
    </main>
  );
}

function FileField({ label, value, empty, choose, onChoose }: { label: string; value: string; empty: string; choose: string; onChoose: () => void }) {
  return <div className="file-field"><label>{label}</label><button onClick={onChoose}><span className={value ? "" : "placeholder"}>{value ? fileName(value) : empty}</span><strong>{choose}</strong></button></div>;
}

function GeneratingIndicator({ label }: { label: string }) {
  return <div className="generating-indicator" role="status" aria-live="polite"><span>{label}</span><span className="generating-dots" aria-hidden="true"><i /><i /><i /></span></div>;
}

function Logo({ small = false }: { small?: boolean }) { return <img className={`logo ${small ? "small" : ""}`} src={appIcon} alt="" aria-hidden="true" />; }
function SendIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6 9m4-4 4 4" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>; }
function GlobeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="M4 10h12M10 4c2 2 2 10 0 12M10 4c-2 2-2 10 0 12" /></svg>; }
function FileIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h5l3 3v11H6zM11 3v4h4" /></svg>; }
function KnowledgeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5c2.3-.9 4.3-.5 6 1.1v9c-1.7-1.6-3.7-2-6-1.1zM16 5.5c-2.3-.9-4.3-.5-6 1.1v9c1.7-1.6 3.7-2 6-1.1z" /></svg>; }
function ChevronIcon() { return <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3" /></svg>; }
function ExternalIcon() { return <svg className="external" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 4 12" /></svg>; }
function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true">{icon === "chat" && <path d="M4 4.5h12v8H9l-4 3v-3H4z" />}{icon === "models" && <><path d="M4 5.5h12v9H4z" /><path d="M7 3.5v2m6-2v2M7 9h6m-6 3h4" /></>}{icon === "debug" && <><circle cx="10" cy="10" r="6" /><path d="M10 6.8v3.7m0 2.6v.1" /></>}{icon === "info" && <><circle cx="10" cy="10" r="6" /><path d="M10 9v4m0-6v.1" /></>}</svg><span>{label}</span></button>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} onClick={(event) => { if (isTauri) { event.preventDefault(); void openUrl(href); } }} target="_blank" rel="noreferrer">{children}</a>;
}
