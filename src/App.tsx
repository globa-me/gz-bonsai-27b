import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { type Locale, translate } from "./i18n";

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

const storageKey = "bonsai-desktop-settings-v1";

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
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  useEffect(() => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ locale, runtimePath, modelPath, projectorPath, contextSize, port }),
    );
    document.documentElement.lang = locale;
  }, [locale, runtimePath, modelPath, projectorPath, contextSize, port]);

  useEffect(() => {
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
    return () => {
      void unlistenLog.then((fn) => fn());
      void unlistenStatus.then((fn) => fn());
      void unlistenToken.then((fn) => fn());
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
          <section className="settings-form"><FileField label={t("runtime")} value={runtimePath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("runtime")} /><FileField label={t("model")} value={modelPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("model")} /><FileField label={t("projector")} value={projectorPath} empty={t("notSelected")} choose={t("choose")} onChoose={() => chooseFile("projector")} /><div className="field-row"><label>{t("context")}<select value={contextSize} onChange={(event) => setContextSize(Number(event.target.value))} disabled={status.phase === "ready"}><option value={4096}>4K</option><option value={8192}>8K</option><option value={16384}>16K</option><option value={32768}>32K</option></select></label><label>{t("port")}<input type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} disabled={status.phase === "ready"} /></label></div><div className="compatibility-note"><strong>{t("compatibleNote")}</strong><span>{t("manualNote")}</span></div>{status.detail && <p className="status-detail">{status.detail}</p>}<div className="form-actions">{status.phase === "ready" || status.phase === "stopping" ? <button className="primary stop" onClick={stopServer} disabled={status.phase === "stopping"}>{t("stop")}</button> : <button className="primary" onClick={startServer} disabled={!canStart}>{status.phase === "starting" ? t("starting") : t("start")}</button>}</div></section>
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

function Logo({ small = false }: { small?: boolean }) { return <svg className={`logo ${small ? "small" : ""}`} viewBox="0 0 32 32" aria-hidden="true"><path d="M16 25V12M16 16c-4.5-5.2-9-4.5-11-3.4.8 6 5.3 8.4 10 7.2M16 12c3.5-6.3 8.5-7.2 11-6.1-.1 6.5-4.3 9.6-10.4 9.2M10 25h12" /></svg>; }
function SendIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m0 0L6 9m4-4 4 4" /></svg>; }
function ChevronIcon() { return <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3" /></svg>; }
function ExternalIcon() { return <svg className="external" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h6v6M12 4 4 12" /></svg>; }
function NavButton({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={active ? "active" : ""} onClick={onClick}><svg viewBox="0 0 20 20" aria-hidden="true">{icon === "chat" && <path d="M4 4.5h12v8H9l-4 3v-3H4z" />}{icon === "models" && <><path d="M4 5.5h12v9H4z" /><path d="M7 3.5v2m6-2v2M7 9h6m-6 3h4" /></>}{icon === "debug" && <><circle cx="10" cy="10" r="6" /><path d="M10 6.8v3.7m0 2.6v.1" /></>}{icon === "info" && <><circle cx="10" cy="10" r="6" /><path d="M10 9v4m0-6v.1" /></>}</svg><span>{label}</span></button>; }
function InfoRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
