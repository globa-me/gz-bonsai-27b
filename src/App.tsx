import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { type Locale, translate } from "./i18n";
import appIcon from "./assets/app-icon.svg";

type ServerPhase = "stopped" | "starting" | "ready" | "stopping" | "error";
type Role = "user" | "assistant";
type View = "chat" | "models" | "diagnostics" | "about";

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
}

interface ServerStatus {
  phase: ServerPhase;
  port: number;
  detail?: string | null;
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [activeRequest, setActiveRequest] = useState<string | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [reportCopied, setReportCopied] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [catalog, setCatalog] = useState<ManagedCatalog | null>(null);
  const [activeDownload, setActiveDownload] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({});
  const [installError, setInstallError] = useState<string | null>(null);
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

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
      setMessages((current) =>
        current.map((message) =>
          message.id === payload.requestId
            ? { ...message, content: message.content + payload.content }
            : message,
        ),
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
      setRuntimePath(managedRuntime);
      setModelPath(installedModel);
      setProjectorPath("");
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

  function useManagedModel(model: CatalogModel) {
    if (!model.installedPath || !catalog?.runtimePath) return;
    setRuntimePath(catalog.runtimePath);
    setModelPath(model.installedPath);
    setProjectorPath("");
    setContextSize(model.contextSize);
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!content || activeRequest || status.phase !== "ready") return;
    const requestId = crypto.randomUUID();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content };
    const assistantMessage: ChatMessage = { id: requestId, role: "assistant", content: "" };
    const history = [...messages, userMessage].map(({ role, content: text }) => ({ role, content: text }));
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setDraft("");
    setActiveRequest(requestId);
    try {
      await invoke("stream_chat", { request: { requestId, port, messages: history } });
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === requestId ? { ...message, content: String(error) } : message,
        ),
      );
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
          <NavButton icon="chat" label={t("navChat")} active={view === "chat"} onClick={() => setView("chat")} />
          <NavButton icon="models" label={t("navModels")} active={view === "models"} onClick={() => setView("models")} />
          <NavButton icon="debug" label={t("navDiagnostics")} active={view === "diagnostics"} onClick={() => setView("diagnostics")} />
          <NavButton icon="info" label={t("navAbout")} active={view === "about"} onClick={() => setView("about")} />
        </nav>
        <div className="sidebar-footer">
          <div className="privacy"><span className="privacy-dot" />{t("privacy")}</div>
          <div className="locale-switch" aria-label="Language">{(["ru", "en"] as const).map((item) => <button className={locale === item ? "active" : ""} onClick={() => setLocale(item)} key={item}>{item.toUpperCase()}</button>)}</div>
          <a href="https://zakharov.asia/" target="_blank" rel="noreferrer">{t("developedBy")} <ExternalIcon /></a>
        </div>
      </aside>
      <section className="main-pane">
        {view === "chat" && <>
          <header className="pane-bar"><button className="model-picker" onClick={() => setView("models")}><Logo small /><span><small>{t("localModel")}</small>{modelPath ? fileName(modelPath) : t("notSelected")}</span><ChevronIcon /></button><div className={`status ${status.phase}`}><i /><span>{phaseLabel}</span></div></header>
          <div className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}>
            {messages.length === 0 ? <div className="welcome"><Logo /><h1>{status.phase === "ready" ? t("chatWelcome") : t("chooseModelFirst")}</h1>{status.phase !== "ready" && <button onClick={() => setView("models")}>{t("openModels")}</button>}</div> : messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="avatar">{message.role === "user" ? "GZ" : <Logo small />}</div><div><div className="message-role">{message.role === "user" ? t("you") : t("assistant")}</div><div>{message.content || (activeRequest === message.id ? t("generating") : "")}</div></div></article>)}
          </div>
          <div className="composer-wrap"><div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={t("placeholder")} disabled={status.phase !== "ready" || Boolean(activeRequest)} rows={2} /><button onClick={sendMessage} disabled={!draft.trim() || status.phase !== "ready" || Boolean(activeRequest)} aria-label={t("send")}><SendIcon /></button></div></div>
        </>}
        {view === "models" && <div className="content-page">
          <header className="page-heading"><div><h1>{t("modelsTitle")}</h1><p>{t("modelsDescription")}</p></div><div className={`status ${status.phase}`}><i /><span>{phaseLabel}</span></div></header>
          <div className="system-strip"><div><small>{t("system")}</small><strong>{systemInfo?.chip ?? "—"}</strong><span>{systemInfo?.architecture ?? "—"} · macOS {systemInfo?.macosVersion ?? "—"}</span></div><div><small>{t("memory")}</small><strong>{formatBytes(systemInfo?.memoryBytes ?? 0, locale)}</strong></div><div><small>{t("disk")}</small><strong>{formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)}</strong></div></div>
          <section className="catalog-section">
            <div className="section-heading"><div><h2>{t("catalogTitle")}</h2><p>{t("catalogDescription")}</p></div>{catalog && <span className={`runtime-pill ${catalog.runtimeInstalled ? "ready" : ""}`}>{catalog.runtimeInstalled ? t("runtimeIncluded") : t("runtimeMissing")}</span>}</div>
            <div className="model-grid">{catalog?.models.map((model) => {
              const progress = downloadProgress[model.id];
              const isActive = activeDownload === model.id;
              const percent = progress?.totalBytes ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : 0;
              const selected = model.installedPath === modelPath;
              return <article className={`model-card ${recommendedModel?.id === model.id ? "recommended" : ""}`} key={model.id}>
                <div className="model-card-title"><div><strong>{model.name}</strong>{recommendedModel?.id === model.id && <span>{t("recommended")}</span>}</div><small>{formatBytes(model.sizeBytes, locale)}</small></div>
                <p>{model.id.includes("1.7b") ? t("modelHint17") : model.id.includes("4b") ? t("modelHint4") : model.id.includes("8b") ? t("modelHint8") : model.id === "bonsai-27b-q1" ? t("modelHint1bit") : model.id.includes("ptq1") ? t("modelHintTernaryCompact") : t("modelHintTernaryFast")}</p>
                <div className="model-meta"><span>{t("memoryEstimate")}: {formatBytes(model.estimatedMemoryBytes, locale)}+</span><span>{t("context")}: {model.contextSize / 1024}K</span></div>
                {isActive && progress && <div className="download-state"><div><span>{progress.phase === "verifying" ? t("verifying") : t("downloading")}</span><strong>{percent}%</strong></div><progress max="100" value={percent} /></div>}
                <div className="model-actions">{isActive ? <><button className="quiet" onClick={() => pauseDownload(model.id)}>{t("pause")}</button><button className="quiet danger" onClick={() => cancelDownload(model.id)}>{t("cancel")}</button></> : model.installed ? <><button className="quiet" onClick={() => useManagedModel(model)} disabled={selected}>{selected ? t("selected") : t("useModel")}</button><button className="quiet danger" onClick={() => removeManagedModel(model)} disabled={status.phase === "ready" || selected}>{t("remove")}</button></> : <button className="quiet install" onClick={() => installManagedModel(model)} disabled={Boolean(activeDownload)}>{progress?.phase === "paused" ? t("resume") : t("install")}</button>}</div>
              </article>;
            })}</div>
            {installError && <p className="status-detail">{installError}</p>}
          </section>
          <details className="manual-setup"><summary>{t("advancedSetup")}</summary><section className="settings-form"><FileField label={t("runtime")} value={runtimePath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("runtime")} /><FileField label={t("model")} value={modelPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("model")} /><FileField label={t("projector")} value={projectorPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("projector")} /><div className="field-row"><label>{t("context")}<select value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))} disabled={status.phase === "ready"}><option value={4096}>4K</option><option value={8192}>8K</option><option value={16384}>16K</option><option value={32768}>32K</option></select></label><label>{t("port")}<input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={status.phase === "ready"} /></label></div><div className="compatibility-note"><strong>{t("compatibleNote")}</strong><span>{t("manualNote")}</span></div></section></details>
          {status.detail && <p className="status-detail model-status">{status.detail}</p>}<div className="form-actions model-start">{status.phase === "ready" || status.phase === "stopping" ? <button className="primary stop" onClick={stopServer} disabled={status.phase === "stopping"}>{t("stop")}</button> : <button className="primary" onClick={startServer} disabled={!canStart}>{status.phase === "starting" ? t("starting") : t("start")}</button>}</div>
        </div>}
        {view === "diagnostics" && <div className="content-page narrow"><header className="page-heading"><div><h1>{t("diagnostics")}</h1><p>{t("debugPrivacy")}</p></div><button className="primary" onClick={copyDiagnosticReport}>{reportCopied ? t("reportCopied") : t("copyReport")}</button></header><div className="diagnostic-list"><InfoRow label={t("system")} value={`${systemInfo?.chip ?? "—"} · ${systemInfo?.architecture ?? "—"} · macOS ${systemInfo?.macosVersion ?? "—"}`} /><InfoRow label={t("memory")} value={formatBytes(systemInfo?.memoryBytes ?? 0, locale)} /><InfoRow label={t("disk")} value={formatBytes(systemInfo?.freeDiskBytes ?? 0, locale)} /><InfoRow label={t("localModel")} value={modelPath ? fileName(modelPath) : t("notSelected")} /><InfoRow label="Endpoint" value={`http://127.0.0.1:${port}/v1`} /></div><details className="logs"><summary>{t("logs")}<button onClick={(event) => { event.preventDefault(); setLogs([]); }}>{t("clear")}</button></summary><pre>{logs.join("\n") || "—"}</pre></details></div>}
        {view === "about" && <div className="content-page narrow about-page"><Logo /><h1>{t("aboutTitle")}</h1><p>{t("aboutText")}</p><div className="about-links"><a href="https://zakharov.asia/" target="_blank" rel="noreferrer">{t("website")} <ExternalIcon /></a><a href="https://github.com/globa-me/gz-bonsai-27b" target="_blank" rel="noreferrer">{t("sourceCode")} <ExternalIcon /></a></div><small>{t("developedBy")}</small></div>}
      </section>
    </main>
  );
}

function FileField({ label, value, empty, choose, onChoose }: { label: string; value: string; empty: string; choose: string; onChoose: () => void }) {
  return <div className="file-field"><label>{label}</label><button onClick={onChoose}><span className={value ? "" : "placeholder"}>{value ? fileName(value) : empty}</span><strong>{choose}</strong></button></div>;
}

function Logo({ small = false }: { small?: boolean }) { return <img className={`logo ${small ? "small" : ""}`} src={appIcon} alt="" aria-hidden="true" />; }
function SendIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6 9m4-4 4 4" /></svg>; }
function ChevronIcon() { return <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3" /></svg>; }
function ExternalIcon() { return <svg className="external" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 4 12" /></svg>; }
function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true">{icon === "chat" && <path d="M4 4.5h12v8H9l-4 3v-3H4z" />}{icon === "models" && <><path d="M4 5.5h12v9H4z" /><path d="M7 3.5v2m6-2v2M7 9h6m-6 3h4" /></>}{icon === "debug" && <><circle cx="10" cy="10" r="6" /><path d="M10 6.8v3.7m0 2.6v.1" /></>}{icon === "info" && <><circle cx="10" cy="10" r="6" /><path d="M10 9v4m0-6v.1" /></>}</svg><span>{label}</span></button>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
