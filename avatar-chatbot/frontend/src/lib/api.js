const CLIENT_KEY = "avatarchat.clientId";
const TOKEN_KEY = "avatarchat.token";

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getClientId() {
  let id = localStorage.getItem(CLIENT_KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(CLIENT_KEY, id);
  }
  return id;
}

export const getToken = () => sessionStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) =>
  t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

function toWsBase(httpBase) {
  if (!httpBase) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}`;
  }
  return httpBase.replace(/^http/i, "ws");
}

export function wsUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  return `${toWsBase(API_BASE)}/ws`;
}

export function attentionWsUrl() {
  return `${toWsBase(API_BASE)}/ws/attention`;
}

async function request(path, { method = "GET", body, form } = {}) {
  const headers = { "X-Client-Id": getClientId() };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  config: () => fetch(`${API_BASE}/api/config`).then((r) => r.json()),
  listSessions: () => request("/sessions"),
  createSession: () => request("/sessions", { method: "POST" }),
  messages: (id) => request(`/sessions/${id}/messages`),
  deleteSession: (id) => request(`/sessions/${id}`, { method: "DELETE" }),
  transcribe: (blob) => {
    const form = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("file", blob, `speech.${ext}`);
    return request("/stt", { method: "POST", form });
  },

  // Document Management APIs (Partition 3)
  listDocuments: (collection) =>
    request(`/documents${collection && collection !== "all" ? `?collection=${encodeURIComponent(collection)}` : ""}`),
  uploadDocument: (formData) => request("/documents/upload", { method: "POST", form: formData }),
  getDocument: (docId) => request(`/documents/${docId}`),
  updateDocument: (docId, data) => request(`/documents/${docId}`, { method: "PUT", body: data }),
  deleteDocument: (docId) => request(`/documents/${docId}`, { method: "DELETE" }),
  queryDocuments: (query, collection = "calculus_101", topK = 3) =>
    request("/documents/query", { method: "POST", body: { query, collection, top_k: topK } }),
  listCollections: () => request("/collections"),

  // Attention Tracking APIs
  getAttentionStatus: () => request("/attention/status"),
  simulateAttention: (type, sessionId = "default") =>
    request("/attention/simulate", { method: "POST", body: { type, session_id: sessionId } }),
  postAttentionTelemetry: (telemetry) =>
    request("/attention/telemetry", { method: "POST", body: telemetry }),
};
