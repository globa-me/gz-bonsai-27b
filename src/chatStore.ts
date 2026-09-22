import type { MessageMetrics } from "./chatMetrics";
import type { DocumentSource } from "./rag";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text";
  content: string;
}

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  provider?: "brave" | "tavily" | "bing-legacy";
  age?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  sources?: SearchSource[];
  documentSources?: DocumentSource[];
  metrics?: MessageMetrics;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  titleSource?: "auto" | "user";
  ragDocumentIds?: string[];
}

const databaseName = "gz-bonsai-27b";
const storeName = "workspace";
const workspaceKey = "chats-v1";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadChats(): Promise<ChatSession[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(workspaceKey);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? sanitizeChatsForStorage(request.result) : []);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function saveChats(chats: ChatSession[]): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(sanitizeChatsForStorage(chats), workspaceKey);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export function sanitizeChatsForStorage(chats: ChatSession[]): ChatSession[] {
  return chats.map((chat) => ({
    ...chat,
    messages: chat.messages.map(({ sources: _sources, ...message }) => message),
  }));
}

export function createChat(title: string): ChatSession {
  const now = Date.now();
  return { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, messages: [], titleSource: "auto", ragDocumentIds: [] };
}

export function normalizeChatTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

export function renameChatSession(chat: ChatSession, value: string): ChatSession {
  const title = normalizeChatTitle(value);
  return title ? { ...chat, title, titleSource: "user" } : chat;
}
