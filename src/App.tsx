import { useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type Locale, translate } from "./i18n";
import appIcon from "./assets/app-icon.png";
import { MarkdownMessage } from "./MarkdownMessage";
import { createChat, loadChats, saveChats, type Attachment, type ChatMessage, type ChatSession, type SearchSource } from "./chatStore";

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
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [searching, setSearching] = useState(false);
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

  async function refreshCatalog() {
    const next = await invoke<ManagedCatalog>("managed_catalog");
    setCatalog(next);
    if (next.runtimePath) setRuntimePath((current: string) => current || next.runtimePath || "");
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
        const initial = stored.length ? stored : [createChat(translate(locale, "untitledChat"))];
        setChats(initial);
        setActiveChatId(initial[0].id);
      })
      .catch(() => {
        const initial = createChat(translate(locale, "untitledChat"));
        setChats([initial]);
        setActiveChatId(initial.id);
      })
      .finally(() => setHistoryLoaded(true));
  }, []);

  useEffect(() => {
    if (historyLoaded) void saveChats(chats);
  }, [chats, historyLoaded]);

  useEffect(() => {
    if (!isTauri) {
      setSystemInfo({ appVersion: "0.2.0", architecture: "aarch64", macosVersion: "26.5", chip: "Apple M3 Pro", memoryBytes: 18 * 1024 ** 3, freeDiskBytes: 115 * 1024 ** 3 });
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
    invoke<ServerStatus>("server_status").then(setStatus).catch(() => undefined);
    invoke<SystemInfo>("system_info").then(setSystemInfo).catch(() => undefined);
    void refreshCatalog().catch((error) => setInstallError(String(error)));
    return () => {
      void unlistenLog.then((fn) => fn());
      void unlistenStatus.then((fn) => fn());
      void unlistenToken.then((fn) => fn());
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

  async function copyDiagnosticReport() {
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
      "Recent runtime log:",
      ...logs.slice(-80),
    ].join("\n");
    await navigator.clipboard.writeText(safeReport);
    setReportCopied(true);
    window.setTimeout(() => setReportCopied(false), 1800);
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
    } catch (error) {
      setStatus({ phase: "error", port, detail: String(error) });
    }
  }

  async function stopServer() {
    setStatus({ phase: "stopping", port });
    try {
      setStatus(await invoke<ServerStatus>("stop_server"));
    } catch (error) {
      setStatus({ phase: "error", port, detail: String(error) });
    }
  }

  async function installManagedModel(model: CatalogModel) {
    setInstallError(null);
    setActiveDownload(model.id);
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
    } catch (error) {
      const message = String(error).toLowerCase();
      if (!message.includes("cancel") && !message.includes("paused")) setInstallError(String(error));
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
    try {
      const paths = Array.isArray(selected) ? selected : [selected];
      const payloads = await Promise.all(paths.map((path) => invoke<AttachmentPayload>("read_attachment", { request: { path } })));
      const attachments = payloads.map((payload) => ({ ...payload, id: crypto.randomUUID() }));
      setPendingAttachments((current) => [...current, ...attachments].slice(0, 6));
    } catch (error) {
      setAttachmentError(String(error));
    }
  }

  function updateChatMessages(chatId: string, update: (messages: ChatMessage[]) => ChatMessage[], title?: string) {
    setChats((current) => current.map((chat) => chat.id === chatId
      ? { ...chat, title: title ?? chat.title, updatedAt: Date.now(), messages: update(chat.messages) }
      : chat));
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
    const sources = webSearchEnabled && content
      ? await (async () => {
        setSearching(true);
        try {
          return await invoke<WebSearchResult[]>("web_search", { request: { query: content, limit: 5 } });
        } catch (error) {
          setAttachmentError(String(error));
          return [];
        } finally {
          setSearching(false);
        }
      })()
      : [];
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content, attachments: pendingAttachments };
    const assistantMessage: ChatMessage = { id: requestId, role: "assistant", content: "" };
    const history: Array<{ role: string; content: unknown }> = [...activeChat.messages, userMessage]
      .map((message) => ({ role: message.role, content: apiContent(message) }));
    if (sources.length) {
      history.push({
        role: "user",
        content: `${t("webResultsInstruction")}\n${sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet}`).join("\n\n")}`,
      });
      assistantMessage.sources = sources;
    }
    const nextTitle = activeChat.messages.length === 0 && content
      ? content.replace(/\s+/g, " ").slice(0, 42)
      : undefined;
    updateChatMessages(chatId, (current) => [...current, userMessage, assistantMessage], nextTitle);
    setDraft("");
    setPendingAttachments([]);
    setAttachmentError(null);
    setActiveRequest(requestId);
    try {
      await invoke("stream_chat", { request: { requestId, port, messages: history } });
    } catch (error) {
      updateChatMessages(chatId, (current) => current.map((message) =>
          message.id === requestId ? { ...message, content: String(error) } : message,
        ));
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
          <div>{[...chats].sort((a, b) => b.updatedAt - a.updatedAt).map((chat) => <button key={chat.id} className={view === "chat" && activeChatId === chat.id ? "active" : ""} onClick={() => { setActiveChatId(chat.id); setView("chat"); }}>{chat.title}</button>)}</div>
        </div>
        <div className="sidebar-footer">
          <div className="privacy"><span className="privacy-dot" />{t("privacy")}</div>
          <div className="locale-switch" aria-label="Language">{(["ru", "en"] as const).map((item) => <button className={locale === item ? "active" : ""} onClick={() => setLocale(item)} key={item}>{item.toUpperCase()}</button>)}</div>
          <ExternalLink href="https://zakharov.asia/ru/">{t("developedBy")} <ExternalIcon /></ExternalLink>
        </div>
      </aside>
      <section className="main-pane">
        {view === "chat" && <>
          <header className="pane-bar"><button className="model-picker" onClick={() => setView("models")}><Logo small /><span><small>{t("localModel")}</small>{status.modelName ?? (modelPath ? fileName(modelPath) : t("notSelected"))}</span><ChevronIcon /></button><details className="status-menu"><summary className={`status ${status.phase}`}><i /><span>{phaseLabel}</span><ChevronIcon /></summary><div className="status-popover"><InfoRow label={t("currentModel")} value={status.modelName ?? (modelPath ? fileName(modelPath) : t("notSelected"))} /><InfoRow label={t("backend")} value={status.backend ?? t("metalBackend")} /><InfoRow label={t("processMemory")} value={status.memoryBytes ? formatBytes(status.memoryBytes, locale) : "—"} /><InfoRow label={t("context")} value={status.contextSize ? `${Math.round(status.contextSize / 1024)}K` : "—"} /><InfoRow label="Endpoint" value={`127.0.0.1:${status.port}`} />{status.phase === "ready" && <button className="stop-inline" onClick={stopServer}>{t("stopModel")}</button>}</div></details></header>
          <div className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}>
            {messages.length === 0 ? <div className="welcome"><Logo /><h1>{status.phase === "ready" ? t("chatWelcome") : t("chooseModelFirst")}</h1>{status.phase !== "ready" && <button onClick={() => setView("models")}>{t("openModels")}</button>}</div> : messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="avatar">{message.role === "user" ? "GZ" : <Logo small />}</div><div className="message-body"><div className="message-role">{message.role === "user" ? t("you") : t("assistant")}</div>{message.attachments?.length ? <div className="message-attachments">{message.attachments.map((attachment) => attachment.kind === "image" ? <img key={attachment.id} src={attachment.content} alt={attachment.name} /> : <span key={attachment.id}>{attachment.name}</span>)}</div> : null}{message.role === "assistant" ? <MarkdownMessage>{message.content || (activeRequest === message.id ? t("generating") : "")}</MarkdownMessage> : <div className="plain-message">{message.content}</div>}{message.sources?.length ? <div className="sources"><small>{t("sources")}</small>{message.sources.map((source, index) => <ExternalLink href={source.url} key={source.url}>{index + 1}. {source.title}</ExternalLink>)}</div> : null}</div></article>)}
          </div>
          <div className="composer-wrap">{pendingAttachments.length ? <div className="pending-attachments">{pendingAttachments.map((attachment) => <span key={attachment.id}>{attachment.kind === "image" ? <img src={attachment.content} alt="" /> : <FileIcon />}<span>{attachment.name}</span><button onClick={() => setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))} aria-label={t("removeAttachment")}>×</button></span>)}</div> : null}{attachmentError && <div className="composer-error">{attachmentError}</div>}<div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={t("placeholder")} disabled={status.phase !== "ready" || Boolean(activeRequest)} rows={2} /><div className="composer-actions"><button className="tool-button" onClick={chooseAttachments} disabled={status.phase !== "ready" || Boolean(activeRequest)} aria-label={t("attachFiles")} title={t("attachFiles")}><PlusIcon /></button><button className={`tool-button search-toggle ${webSearchEnabled ? "active" : ""}`} onClick={() => setWebSearchEnabled((value) => !value)} disabled={Boolean(activeRequest)} aria-pressed={webSearchEnabled} title={t("webSearchDisclosure")}><GlobeIcon /></button><button className="send-button" onClick={sendMessage} disabled={(!draft.trim() && !pendingAttachments.length) || status.phase !== "ready" || Boolean(activeRequest) || searching} aria-label={t("send")}><SendIcon /></button></div></div>{webSearchEnabled && <div className="search-disclosure">{searching ? t("searchingWeb") : t("webSearchDisclosure")}</div>}</div>
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
        {view === "diagnostics" && <div className="content-page narrow"><header className="page-heading"><div><h1>{t("diagnostics")}</h1><p>{t("debugPrivacy")}</p></div><button className="primary" onClick={copyDiagnosticReport}>{reportCopied ? t("reportCopied") : t("copyReport")}</button></header><div className="diagnostic-list"><InfoRow label={t("system")} value={`${systemInfo?.chip ?? "—"} · ${systemInfo?.architecture ?? "—"} · macOS ${systemInfo?.macosVersion ?? "—"}`} /><InfoRow label={t("memory")} value={formatBytes(systemInfo?.memoryBytes ?? 0, locale)} /><InfoRow label={t("disk")} value={formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)} /><InfoRow label={t("localModel")} value={modelPath ? fileName(modelPath) : t("notSelected")} /><InfoRow label="Endpoint" value={`http://127.0.0.1:${port}/v1`} /></div><details className="logs"><summary>{t("logs")}<button onClick={(event) => { event.preventDefault(); setLogs([]); }}>{t("clear")}</button></summary><pre>{logs.join("\n") || "—"}</pre></details></div>}
        {view === "about" && <div className="content-page narrow about-page"><Logo /><h1>{t("aboutTitle")}</h1><p>{t("aboutText")}</p><div className="about-links"><ExternalLink href="https://zakharov.asia/ru/">{t("website")} <ExternalIcon /></ExternalLink><ExternalLink href="https://github.com/globa-me/gz-bonsai-27b">{t("sourceCode")} <ExternalIcon /></ExternalLink></div><small>{t("developedBy")}</small></div>}
      </section>
    </main>
  );
}

function FileField({ label, value, empty, choose, onChoose }: { label: string; value: string; empty: string; choose: string; onChoose: () => void }) {
  return <div className="file-field"><label>{label}</label><button onClick={onChoose}><span className={value ? "" : "placeholder"}>{value ? fileName(value) : empty}</span><strong>{choose}</strong></button></div>;
}

function Logo({ small = false }: { small?: boolean }) { return <img className={`logo ${small ? "small" : ""}`} src={appIcon} alt="" aria-hidden="true" />; }
function SendIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6 9m4-4 4 4" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>; }
function GlobeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="M4 10h12M10 4c2 2 2 10 0 12M10 4c-2 2-2 10 0 12" /></svg>; }
function FileIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3h5l3 3v11H6zM11 3v4h4" /></svg>; }
function ChevronIcon() { return <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3" /></svg>; }
function ExternalIcon() { return <svg className="external" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 4 12" /></svg>; }
function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true">{icon === "chat" && <path d="M4 4.5h12v8H9l-4 3v-3H4z" />}{icon === "models" && <><path d="M4 5.5h12v9H4z" /><path d="M7 3.5v2m6-2v2M7 9h6m-6 3h4" /></>}{icon === "debug" && <><circle cx="10" cy="10" r="6" /><path d="M10 6.8v3.7m0 2.6v.1" /></>}{icon === "info" && <><circle cx="10" cy="10" r="6" /><path d="M10 9v4m0-6v.1" /></>}</svg><span>{label}</span></button>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} onClick={(event) => { if (isTauri) { event.preventDefault(); void openUrl(href); } }} target="_blank" rel="noreferrer">{children}</a>;
}
