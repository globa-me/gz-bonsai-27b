// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: {payload: unknown}) => void>(), load: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, handler) => { ipc.listeners.set(name, handler); return () => ipc.listeners.delete(name); }) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('./chatStore', async (original) => ({ ...await original<typeof import('./chatStore')>(), loadChats: ipc.load, saveChats: ipc.save }));
Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {value: function () { this.setAttribute('open',''); }, configurable:true});
const { default: App } = await import('./App');
const key = 'bonsai-desktop-settings-v1';
const root = '/test/data/managed/models';
const model = (id: string, name: string, installed = true) => ({
  id, name, filename: `${id}.gguf`, description: '', baseModelName: 'Qwen', baseModelUrl: 'https://huggingface.co/Qwen', bonsaiUrl: 'https://huggingface.co/prism-ml', sizeBytes: 1000, estimatedMemoryBytes: 8 * 1024 ** 3, contextSize: 4096,
  managedPath: `${root}/${id}/${id}.gguf`, managedProjectorPath: `${root}/${id}/vision.gguf`, installed, installedPath: installed ? `${root}/${id}/${id}.gguf` : null, visionCapable: true, projectorInstalled: installed, projectorPath: installed ? `${root}/${id}/vision.gguf` : null,
});
type Model = ReturnType<typeof model>;
let models: Model[];
let phase: string;
let removeError: boolean;
let removal: Promise<void> | null;
let installWait: Promise<unknown> | null;
let projectorError: boolean;
let streamWait: Promise<unknown> | null;
let user: ReturnType<typeof userEvent.setup>;
function settings() { return JSON.parse(localStorage.getItem(key) ?? '{}'); }
function card(name: string) { return screen.getAllByText(name).map(x => x.closest('article')).find(Boolean)!; }
async function openModels() { await user.click(screen.getByRole('button', { name: 'Модели' })); await screen.findByRole('heading', { name: 'Каталог Bonsai' }); }
async function ready() { render(<App />); await waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith('managed_catalog')); await waitFor(() => expect(ipc.save).toHaveBeenCalled()); }
async function remove(name: string) { await user.click(within(card(name)).getByRole('button', {name:'Удалить'})); await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Удалить'})); }
async function emit(name: string, payload: unknown) { await act(async () => { ipc.listeners.get(name)?.({payload}); }); }
beforeEach(() => {
  vi.clearAllMocks(); ipc.listeners.clear(); localStorage.clear(); models = [model('a', 'Model A'), model('b', 'Model B')]; phase = 'stopped'; removeError = false; removal = null; installWait = null; projectorError=false; streamWait=null; user = userEvent.setup();
  localStorage.setItem(key, JSON.stringify({locale:'ru', runtimePath:'/runtime/llama-server', modelPath:models[0].installedPath, projectorPath:models[0].projectorPath, port:18081}));
  ipc.load.mockResolvedValue([{ id:'chat1', title:'Saved chat', messages:[], createdAt:1, updatedAt:1, titleSource:'user' }]); ipc.save.mockResolvedValue(undefined);
  ipc.invoke.mockImplementation(async (command: string, args?: {request?: {modelId?: string}; config?: {modelPath: string}}) => {
    switch(command) {
      case 'managed_catalog': return { runtimeVersion:'test', runtimeInstalled:true, runtimePath:'/runtime/llama-server', models: structuredClone(models) };
      case 'server_status': return {phase, port:18081};
      case 'system_info': return { appVersion:'0.6.6', architecture:'aarch64', macosVersion:'26.5', chip:'Test Mac', memoryBytes:18*1024**3, freeDiskBytes:100*1024**3 };
      case 'diagnostic_snapshot': return [];
      case 'search_provider_status': return {provider:'tavily', braveConfigured:false, keylessAvailable:true};
      case 'remove_model': {
        if (removal) await removal;
        if (removeError) throw new Error('Removal denied');
        models = models.map(m => m.id === args?.request?.modelId ? {...m, installed:false, installedPath:null, projectorInstalled:false, projectorPath:null} : m); return;
      }
      case 'start_server': phase='ready'; return {phase, port:18081, modelName: args?.config?.modelPath.split('/').pop()};
      case 'stop_server': phase='stopped'; return {phase, port:18081};
      case 'install_runtime': return '/runtime/llama-server';
      case 'install_model': {
        if (installWait) return installWait;
        const next=model(args?.request?.modelId ?? 'a', models.find(m=>m.id===args?.request?.modelId)?.name ?? 'Model A');
        models=models.map(m=>m.id===next.id?{...next,projectorInstalled:false,projectorPath:null}:m); return next.installedPath;
      }
      case 'install_projector': if(projectorError) throw new Error('Vision download failed'); return `${root}/${args?.request?.modelId}/vision.gguf`;
      case 'stream_chat': return streamWait;
      default: return undefined;
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('rendered model management', () => {
  it('deletes the selected and then the last installed model without selecting another', async () => {
    await ready(); await openModels();
    await remove('Model A');
    await waitFor(() => expect(settings().modelPath).toBe(''));
    expect(settings().projectorPath).toBe('');
    await remove('Model B');
    await waitFor(() => expect(models.every(m => !m.installed)).toBe(true));
    expect(screen.getByRole('button', {name:'Saved chat'})).toBeTruthy();
    expect(ipc.invoke.mock.calls.filter(([cmd]) => cmd==='start_server')).toHaveLength(0);
  });
  it('keeps files and configuration when confirmation is cancelled', async () => {
    await ready(); await openModels();
    await user.click(within(card('Model A')).getByRole('button',{name:'Удалить'}));
    expect(ipc.invoke.mock.calls.some(([cmd])=>cmd==='remove_model')).toBe(false);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Отменить'}));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(ipc.invoke.mock.calls.some(([cmd]) => cmd==='remove_model')).toBe(false);
    expect(settings().modelPath).toBe(models[0].installedPath);
  });
  it('shows removal error without losing the selected model or projector', async () => {
    removeError=true; await ready(); await openModels(); await remove('Model A');
    await screen.findByText('Error: Removal denied'); expect(settings().modelPath).toBe(models[0].installedPath); expect(settings().projectorPath).toBe(models[0].projectorPath);
  });
  it.each(['starting','ready','stopping'])('blocks deletion during server %s', async (state) => {
    phase=state; await ready(); await openModels();
    expect((within(card('Model A')).getByRole('button', {name:'Удалить'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('stops from the model page and enables deletion without returning to chat', async () => {
    phase='ready'; await ready(); await openModels(); await user.click(screen.getByRole('button',{name:'Остановить модель'}));
    await waitFor(()=>expect((within(card('Model A')).getByRole('button',{name:'Удалить'}) as HTMLButtonElement).disabled).toBe(false));
    await remove('Model A'); await waitFor(()=>expect(settings().modelPath).toBe(''));
  });
  it('locks model actions until deletion finishes, preventing start/delete races', async () => {
    let finish!: () => void; removal=new Promise(resolve => {finish=resolve;}); await ready(); await openModels();
    await remove('Model A');
    expect((within(card('Model B')).getByRole('button', {name:'Выбрать'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', {name:'Запустить модель'}) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {finish();}); await waitFor(() => expect(settings().modelPath).toBe(''));
  });
  it('clears a missing managed selection but preserves a custom external GGUF', async () => {
    models=models.map(m=>({...m,installed:false,installedPath:null,projectorPath:null})); await ready();
    await waitFor(() => expect(settings().modelPath).toBe('')); expect(settings().projectorPath).toBe(''); cleanup();
    localStorage.setItem(key,JSON.stringify({locale:'ru',modelPath:'/custom/managed/models/a/a.gguf',runtimePath:'/custom/llama-server',projectorPath:'/custom/vision.gguf'}));
    await ready(); expect(settings().modelPath).toBe('/custom/managed/models/a/a.gguf'); expect(settings().projectorPath).toBe('/custom/vision.gguf');
  });
  it('clears only a missing managed vision projector', async () => {
    models[0].projectorInstalled=false; models[0].projectorPath=null; await ready(); await waitFor(()=>expect(settings().projectorPath).toBe('')); expect(settings().modelPath).toBe(models[0].installedPath);
  });
  it('refreshes a removed selection when returning to models', async () => {
    await ready(); models=models.map(m=>m.id==='a'?{...m,installed:false,installedPath:null,projectorPath:null}:m); await openModels(); await waitFor(() => expect(settings().modelPath).toBe(''));
  });
  it('runs install, pause, resume and cancel from actual controls', async () => {
    models=[model('a','Model A',false), model('b','Model B',false)]; localStorage.setItem(key,JSON.stringify({locale:'ru'}));
    let rejectInstall!: (error: Error) => void; installWait=new Promise((_resolve,reject)=>{rejectInstall=reject;}); await ready(); await openModels();
    await user.click(screen.getAllByRole('button',{name:'Скачать'})[0]);
    await emit('download-progress',{id:'a',phase:'downloading',downloadedBytes:200,totalBytes:1000});
    await user.click(within(card('Model A')).getByRole('button',{name:'Пауза'})); expect(ipc.invoke).toHaveBeenCalledWith('pause_install',{id:'a'});
    await emit('download-progress',{id:'a',phase:'paused',downloadedBytes:200,totalBytes:1000});
    await act(async()=>rejectInstall(new Error('Download paused')));
    installWait=new Promise(()=>{});
    await user.click(within(card('Model A')).getByRole('button',{name:'Продолжить'}));
    await user.click(within(card('Model A')).getByRole('button',{name:'Отменить'})); expect(ipc.invoke).toHaveBeenCalledWith('cancel_install',{id:'a'});
  });
  it('keeps a downloaded GGUF usable when its vision download fails', async () => {
    models=[model('a','Model A',false)]; localStorage.setItem(key,JSON.stringify({locale:'ru'})); projectorError=true;
    await ready(); await openModels(); await user.click(within(card('Model A')).getByRole('button',{name:'Скачать'}));
    await screen.findByText('Error: Vision download failed'); await waitFor(()=>expect(settings().modelPath).toBe(`${root}/a/a.gguf`));
    expect(settings().projectorPath).toBe(''); expect((screen.getByRole('button',{name:'Запустить модель'}) as HTMLButtonElement).disabled).toBe(false);
    expect(within(card('Model A')).getByRole('button',{name:'Удалить'})).toBeTruthy();
  });
  it('blocks all deletions while a model is downloading', async () => {
    models.push(model('c','Model C',false)); installWait=new Promise(()=>{}); await ready(); await openModels();
    await user.click(within(card('Model C')).getByRole('button',{name:'Скачать'})); await waitFor(()=>expect(ipc.invoke).toHaveBeenCalledWith('install_model',{request:{modelId:'c'}}));
    expect((within(card('Model A')).getByRole('button',{name:'Удалить'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('switches the running model through chat by stopping before starting', async () => {
    phase='ready'; await ready(); await user.click(document.querySelector('.model-picker')!);
    await user.click(screen.getByRole('button',{name:/Model B/}));
    await waitFor(()=>expect(ipc.invoke).toHaveBeenCalledWith('start_server',expect.anything()));
    const commands=ipc.invoke.mock.calls.map(([cmd])=>cmd); expect(commands.indexOf('stop_server')).toBeLessThan(commands.indexOf('start_server')); expect(settings().modelPath).toBe(models[1].installedPath);
  });
});

describe('rendered navigation and chat history', () => {
  it.each(['null', '[]', '{"locale":"bad","modelPath":123,"port":0}'])('recovers from invalid stored settings: %s', async (value) => {
    localStorage.setItem(key, value); await ready(); expect(document.querySelector('.app-shell')).toBeTruthy(); expect(settings().port).toBe(8080);
  });
  it('keeps working when settings storage rejects writes', async () => {
    vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Quota exceeded');});
    await ready(); await user.click(screen.getByRole('button',{name:'Модели'})); expect(screen.getByRole('heading',{name:'Модели на этом Mac'})).toBeTruthy();
  });
  it('streams, stops and retries an answer while preserving the user message and partial text', async () => {
    phase='ready'; let reject!: (error:Error)=>void; streamWait=new Promise((_resolve,rejectPromise)=>{reject=rejectPromise;}); await ready();
    await user.type(screen.getByRole('textbox'),'Test prompt'); await user.click(screen.getByRole('button',{name:'Отправить'}));
    await waitFor(()=>expect(ipc.invoke.mock.calls.some(([cmd])=>cmd==='stream_chat')).toBe(true));
    const call=ipc.invoke.mock.calls.find(([cmd])=>cmd==='stream_chat')!; const requestId=call[1].request.requestId;
    await emit('chat-token',{requestId,content:'Partial answer'}); await screen.findByText('Partial answer');
    await user.click(screen.getByRole('button',{name:'Остановить ответ'})); expect(ipc.invoke).toHaveBeenCalledWith('cancel_chat',{requestId});
    await act(async()=>reject(new Error('CHAT_CANCELLED'))); await screen.findByText('Генерация остановлена.'); expect(screen.getByText('Partial answer')).toBeTruthy();
    streamWait=Promise.resolve(null); await user.click(screen.getByRole('button',{name:'Повторить ответ'}));
    await waitFor(()=>expect(ipc.invoke.mock.calls.filter(([cmd])=>cmd==='stream_chat')).toHaveLength(2)); expect(screen.getAllByText('Test prompt')).toHaveLength(1);
  });

  it('switches RU/EN, hides/restores sidebar and navigates all pages', async () => {
    await ready(); await user.click(screen.getByRole('button',{name:'EN'})); await user.click(screen.getByRole('button',{name:'Models'})); await screen.findByRole('heading',{name:'Models on this Mac'});
    await user.click(screen.getByRole('button',{name:'Hide sidebar'})); expect(document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')).toBe(true);
    await user.click(screen.getByRole('button',{name:'Show sidebar'})); await user.click(screen.getByRole('button',{name:'Diagnostics'})); await screen.findByRole('heading',{name:'Diagnostics'});
    await user.click(screen.getByRole('button',{name:'About'})); expect(document.querySelector('.about-page')).toBeTruthy(); await user.click(screen.getByRole('button',{name:'RU'})); expect(document.documentElement.lang).toBe('ru');
  });
  it('preserves streamed tokens arriving while another chat deletion is being confirmed', async () => {
    phase='ready'; streamWait=new Promise(()=>{});
    ipc.load.mockResolvedValue([{id:'chat1',title:'Active',messages:[],createdAt:1,updatedAt:2,titleSource:'user'},{id:'chat2',title:'Other',messages:[],createdAt:1,updatedAt:1}]);
    await ready(); await user.type(screen.getByRole('textbox'),'Test'); await user.click(screen.getByRole('button',{name:'Отправить'}));
    await waitFor(()=>expect(ipc.invoke.mock.calls.some(([cmd])=>cmd==='stream_chat')).toBe(true));
    const requestId=ipc.invoke.mock.calls.find(([cmd])=>cmd==='stream_chat')![1].request.requestId;
    await user.click(screen.getByRole('button',{name:'Удалить чат: Other'})); await emit('chat-token',{requestId,content:'Arrived during confirmation'});
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Удалить'})); expect(screen.getByText('Arrived during confirmation')).toBeTruthy(); expect(screen.queryByRole('button',{name:'Other'})).toBeNull();
  });
  it('cancels chat deletion using an explicit dialog', async () => {
    await ready(); await user.click(screen.getByRole('button',{name:'Удалить чат: Saved chat'}));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Отменить'})); expect(screen.getByRole('button',{name:'Saved chat'})).toBeTruthy();
  });
  it('requires explicit confirmation for local document deletion and preserves chat history', async () => {
    ipc.load.mockResolvedValue([{id:'chat1',title:'Saved chat',messages:[],createdAt:1,updatedAt:1,ragDocumentIds:['doc1']}]);
    const original=ipc.invoke.getMockImplementation()!;
    ipc.invoke.mockImplementation(async (command,args)=>command==='list_rag_documents'?[{id:'doc1',name:'Test.txt'}]:original(command,args));
    await ready(); await waitFor(()=>expect(document.querySelector('.rag-documents')).toBeTruthy()); await user.click(document.querySelector('.rag-documents summary')!);
    await user.click(screen.getByRole('button',{name:'Удалить с устройства: Test.txt'}));
    expect(ipc.invoke.mock.calls.some(([cmd])=>cmd==='remove_rag_document')).toBe(false);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Отменить'}));
    await user.click(screen.getByRole('button',{name:'Удалить с устройства: Test.txt'})); await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Удалить'}));
    await waitFor(()=>expect(ipc.invoke).toHaveBeenCalledWith('remove_rag_document',{request:{documentId:'doc1'}})); expect(screen.getByRole('button',{name:'Saved chat'})).toBeTruthy();
  });
  it('renames and deletes a chat without deleting models', async () => {
    await ready(); await user.click(screen.getByRole('button',{name:'Переименовать чат: Saved chat'}));
    const input=screen.getByRole('textbox', {name:'Переименовать чат'}) as HTMLInputElement; await user.clear(input); await user.type(input,'Renamed{Enter}');
    await screen.findByRole('button',{name:'Renamed'}); await user.click(screen.getByRole('button',{name:'Удалить чат: Renamed'})); await user.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Удалить'})); await waitFor(()=>expect(screen.queryByRole('button',{name:'Renamed'})).toBeNull()); expect(models.every(m=>m.installed)).toBe(true);
  });
});
