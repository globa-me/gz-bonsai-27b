import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Locale, translate } from "./i18n";
import appIcon from "./assets/app-icon.png";
import { MarkdownMessage } from "./MarkdownMessage";
import { createChat, loadChats, normalizeChatTitle, renameChatSession, restoreAutoChatTitle, restoreInterruptedAnswers, saveChats, type Attachment, type ChatMessage, type ChatSession, type SearchSource } from "./chatStore";
import { summarizeMetrics, type MessageMetrics } from "./chatMetrics";
import { buildRagContext, groupDocumentSources, type RagDocument, type RagSearchHit } from "./rag";
import { buildPromptHistory } from "./promptHistory";
import { boundedRepetitionCount } from "./repetition";
import { createSaveQueue } from "./chatPersistence";
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
  baseModelName: string;
  baseModelUrl: string;
  bonsaiUrl: string;
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
    { id: "bonsai-1.7b-q1", name: "Bonsai 1.7B · Q1_0", description: "", baseModelName: "Qwen3-1.7B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3-1.7B", bonsaiUrl: "https://huggingface.co/prism-ml/Bonsai-1.7B-gguf", filename: "Bonsai-1.7B-Q1_0.gguf", sizeBytes: 248302272, estimatedMemoryBytes: 8 * 1024 ** 3, contextSize: 4096, installed: false },
    { id: "bonsai-4b-q1", name: "Bonsai 4B · Q1_0", description: "", baseModelName: "Qwen3-4B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3-4B", bonsaiUrl: "https://huggingface.co/prism-ml/Bonsai-4B-gguf", filename: "Bonsai-4B-Q1_0.gguf", sizeBytes: 572270624, estimatedMemoryBytes: 12 * 1024 ** 3, contextSize: 8192, installed: false },
    { id: "bonsai-8b-q1", name: "Bonsai 8B · Q1_0", description: "", baseModelName: "Qwen3-8B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3-8B", bonsaiUrl: "https://huggingface.co/prism-ml/Bonsai-8B-gguf", filename: "Bonsai-8B-Q1_0.gguf", sizeBytes: 1158654496, estimatedMemoryBytes: 16 * 1024 ** 3, contextSize: 16384, installed: false },
    { id: "bonsai-27b-q1", name: "Bonsai 27B · 1-bit Q1_0", description: "", baseModelName: "Qwen3.6-27B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3.6-27B", bonsaiUrl: "https://huggingface.co/prism-ml/Bonsai-27B-gguf", filename: "Bonsai-27B-Q1_0.gguf", sizeBytes: 3803452480, estimatedMemoryBytes: 16 * 1024 ** 3, contextSize: 8192, installed: false, visionCapable: true },
    { id: "bonsai-2-27b-ptq1", name: "Bonsai 2 27B · ternary PTQ1_0", description: "", baseModelName: "Qwen3.8-27B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3.8-27B", bonsaiUrl: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf", filename: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", sizeBytes: 5946648928, estimatedMemoryBytes: 24 * 1024 ** 3, contextSize: 8192, installed: false, visionCapable: true },
    { id: "bonsai-2-27b-pq2", name: "Bonsai 2 27B · ternary PQ2_0", description: "", baseModelName: "Qwen3.8-27B", baseModelUrl: "https://huggingface.co/Qwen/Qwen3.8-27B", bonsaiUrl: "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf", filename: "Ternary-Bonsai-2-27B-PQ2_0.gguf", sizeBytes: 7206168928, estimatedMemoryBytes: 32 * 1024 ** 3, contextSize: 16384, installed: false, visionCapable: true },
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
  const [ragDocumentsByChat, setRagDocumentsByChat] = useState<Record<string, RagDocument[]>>({});
  const [ragBusy, setRagBusy] = useState(false);
  const [ragBusyChatId, setRagBusyChatId] = useState<string | null>(null);
  const [ragErrorsByChat, setRagErrorsByChat] = useState<Record<string, string | null>>({});
  const [pendingFileChoice, setPendingFileChoice] = useState<{ chatId: string; paths: string[] } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const saveVersion = useRef(0);
  const saveQueue = useRef(createSaveQueue(saveChats));
  const lastSaveEnqueuedAt = useRef(0);
  const saveCheckpoint = useRef<{ requestId: string; resolve: (saved: boolean) => void } | null>(null);
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
  const activeRequestChatId = useRef<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return window.localStorage.getItem("bonsai-sidebar-collapsed") === "true"; }
    catch { return false; }
  });
  const [catalog, setCatalog] = useState<ManagedCatalog | null>(null);
  const [activeDownload, setActiveDownload] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const modelMenu = useRef<HTMLDetailsElement | null>(null);
  const modelSwitching = useRef(false);
  useEffect(() => {
    try { window.localStorage.setItem("bonsai-sidebar-collapsed", String(sidebarCollapsed)); }
    catch { /* Window storage may be unavailable; the toggle still works. */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (modelMenu.current && !modelMenu.current.contains(event.target as Node)) modelMenu.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && modelMenu.current?.open) {
        modelMenu.current.open = false;
        modelMenu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const ragDocuments = ragDocumentsByChat[activeChatId ?? ""] ?? [];
  const ragError = ragErrorsByChat[activeChatId ?? ""] ?? null;
  const pendingFileChoicePaths = pendingFileChoice?.chatId === activeChatId ? pendingFileChoice.paths : [];
  const messages = activeChat?.messages ?? [];
  const chatMetrics = useMemo(
    () => summarizeMetrics(messages.map((message) => message.role === "assistant" ? message.metrics : undefined)),
    [messages],
  );
  const activeRagDocumentKey = (activeChat?.ragDocumentIds ?? []).join(",");
  const searchProviderName = searchStatus.provider === "brave" ? "Brave" : "Tavily Keyless";

  function setRagErrorForChat(chatId: string, error: string | null) {
    setRagErrorsByChat((current) => ({ ...current, [chatId]: error }));
  }

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

  async function initializeChats() {
    await loadChats()
      .then((stored) => {
        const initial = stored.length
          ? stored.map((chat) => restoreAutoChatTitle(restoreInterruptedAnswers(chat, translate(locale, "answerInterrupted"))))
          : [createChat(translate(locale, "untitledChat"))];
        setChats((current) => historyLoadFailed ? [...current, ...initial.filter((chat) => !current.some((item) => item.id === chat.id))] : initial);
        setActiveChatId((current) => current && historyLoadFailed ? current : initial[0].id);
        setHistoryLoadFailed(false);
        setHistoryLoaded(true);
        setSaveState("saved");
        recordDiagnostic("storage", "info", "chat_history_loaded", `chats=${initial.length}`);
      })
      .catch(() => {
        const initial = createChat(translate(locale, "untitledChat"));
        setChats((current) => current.length ? current : [initial]);
        setActiveChatId((current) => current ?? initial.id);
        setHistoryLoadFailed(true);
        setSaveState("error");
        recordDiagnostic("storage", "error", "chat_history_load_failed");
      });
  }

  useEffect(() => {
    void initializeChats();
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    const version = ++saveVersion.current;
    setSaveState("saving");
    let flushed = false;
    let timer: number | undefined;
    const checkpoint = saveCheckpoint.current;
    const includesCheckpoint = Boolean(checkpoint && chats.some((chat) => chat.messages.some((message) => message.id === checkpoint.requestId)));
    const flush = () => {
      if (flushed) return;
      flushed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      lastSaveEnqueuedAt.current = Date.now();
      void saveQueue.current(chats).then(() => {
        if (saveVersion.current === version) setSaveState("saved");
        if (includesCheckpoint && saveCheckpoint.current === checkpoint) {
          saveCheckpoint.current = null;
          checkpoint?.resolve(true);
        }
      }).catch(() => {
        if (saveVersion.current === version) setSaveState("error");
        recordDiagnostic("storage", "error", "chat_history_save_failed");
        if (includesCheckpoint && saveCheckpoint.current === checkpoint) {
          saveCheckpoint.current = null;
          checkpoint?.resolve(false);
        }
      });
    };
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") flush(); };
    if (includesCheckpoint || Date.now() - lastSaveEnqueuedAt.current >= 1_500) flush();
    else timer = window.setTimeout(flush, 350);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [chats, historyLoaded]);

  useEffect(() => {
    const documentIds = activeChat?.ragDocumentIds ?? [];
    if (!isTauri || !documentIds.length) {
      if (activeChatId) setRagDocumentsByChat((current) => ({ ...current, [activeChatId]: [] }));
      return;
    }
    let cancelled = false;
    void invoke<RagDocument[]>("list_rag_documents", { request: { documentIds } })
      .then((documents) => {
        if (!cancelled && activeChatId) setRagDocumentsByChat((current) => ({ ...current, [activeChatId]: documents }));
      })
      .catch((error) => {
        if (!cancelled && activeChatId) setRagErrorForChat(activeChatId, String(error));
      });
    return () => { cancelled = true; };
  }, [activeChatId, activeRagDocumentKey]);

  useEffect(() => {
    if (!isTauri) {
      setSystemInfo({ appVersion: "0.6.4", architecture: "aarch64", macosVersion: "26.5", chip: "Apple M3 Pro", memoryBytes: 18 * 1024 ** 3, freeDiskBytes: 115 * 1024 ** 3 });
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

  async function startServer(config = { runtimePath, modelPath, projectorPath, port, contextSize }) {
    setLogs([]);
    setStatus({ phase: "starting", port: config.port, modelName: fileName(config.modelPath), detail: t("healthWaiting") });
    try {
      const next = await invoke<ServerStatus>("start_server", {
        config: { ...config, projectorPath: config.projectorPath || null },
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

  async function selectModelFromChat(model: CatalogModel) {
    if (!model.installedPath || !catalog?.runtimePath || modelSwitching.current || activeRequest || status.phase === "starting" || status.phase === "stopping") return;
    modelMenu.current?.removeAttribute("open");
    const alreadyRunning = status.phase === "ready" && status.modelName === model.filename;
    if (alreadyRunning) return;
    modelSwitching.current = true;
    const nextConfig = { runtimePath: catalog.runtimePath, modelPath: model.installedPath, projectorPath: model.projectorPath ?? "", port, contextSize: model.contextSize };
    try {
      if (status.phase === "ready") {
        setStatus({ phase: "stopping", port, modelName: status.modelName });
        const stopped = await invoke<ServerStatus>("stop_server");
        setStatus(stopped);
        recordDiagnostic("runtime", "info", "server_stopped_for_model_switch");
      }
      setRuntimePath(nextConfig.runtimePath);
      setModelPath(nextConfig.modelPath);
      setProjectorPath(nextConfig.projectorPath);
      setContextSize(nextConfig.contextSize);
      await startServer(nextConfig);
    } catch (error) {
      setStatus({ phase: "error", port, detail: String(error) });
      recordDiagnostic("runtime", "error", "model_switch_failed");
    } finally {
      modelSwitching.current = false;
    }
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
    const chatId = activeChat.id;
    setRagErrorForChat(chatId, null);
    const selectedPaths = paths
      .slice(0, Math.max(0, 12 - (activeChat.ragDocumentIds?.length ?? 0)));
    if (!selectedPaths.length) {
      setRagErrorForChat(chatId, t("ragDocumentLimit"));
      return;
    }
    setRagBusy(true);
    setRagBusyChatId(chatId);
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
      setRagDocumentsByChat((current) => ({ ...current, [activeChat.id]: [...new Map([...(current[activeChat.id] ?? []), ...imported].map((document) => [document.id, document])).values()] }));
      recordDiagnostic("rag", "info", "document_import_succeeded", `count=${imported.length}`);
    }
    if (importError) setRagErrorForChat(chatId, importError);
    setRagBusy(false);
    setRagBusyChatId(null);
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
    const { ragPaths, attachmentPaths, choicePaths } = classifyDroppedPaths(paths);
    recordDiagnostic("frontend", "info", "files_dropped", `count=${paths.length}`);
    if (ragPaths.length) await importRagDocuments(ragPaths);
    if (choicePaths.length && activeChatId) setPendingFileChoice({ chatId: activeChatId, paths: choicePaths });
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
    setRagDocumentsByChat((current) => ({ ...current, [activeChat.id]: (current[activeChat.id] ?? []).filter((document) => document.id !== documentId) }));
  }

  async function deleteRagDocument(documentId: string) {
    if (!activeChat) return;
    const usedElsewhere = chats.some((chat) => chat.id !== activeChat.id && chat.ragDocumentIds?.includes(documentId));
    if (usedElsewhere) {
      setRagErrorForChat(activeChat.id, t("documentUsedElsewhere"));
      return;
    }
    if (!window.confirm(t("confirmDeleteDocument"))) return;
    try {
      await invoke("remove_rag_document", { request: { documentId } });
      detachRagDocument(documentId);
      setRagErrorForChat(activeChat.id, null);
    } catch {
      setRagErrorForChat(activeChat.id, t("documentDeleteFailed"));
    }
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
    if ((ragBusy && ragBusyChatId === chat.id) || (activeRequest && activeRequestChatId.current === chat.id)) return;
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

  async function stopGeneration() {
    if (!activeRequest) return;
    try {
      await invoke("cancel_chat", { requestId: activeRequest });
    } catch {
      // A search or document lookup may still be finishing; its own result will be shown.
    }
  }

  async function retryMessage(assistantId: string) {
    if (!activeChat || activeRequest) return;
    const index = activeChat.messages.findIndex((message) => message.id === assistantId);
    if (index < 1 || index !== activeChat.messages.length - 1) return;
    const userMessage = activeChat.messages[index - 1];
    if (userMessage.role !== "user") return;
    await sendMessage({ userMessage, assistantId });
  }

  async function sendMessage(retry?: { userMessage: ChatMessage; assistantId: string }) {
    const content = retry?.userMessage.content ?? draft.trim();
    const attachments = retry?.userMessage.attachments ?? pendingAttachments;
    if ((!content && !attachments.length) || activeRequest || ragBusy || status.phase !== "ready" || !activeChat || !historyLoaded) return;
    if (attachments.some((attachment) => attachment.kind === "image") && !projectorPath) {
      setAttachmentError(t("visionProjectorRequired"));
      return;
    }
    const requestId = crypto.randomUUID();
    const chatId = activeChat.id;
    const previousMessages = retry
      ? activeChat.messages.filter((message) => message.id !== retry.userMessage.id && message.id !== retry.assistantId)
      : activeChat.messages;
    activeRequestChatId.current = chatId;
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
        activeRequestChatId.current = null;
        setActiveRequest(null);
        setSearching(false);
        return;
      }
      setSearching(false);
    }
    let ragContext: ReturnType<typeof buildRagContext> = null;
    if (content && activeChat.ragDocumentIds?.length) {
      setRagBusy(true);
      setRagBusyChatId(chatId);
      setRagErrorForChat(chatId, null);
      try {
        // Character count is only a storage guard. The local tokenizer below
        // decides whether the full text actually fits the model context.
        const request = { query: content, documentIds: activeChat.ragDocumentIds, limit: 5, maxCharacters: 9_000 };
        let hits = await invoke<RagSearchHit[]>("search_rag_documents", { request: { ...request, wholeIfFits: true } });
        if (!hits.length) throw new Error("No text found");
        if (hits.some((hit) => hit.fullDocument)) {
          const candidate = buildRagContext(content, hits, locale);
          const historyText = previousMessages.slice(-8).map((message) => message.content).join("\n");
          const tokenCount = await invoke<number>("count_text_tokens", { request: { port, text: `${historyText}\n${content}\n${candidate?.prompt ?? ""}` } }).catch(() => Number.POSITIVE_INFINITY);
          if (tokenCount > contextSize * 0.6) {
            hits = await invoke<RagSearchHit[]>("search_rag_documents", { request: { ...request, wholeIfFits: false } });
          }
        }
        ragContext = buildRagContext(content, hits, locale);
        if (!ragContext) throw new Error("No text found");
      } catch {
        setRagErrorForChat(chatId, t("ragSearchFailed"));
        activeRequestChatId.current = null;
        setActiveRequest(null);
        setRagBusy(false);
        setRagBusyChatId(null);
        return;
      }
      setRagBusy(false);
      setRagBusyChatId(null);
    }
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, attachments };
    const assistantMessage: ChatMessage = { id: requestId, role: "assistant", content: "", documentSources: ragContext?.sources, pending: true };
    const history: Array<{ role: string; content: unknown }> = buildPromptHistory(previousMessages, userMessage, t("describeImages"));
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
    const nextTitle = previousMessages.length === 0 && content
      ? normalizeChatTitle(content)
      : undefined;
    const checkpoint = new Promise<boolean>((resolve) => { saveCheckpoint.current = { requestId, resolve }; });
    updateChatMessages(chatId, (current) => [
      ...(retry ? current.filter((message) => message.id !== retry.userMessage.id && message.id !== retry.assistantId) : current),
      userMessage,
      assistantMessage,
    ], nextTitle);
    if (!retry) {
      setDraft("");
      setPendingAttachments([]);
    }
    setAttachmentError(null);
    if (!await checkpoint) {
      if (retry) {
        updateChatMessages(chatId, () => activeChat.messages.map((message) =>
          message.id === retry.assistantId ? { ...message, error: t("saveFailed") } : message,
        ));
      } else {
        updateChatMessages(chatId, (current) => current.map((message) =>
          message.id === requestId ? { ...message, pending: false, error: t("saveFailed") } : message,
        ));
      }
      activeRequestChatId.current = null;
      setActiveRequest(null);
      return;
    }
    recordDiagnostic("chat", "info", "request_started", `web=${sources.length > 0} rag=${Boolean(ragContext)}`);
    try {
      const metrics = await invoke<MessageMetrics | null>("stream_chat", { request: { requestId, port, messages: history, webSearch: sources.length > 0, allowedRepetitions: boundedRepetitionCount(content) } });
      updateChatMessages(chatId, (current) => current.map((message) =>
        message.id === requestId ? { ...message, pending: false, ...(metrics ? { metrics } : {}) } : message,
      ));
      recordDiagnostic("chat", "info", "request_succeeded", metrics ? `total_tokens=${metrics.totalTokens}` : undefined);
    } catch (error) {
      const stopped = String(error).includes("CHAT_CANCELLED");
      const repeated = String(error).includes("CHAT_REPETITION");
      updateChatMessages(chatId, (current) => current.map((message) =>
        message.id === requestId ? { ...message, pending: false, error: stopped ? t("answerStopped") : repeated ? t("answerRepetition") : t("answerFailed"), stopped } : message,
      ));
      recordDiagnostic("chat", "error", "request_failed");
    } finally {
      activeRequestChatId.current = null;
      setActiveRequest(null);
    }
  }

  const phaseLabel = status.phase === "ready" ? t("ready") : status.phase === "starting" ? t("starting") : status.phase === "stopping" ? t("stopping") : status.phase === "error" ? t("error") : t("stopped");
  const modelConfigured = Boolean(runtimePath && modelPath);
  const canStart = modelConfigured && status.phase !== "starting" && status.phase !== "stopping" && status.phase !== "ready";
  const emptyChatTitle = status.phase === "ready" ? t("chatWelcome")
    : !modelConfigured ? t("chooseModelFirst")
      : status.phase === "starting" ? t("starting")
        : status.phase === "stopping" ? t("stopping") : t("startModelFirst");
  const recommendedModel = useMemo(() => {
    if (!catalog?.models.length) return null;
    const memory = systemInfo?.memoryBytes ?? 0;
    return [...catalog.models]
      .filter((model) => memory >= model.estimatedMemoryBytes)
      .sort((a, b) => a.estimatedMemoryBytes - b.estimatedMemoryBytes || a.sizeBytes - b.sizeBytes)[0] ?? catalog.models[0];
  }, [catalog, systemInfo]);
  const selectedManagedModel = catalog?.models.find((model) => model.installedPath && model.installedPath === modelPath);
  const customModelSelected = Boolean(modelPath && !selectedManagedModel);
  const quickStartModel = selectedManagedModel ?? recommendedModel;

  return (
    <main className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
        <div className="brand"><Logo /><span>{t("appName")}</span><button className="sidebar-toggle" onClick={() => setSidebarCollapsed(true)} aria-label={t("hideSidebar")} title={t("hideSidebar")}><PanelIcon /></button></div>
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
                <button aria-label={`${t("deleteChat")}: ${chat.title}`} title={t("deleteChat")} onClick={() => deleteChat(chat)} disabled={Boolean((activeRequest && activeRequestChatId.current === chat.id) || (ragBusy && ragBusyChatId === chat.id))}>×</button>
              </div>
            </div>)}</div>
        </div>
        <div className="sidebar-footer">
          <div className={`save-state ${saveState}`} role="status" aria-live="polite">{saveState === "saving" ? t("savingChats") : saveState === "error" ? <><span>{t("saveFailed")}</span><button onClick={() => { setSaveState("saving"); if (historyLoadFailed) void initializeChats(); else void saveQueue.current(chats).then(() => setSaveState("saved")).catch(() => setSaveState("error")); }}>{historyLoadFailed ? t("retryLoad") : t("retrySave")}</button></> : t("savedChats")}</div>
          <div className="locale-switch" aria-label="Language">{(["ru", "en"] as const).map((item) => <button className={locale === item ? "active" : ""} onClick={() => setLocale(item)} key={item}>{item.toUpperCase()}</button>)}</div>
          <ExternalLink href="https://zakharov.asia/ru/">{t("developedBy")} <ExternalIcon /></ExternalLink>
        </div>
      </aside>
      <section className={`main-pane ${isDraggingFiles ? "drop-active" : ""}`}>
        {sidebarCollapsed && <button className="sidebar-toggle sidebar-toggle-open" onClick={() => setSidebarCollapsed(false)} aria-label={t("showSidebar")} title={t("showSidebar")}><PanelIcon /></button>}
        {isDraggingFiles && <div className="drop-overlay" role="status" aria-live="polite"><FileIcon /><strong>{t("dropFiles")}</strong><span>{t("dropFilesHint")}</span></div>}
        {view === "chat" && <div className="chat-view">
          <header className="pane-bar"><details className="model-menu" ref={modelMenu} onToggle={(event) => { if (event.currentTarget.open && isTauri) void refreshCatalog().catch((error) => setInstallError(String(error))); }}><summary className="model-picker"><Logo small /><span><small>{t("localModel")}</small>{status.phase === "ready" || status.phase === "starting" || status.phase === "stopping" ? status.modelName ?? t("notSelected") : modelPath ? fileName(modelPath) : t("notSelected")}</span><ChevronIcon /></summary><div className="model-menu-popover"><strong>{t("installedModels")}</strong>{catalog?.models.filter((model) => model.installed && model.installedPath).map((model) => <div className="model-menu-item" key={model.id}><button className="model-menu-option" disabled={Boolean(activeRequest) || status.phase === "starting" || status.phase === "stopping"} onClick={() => void selectModelFromChat(model)}><span><b>{model.name}</b><small>{model.baseModelName} · {formatBytes(model.sizeBytes, locale)} · {model.contextSize / 1024}K</small></span><em>{status.phase === "ready" && status.modelName === model.filename ? t("running") : t("start")}</em></button><ModelLineage model={model} locale={locale} showBase={false} /></div>)}{!catalog?.models.some((model) => model.installed && model.installedPath) && <p>{t("noInstalledModels")}</p>}{status.detail && status.phase === "error" && <p className="model-menu-error">{status.detail}</p>}<div className="model-menu-actions">{status.phase === "ready" && <button onClick={() => { modelMenu.current?.removeAttribute("open"); void stopServer(); }} disabled={Boolean(activeRequest)}>{t("stopModel")}</button>}<button onClick={() => { modelMenu.current?.removeAttribute("open"); setView("models"); }}>{t("manageModels")}</button></div></div></details>{chatMetrics && <details className="chat-statistics"><summary>{formatCount(chatMetrics.totalTokens, locale)} {t("tokensShort")} · {formatSpeed(chatMetrics.tokensPerSecond, locale)} {t("tokensPerSecond")}</summary><div><InfoRow label={t("responses")} value={formatCount(chatMetrics.responses, locale)} /><InfoRow label={t("promptTokens")} value={formatCount(chatMetrics.promptTokens, locale)} /><InfoRow label={t("outputTokens")} value={formatCount(chatMetrics.completionTokens, locale)} /><InfoRow label={t("totalTokens")} value={formatCount(chatMetrics.totalTokens, locale)} /><InfoRow label={t("averageSpeed")} value={`${formatSpeed(chatMetrics.tokensPerSecond, locale)} ${t("tokensPerSecond")}`} /><InfoRow label={t("totalTime")} value={formatDuration(chatMetrics.elapsedMs, locale)} /></div></details>}<details className="status-menu"><summary className={`status ${status.phase}`}><i /><span>{phaseLabel}</span><ChevronIcon /></summary><div className="status-popover"><InfoRow label={t("currentModel")} value={status.modelName ?? (modelPath ? fileName(modelPath) : t("notSelected"))} /><InfoRow label={t("backend")} value={status.backend?.includes("llama.cpp · Metal") ? t("metalBackend") : (status.backend ?? t("metalBackend"))} /><InfoRow label={t("processMemory")} value={status.memoryBytes ? formatBytes(status.memoryBytes, locale) : "—"} /><InfoRow label={t("context")} value={status.contextSize ? `${Math.round(status.contextSize / 1024)}K` : "—"} /><InfoRow label="Endpoint" value={`127.0.0.1:${status.port}`} />{status.phase === "ready" && <button className="stop-inline" onClick={stopServer} disabled={Boolean(activeRequest)}>{t("stopModel")}</button>}</div></details></header>
          <div className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}>
            {messages.length === 0 ? <div className="welcome"><Logo /><h1>{emptyChatTitle}</h1>{canStart ? <button onClick={() => void startServer()}>{t("start")}</button> : !modelConfigured && <button onClick={() => setView("models")}>{t("openModels")}</button>}</div> : messages.map((message) => {
              const sources = ephemeralSources[message.id] ?? message.sources;
              return <article className={`message ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "user" ? "GZ" : <Logo small />}</div>
                <div className="message-body">
                  <div className="message-role">{message.role === "user" ? t("you") : t("assistant")}</div>
                  {message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => attachment.kind === "image" ? <img key={attachment.id} src={attachment.content} alt={attachment.name} /> : <span key={attachment.id}>{attachment.name}</span>)}</div> : null}
                  {message.role === "assistant" ? message.content ? <MarkdownMessage>{message.content}</MarkdownMessage> : activeRequest === message.id ? <GeneratingIndicator label={t("generating")} /> : null : <div className="plain-message">{message.content}</div>}
                  {message.error && <div className="message-error" role="alert"><span>{message.error}</span>{messages.at(-1)?.id === message.id && status.phase === "ready" && <button onClick={() => void retryMessage(message.id)}>{t("retryAnswer")}</button>}</div>}
                  {sources?.length ? <div className="sources"><small>{t("sources")}</small>{sources.map((source, index) => <ExternalLink href={source.url} key={`${message.id}-${index}-${source.url}`}>{index + 1}. {source.title}{source.age ? ` · ${source.age}` : ""}</ExternalLink>)}<em>{t("sourcesSessionOnly")}</em></div> : null}
                  {message.documentSources?.length ? <div className="document-sources"><small>{t("documentSources")}</small>{groupDocumentSources(message.documentSources).map((group) => <details className="document-source" key={group.documentId}><summary>[{group.labels.join(", ")}] {group.documentName} · {group.fullDocument ? t("ragWhole") : t("ragSelected")}</summary><div>{group.sources.map((source) => <p key={source.chunkId}>{!source.fullDocument && `${t("fragment")} ${source.ordinal}: `}{source.excerpt}</p>)}</div></details>)}</div> : null}
                  {message.role === "assistant" && message.metrics && <div className="message-metrics" title={`${t("promptTokens")}: ${formatCount(message.metrics.promptTokens, locale)} · ${t("totalTokens")}: ${formatCount(message.metrics.totalTokens, locale)}`}>{formatCount(message.metrics.completionTokens, locale)} {t("outputTokensUnit")} · {formatSpeed(message.metrics.tokensPerSecond, locale)} {t("tokensPerSecond")} · {formatDuration(message.metrics.elapsedMs, locale)}</div>}
                </div>
              </article>;
            })}
          </div>
          <div className="composer-wrap">
            {ragDocuments.length ? <details className="rag-documents"><summary>{t("ragReady").replace("{count}", String(ragDocuments.length))}</summary><div>{ragDocuments.map((document) => <div className="rag-document-row" key={document.id}><strong>{document.name}</strong><button disabled={Boolean(activeRequest)} onClick={() => detachRagDocument(document.id)} aria-label={`${t("detachRagDocument")}: ${document.name}`}>{t("detachRagDocument")}</button><button className="danger" disabled={Boolean(activeRequest)} onClick={() => void deleteRagDocument(document.id)} aria-label={`${t("deleteLocalDocument")}: ${document.name}`}>{t("deleteLocalDocument")}</button></div>)}</div></details> : null}
            {pendingFileChoicePaths.length ? <div className="file-choice" role="status"><span>{t("dropScopeQuestion")}</span><button disabled={status.phase !== "ready" || ragBusy} onClick={() => { void addAttachmentsFromPaths(pendingFileChoicePaths); setPendingFileChoice(null); }}>{t("toMessage")}</button><button disabled={ragBusy} onClick={() => { void importRagDocuments(pendingFileChoicePaths); setPendingFileChoice(null); }}>{t("toChat")}</button><button onClick={() => setPendingFileChoice(null)}>{t("cancel")}</button></div> : null}
            {pendingAttachments.length ? <div className="pending-attachments">{pendingAttachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? <img src={attachment.content} alt="" /> : <FileIcon />}<span>{attachment.name}</span><button onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={t("removeAttachment")}>×</button></span>)}</div> : null}
            {(attachmentError || ragError || searchError) && <div className="composer-error" role="alert"><span>{searchError || attachmentError || ragError}</span>{(ragError || searchError) && (draft.trim() || pendingAttachments.length) && status.phase === "ready" && !activeRequest && <button onClick={() => void sendMessage()}>{t("retryRequest")}</button>}</div>}
            <div className="composer">
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={t("placeholder")} disabled={!historyLoaded || status.phase !== "ready" || Boolean(activeRequest)} rows={2} />
              <div className="composer-actions">
                <button className="tool-button" onClick={chooseAttachments} disabled={!historyLoaded || status.phase !== "ready" || Boolean(activeRequest)} aria-label={t("attachFiles")} title={t("attachFiles")}><PlusIcon /></button>
                <button className="tool-button rag-button" onClick={chooseRagDocuments} disabled={!historyLoaded || Boolean(activeRequest) || ragBusy || (activeChat?.ragDocumentIds?.length ?? 0) >= 12} aria-label={t("addRagDocuments")} title={t("addRagDocuments")}><KnowledgeIcon /></button>
                <button className={`tool-button search-toggle ${webSearchEnabled ? "active" : ""}`} onClick={toggleWebSearch} disabled={Boolean(activeRequest)} aria-pressed={webSearchEnabled} aria-label={t("webSearch")} title={t("webSearch")}><GlobeIcon /></button>
                {activeRequest && !searching && !ragBusy ? <button className="send-button stop-answer" onClick={() => void stopGeneration()} aria-label={t("stopAnswer")} title={t("stopAnswer")}><StopIcon /></button> : <button className="send-button" onClick={() => void sendMessage()} disabled={!historyLoaded || (!draft.trim() && !pendingAttachments.length) || status.phase !== "ready" || Boolean(activeRequest) || searching || ragBusy} aria-label={t("send")} title={t("send")}><SendIcon /></button>}
              </div>
            </div>
            {ragBusy && ragBusyChatId === activeChatId && <div className="rag-disclosure" role="status">{t("ragIndexing")}</div>}
            {webSearchEnabled && <div className="search-disclosure" role="status">{searching ? t("searchingWeb").replace("{provider}", searchProviderName) : t("webSearchDisclosure").replace("{provider}", searchProviderName)}</div>}
          </div>
        </div>}
        {view === "models" && <div className="content-page">
          <header className="page-heading"><div><h1>{t("modelsTitle")}</h1><p>{t("modelsDescription")}</p></div><div className={`status ${status.phase}`}><i /><span>{phaseLabel}</span></div></header>
          <div className="system-strip"><div><small>{t("system")}</small><strong>{systemInfo?.chip ?? "—"}</strong><span>{systemInfo?.architecture ?? "—"} · macOS {systemInfo?.macosVersion ?? "—"}</span></div><div><small>{t("memory")}</small><strong>{formatBytes(systemInfo?.memoryBytes ?? 0, locale)}</strong></div><div><small>{t("disk")}</small><strong>{formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)}</strong></div></div>
          {customModelSelected ? <section className="quick-start"><div><h2>{t("advancedSetup")}</h2><strong>{fileName(modelPath)}</strong><small>{t("manualNote")}</small></div><div className="quick-start-actions">{status.phase === "ready" ? <button className="primary" onClick={() => setView("chat")}>{t("openChat")}</button> : <button className="primary" disabled={!canStart} onClick={() => void startServer()}>{status.phase === "starting" ? t("starting") : t("start")}</button>}</div></section> : quickStartModel && <section className="quick-start"><div><h2>{t("firstRunTitle")}</h2><p>{t("firstRunDesc")}</p><strong>{quickStartModel.name}</strong><ModelLineage model={quickStartModel} locale={locale} /><small>{t("catalogDescription")}</small></div><div className="quick-start-actions">{status.phase === "ready" ? <button className="primary" onClick={() => setView("chat")}>{t("openChat")}</button> : !quickStartModel.installed ? <button className="primary" disabled={Boolean(activeDownload)} onClick={() => void installManagedModel(quickStartModel)}>{downloadProgress[quickStartModel.id]?.phase === "paused" ? t("resume") : t("install")}</button> : modelPath !== quickStartModel.installedPath ? <button className="primary" onClick={() => useManagedModel(quickStartModel)}>{t("useModel")}</button> : <button className="primary" disabled={!canStart} onClick={() => void startServer()}>{status.phase === "starting" ? t("starting") : t("start")}</button>}</div></section>}
          {!customModelSelected && quickStartModel && activeDownload === quickStartModel.id && <div className="quick-progress" role="status"><span>{t("downloading")} {downloadProgress[quickStartModel.id]?.totalBytes ? Math.round((downloadProgress[quickStartModel.id].downloadedBytes / downloadProgress[quickStartModel.id].totalBytes) * 100) : 0}%</span><progress max="100" value={downloadProgress[quickStartModel.id]?.totalBytes ? (downloadProgress[quickStartModel.id].downloadedBytes / downloadProgress[quickStartModel.id].totalBytes) * 100 : 0} /><button onClick={() => void pauseDownload(quickStartModel.id)}>{t("pause")}</button><button onClick={() => void cancelDownload(quickStartModel.id)}>{t("cancel")}</button></div>}
          <section className="endpoint-card"><div><small>{t("openAiEndpoint")}</small><strong>http://127.0.0.1:{port}/v1</strong><p>{status.phase === "ready" ? t("endpointReady") : t("endpointStartsWithModel")}</p></div><div><span className={`endpoint-state ${status.phase === "ready" ? "ready" : ""}`}>{status.phase === "ready" ? t("available") : t("offline")}</span><button className="quiet" onClick={copyEndpoint}>{endpointCopied ? t("endpointCopied") : t("copyEndpoint")}</button></div></section>
          <section className="catalog-section">
            <div className="section-heading"><div><h2>{t("catalogTitle")}</h2><p>{t("catalogDescription")}</p></div>{catalog && <span className={`runtime-pill ${catalog.runtimeInstalled ? "ready" : ""}`}>{catalog.runtimeInstalled ? t("runtimeIncluded") : t("runtimeMissing")}</span>}</div>
            <details className="other-models"><summary><span>{t("otherModels")}</span><ChevronIcon /></summary><div className="model-grid">{catalog?.models.filter((model) => model.id !== quickStartModel?.id).map((model) => {
              const isActive = activeDownload === model.id || activeDownload === `${model.id}-vision`;
              const progress = downloadProgress[activeDownload === `${model.id}-vision` ? `${model.id}-vision` : model.id];
              const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : 0;
              const selected = model.installedPath === modelPath;
              return <article className={`model-card ${recommendedModel?.id === model.id ? "recommended" : ""}`} key={model.id}>
                <div className="model-card-title"><div><strong>{model.name}</strong>{recommendedModel?.id === model.id && <span>{t("recommended")}</span>}</div><small>{formatBytes(model.sizeBytes, locale)}</small></div>
                <ModelLineage model={model} locale={locale} />
                <p>{model.id.includes("1.7b") ? t("modelHint17") : model.id.includes("4b") ? t("modelHint4") : model.id.includes("8b") ? t("modelHint8") : model.id === "bonsai-27b-q1" ? t("modelHint1bit") : model.id.includes("ptq1") ? t("modelHintTernaryCompact") : t("modelHintTernaryFast")}</p>
                <div className="model-meta"><span>{t("memoryEstimate")}: {formatBytes(model.estimatedMemoryBytes, locale)}+</span><span>{t("context")}: {model.contextSize / 1024}K</span><span>{model.visionCapable ? t("textAndImages") : t("textOnly")}</span></div>
                {isActive && progress && <div className="download-state"><div><span>{progress.phase === "verifying" ? t("verifying") : t("downloading")}</span><strong>{percent}%</strong></div><progress max="100" value={percent} /></div>}
                <div className="model-actions">{isActive ? <><button className="quiet" onClick={() => activeDownload && pauseDownload(activeDownload)}>{t("pause")}</button><button className="quiet danger" onClick={() => activeDownload && cancelDownload(activeDownload)}>{t("cancel")}</button></> : model.installed ? <>{model.visionCapable && !model.projectorInstalled && <button className="quiet install" onClick={() => installManagedProjector(model)}>{t("installVision")}</button>}<button className="quiet" onClick={() => useManagedModel(model)} disabled={selected}>{selected ? t("selected") : t("useModel")}</button><button className="quiet danger" onClick={() => removeManagedModel(model)} disabled={status.phase === "ready" || selected}>{t("remove")}</button></> : <button className="quiet install" onClick={() => installManagedModel(model)} disabled={Boolean(activeDownload)}>{progress?.phase === "paused" ? t("resume") : t("install")}</button>}</div>
              </article>;
            })}</div></details>
            {installError && <p className="status-detail">{installError}</p>}
          </section>
          <details className="manual-setup"><summary>{t("advancedSetup")}</summary><section className="settings-form"><FileField label={t("runtime")} value={runtimePath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("runtime")} /><FileField label={t("model")} value={modelPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("model")} /><FileField label={t("projector")} value={projectorPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("projector")} /><div className="field-row"><label>{t("context")}<select value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))} disabled={status.phase === "ready"}><option value={4096}>4K</option><option value={8192}>8K</option><option value={16384}>16K</option><option value={32768}>32K</option></select></label><label>{t("port")}<input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={status.phase === "ready"} /></label></div><div className="compatibility-note"><strong>{t("compatibleNote")}</strong><span>{t("manualNote")}</span></div></section></details>
          {status.detail && <p className="status-detail model-status">{status.detail}</p>}{(status.phase === "ready" || status.phase === "stopping") && <div className="form-actions model-start"><button className="primary stop" onClick={stopServer} disabled={status.phase === "stopping"}>{t("stop")}</button></div>}
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
function StopIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></svg>; }
function PanelIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2" /><path d="M7.5 3v14" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>; }
function GlobeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="M4 10h12M10 4c2 2 2 10 0 12M10 4c-2 2-2 10 0 12" /></svg>; }
function FileIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h5l3 3v11H6zM11 3v4h4" /></svg>; }
function KnowledgeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5c2.3-.9 4.3-.5 6 1.1v9c-1.7-1.6-3.7-2-6-1.1zM16 5.5c-2.3-.9-4.3-.5-6 1.1v9c1.7-1.6 3.7-2 6-1.1z" /></svg>; }
function ChevronIcon() { return <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3" /></svg>; }
function ExternalIcon() { return <svg className="external" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 4 12" /></svg>; }
function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true">{icon === "chat" && <path d="M4 4.5h12v8H9l-4 3v-3H4z" />}{icon === "models" && <><path d="M4 5.5h12v9H4z" /><path d="M7 3.5v2m6-2v2M7 9h6m-6 3h4" /></>}{icon === "debug" && <><circle cx="10" cy="10" r="6" /><path d="M10 6.8v3.7m0 2.6v.1" /></>}{icon === "info" && <><circle cx="10" cy="10" r="6" /><path d="M10 9v4m0-6v.1" /></>}</svg><span>{label}</span></button>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ExternalLink({ href, children, ariaLabel }: { href: string; children: ReactNode; ariaLabel?: string }) {
  return <a href={href} aria-label={ariaLabel} onClick={(event) => { if (isTauri) { event.preventDefault(); void openUrl(href); } }} target="_blank" rel="noreferrer">{children}</a>;
}

function ModelLineage({ model, locale, showBase = true }: { model: CatalogModel; locale: Locale; showBase?: boolean }) {
  return <div className="model-lineage">
    {showBase && <span>{translate(locale, "basedOn")}: {model.baseModelName}</span>}
    <ExternalLink href={model.bonsaiUrl} ariaLabel={`${translate(locale, "viewOnHuggingFace")}: ${model.name}`}>Bonsai <ExternalIcon /></ExternalLink>
    <ExternalLink href={model.baseModelUrl} ariaLabel={`${translate(locale, "viewOnHuggingFace")}: ${model.baseModelName}`}>Qwen <ExternalIcon /></ExternalLink>
  </div>;
}
