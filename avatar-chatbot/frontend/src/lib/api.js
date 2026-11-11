const CLIENT_KEY = "avatarchat.clientId";
const TOKEN_KEY = "avatarchat.token";
const LOCAL_DOCS_KEY = "avatarchat.localDocs.v1";
const LOCAL_SESSIONS_KEY = "avatarchat.localSessions.v1";
const LOCAL_MESSAGES_KEY = "avatarchat.localMessages.v1";

function normalizeApiBase(raw) {
  const trimmed = (raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const API_BASE = normalizeApiBase(import.meta.env.VITE_API_URL);

export const DEFAULT_CONFIG = {
  auth_required: false,
  assistant_name: "Aria",
  llm_provider: "gemini",
  tts_provider: "edge",
  stt_server_available: false,
  max_message_chars: 2000,
  default_collection: "general",
  avatar: {
    url: "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.2/avatars/brunette.glb",
    body: "F",
    lipsyncLang: "en",
  },
};

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

function loadLocalDocs() {
  try {
    const raw = localStorage.getItem(LOCAL_DOCS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalDocs(docs) {
  try {
    localStorage.setItem(LOCAL_DOCS_KEY, JSON.stringify(docs));
  } catch {
    /* ignore quota errors */
  }
}

function loadLocalSessions() {
  try {
    const raw = localStorage.getItem(LOCAL_SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    /* ignore */
  }
  const initial = [
    {
      id: "local_" + randomId().slice(0, 12),
      title: "New chat",
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    },
  ];
  localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(initial));
  return initial;
}

function saveLocalSessions(sessions) {
  try {
    localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    /* ignore */
  }
}

function loadLocalMessagesMap() {
  try {
    const raw = localStorage.getItem(LOCAL_MESSAGES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function appendLocalMessage(sessionId, role, content, sources = []) {
  if (!sessionId) return;
  try {
    const map = loadLocalMessagesMap();
    const list = map[sessionId] || [];
    list.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      role,
      content,
      interrupted: false,
      sources,
      created_at: Date.now() / 1000,
    });
    map[sessionId] = list;
    localStorage.setItem(LOCAL_MESSAGES_KEY, JSON.stringify(map));

    if (role === "user") {
      const sessions = loadLocalSessions();
      const idx = sessions.findIndex((s) => s.id === sessionId);
      if (idx >= 0) {
        if (sessions[idx].title === "New chat") {
          sessions[idx].title = content.slice(0, 44);
        }
        sessions[idx].updated_at = Date.now() / 1000;
        saveLocalSessions(sessions);
      }
    }
  } catch {
    /* ignore */
  }
}

// Load PDF.js from CDN on demand to extract text from PDFs in the browser
let pdfjsPromise = null;
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          resolve(window.pdfjsLib);
        } else {
          reject(new Error("PDF.js failed to initialize"));
        }
      };
      script.onerror = () => reject(new Error("Could not load PDF parser"));
      document.head.appendChild(script);
    });
  }
  return pdfjsPromise;
}

async function extractFilePagesInBrowser(file) {
  const name = (file?.name || "").toLowerCase();
  if (name.endsWith(".pdf")) {
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => item.str || "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) pages.push({ page: i, text });
      }
      if (pages.length > 0) return pages;
    } catch (err) {
      console.warn("Browser PDF extraction fallback:", err);
    }
  }

  // Plain text / Markdown / fallback
  const rawText = await file.text().catch(() => "");
  const cleanText =
    rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").trim() ||
    `Uploaded document: ${file.name}.`;
  return [{ page: 1, text: cleanText }];
}

function chunkPages(pages, docId, chunkSize = 700, overlap = 120) {
  const chunks = [];
  let idx = 0;
  for (const p of pages) {
    const text = p.text || "";
    if (text.length <= chunkSize) {
      chunks.push({
        chunk_id: `${docId}_${idx}`,
        chunk_index: idx++,
        page: p.page,
        content: text,
      });
    } else {
      let start = 0;
      while (start < text.length) {
        const slice = text.slice(start, start + chunkSize).trim();
        if (slice) {
          chunks.push({
            chunk_id: `${docId}_${idx}`,
            chunk_index: idx++,
            page: p.page,
            content: slice,
          });
        }
        if (start + chunkSize >= text.length) break;
        start += chunkSize - overlap;
      }
    }
  }
  return chunks;
}

export function retrieveLocalContext(query, collection = "all", topK = 3) {
  const docs = loadLocalDocs().filter(
    (d) =>
      d.is_active &&
      (!collection ||
        collection.toLowerCase() === "all" ||
        (d.collection || "").toLowerCase() === collection.toLowerCase())
  );
  if (!docs.length) return { context: "", sources: [] };

  const stopWords = new Set([
    "the", "is", "are", "was", "were", "what", "how", "why", "can", "you", "explain",
    "tell", "me", "about", "in", "of", "to", "for", "and", "or", "a", "an", "with", "on",
  ]);
  const qTokens = (query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  const scored = [];
  for (const doc of docs) {
    const docChunks = doc.chunks || [];
    for (const ch of docChunks) {
      const textLower = (ch.content || "").toLowerCase();
      let score = 0.15;
      for (const tok of qTokens) {
        if (textLower.includes(tok)) score += 0.35;
      }
      if ((doc.title || "").toLowerCase().split(/\s+/).some((w) => qTokens.includes(w))) {
        score += 0.2;
      }
      scored.push({
        doc,
        chunk: ch,
        score: Math.min(0.99, Number(score.toFixed(3))),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, topK);

  const sources = picked.map((item) => ({
    source: item.doc.original_name || item.doc.title,
    doc_id: item.doc.id,
    page: item.chunk.page || 1,
    score: item.score,
    snippet:
      item.chunk.content.slice(0, 180) + (item.chunk.content.length > 180 ? "..." : ""),
  }));

  const context = picked
    .map(
      (item) =>
        `[Source: ${item.doc.title} (${item.doc.original_name}), Page ${item.chunk.page || 1}${
          item.doc.custom_notes ? ` | Notes: ${item.doc.custom_notes}` : ""
        }]\n${item.chunk.content}`
    )
    .join("\n\n");

  return { context, sources };
}

export async function askStandaloneTutor({ query, history = [], collection = "calculus_101" }) {
  const { context, sources } = retrieveLocalContext(query, collection, 3);

  // 1. Try Vercel Serverless Function (/api/chat) if available
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, history, context, collection }),
    });
    if (res.ok) {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const data = await res.json();
        if (data?.reply) {
          return { reply: data.reply, sources };
        }
      }
    }
  } catch {
    /* ignore and try next fallback */
  }

  // 2. Try free browser-accessible LLM endpoint with textbook RAG context
  const systemPrompt =
    "You are Aria, a warm, encouraging 3D AI Tutor. Keep your explanation clear, concise (2 to 4 sentences), and conversational so it sounds natural when spoken aloud by a 3D avatar. " +
    (context
      ? `\n\nUse the following uploaded textbook excerpts from the student's '${collection}' subject to answer accurately:\n${context}`
      : "");

  try {
    const messagesPayload = [
      { role: "system", content: systemPrompt },
      ...history.slice(-6).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      { role: "user", content: query },
    ];
    const llmRes = await fetch("https://text.pollinations.ai/openai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        messages: messagesPayload,
      }),
    });
    if (llmRes.ok) {
      const data = await llmRes.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) {
        return { reply: text, sources };
      }
    }
  } catch {
    /* ignore and use local RAG synthesis */
  }

  // 3. Deterministic RAG Tutor response synthesized directly from the uploaded documents
  if (sources.length > 0) {
    const top = sources[0];
    const excerpt = context.split("\n").slice(1).join(" ").slice(0, 360).trim();
    return {
      reply: `Based on your uploaded notes in ${top.source} (Page ${top.page}): ${excerpt} Would you like to walk through an example of this together?`,
      sources,
    };
  }

  return {
    reply:
      "I'm ready to help! Upload a PDF or textbook in the Knowledge Base on the right, or ask me any concept question and we'll break it down step by step.",
    sources: [],
  };
}

// ------------------------------------------------------------------ Network Request with Automatic Fallback
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

  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("application/json")) {
    let detail = res.statusText || "Backend unavailable";
    try {
      if (contentType.includes("application/json")) {
        detail = (await res.json()).detail || detail;
      }
    } catch {
      /* ignore */
    }
    const err = new Error(detail);
    err.status = res.status || 503;
    throw err;
  }
  return res.json();
}

export const api = {
  config: async () => {
    try {
      return await request("/config");
    } catch {
      return DEFAULT_CONFIG;
    }
  },

  listSessions: async () => {
    try {
      return await request("/sessions");
    } catch {
      return loadLocalSessions();
    }
  },

  createSession: async () => {
    try {
      return await request("/sessions", { method: "POST" });
    } catch {
      const sessions = loadLocalSessions();
      const s = {
        id: "local_" + randomId().slice(0, 12),
        title: "New chat",
        created_at: Date.now() / 1000,
        updated_at: Date.now() / 1000,
      };
      const next = [s, ...sessions];
      saveLocalSessions(next);
      return s;
    }
  },

  messages: async (id) => {
    try {
      return await request(`/sessions/${id}/messages`);
    } catch {
      const map = loadLocalMessagesMap();
      return map[id] || [];
    }
  },

  deleteSession: async (id) => {
    try {
      return await request(`/sessions/${id}`, { method: "DELETE" });
    } catch {
      const sessions = loadLocalSessions().filter((s) => s.id !== id);
      saveLocalSessions(sessions);
      const map = loadLocalMessagesMap();
      delete map[id];
      localStorage.setItem(LOCAL_MESSAGES_KEY, JSON.stringify(map));
      return { ok: true };
    }
  },

  transcribe: (blob) => {
    const form = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.append("file", blob, `speech.${ext}`);
    return request("/stt", { method: "POST", form });
  },

  // Document Management APIs with Browser PDF/Text Fallback
  listDocuments: async (collection) => {
    try {
      return await request(
        `/documents${
          collection && collection !== "all" ? `?collection=${encodeURIComponent(collection)}` : ""
        }`
      );
    } catch {
      const all = loadLocalDocs();
      if (!collection || collection.toLowerCase() === "all") return all;
      return all.filter(
        (d) => (d.collection || "").toLowerCase() === collection.trim().toLowerCase()
      );
    }
  },

  uploadDocument: async (formData) => {
    try {
      return await request("/documents/upload", { method: "POST", form: formData });
    } catch {
      const file = formData.get("file");
      if (!file) throw new Error("No file selected");
      const collection = (formData.get("collection") || "calculus_101").toString().trim().toLowerCase();
      const customTitle = (formData.get("title") || "").toString().trim();
      const customNotes = (formData.get("custom_notes") || "").toString().trim();

      const pages = await extractFilePagesInBrowser(file);
      const docId = "doc_" + randomId().slice(0, 12);
      const chunks = chunkPages(pages, docId);
      const defaultTitle = file.name.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ");

      const record = {
        id: docId,
        filename: file.name,
        original_name: file.name,
        collection,
        title: customTitle || defaultTitle,
        file_size: file.size || 1024,
        pages_count: pages.length,
        chunks_count: chunks.length,
        is_active: 1,
        custom_notes: customNotes,
        created_at: Math.floor(Date.now() / 1000),
        chunks,
      };

      const docs = loadLocalDocs();
      const next = [record, ...docs];
      saveLocalDocs(next);
      return record;
    }
  },

  getDocument: async (docId) => {
    try {
      return await request(`/documents/${docId}`);
    } catch {
      const doc = loadLocalDocs().find((d) => d.id === docId);
      if (!doc) throw new Error("Document not found");
      return { document: doc, chunks: doc.chunks || [] };
    }
  },

  updateDocument: async (docId, data) => {
    try {
      return await request(`/documents/${docId}`, { method: "PUT", body: data });
    } catch {
      const docs = loadLocalDocs();
      const idx = docs.findIndex((d) => d.id === docId);
      if (idx < 0) throw new Error("Document not found");
      const updated = {
        ...docs[idx],
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.collection !== undefined ? { collection: data.collection.toLowerCase() } : {}),
        ...(data.is_active !== undefined ? { is_active: data.is_active ? 1 : 0 } : {}),
        ...(data.custom_notes !== undefined ? { custom_notes: data.custom_notes } : {}),
      };
      docs[idx] = updated;
      saveLocalDocs(docs);
      return updated;
    }
  },

  deleteDocument: async (docId) => {
    try {
      return await request(`/documents/${docId}`, { method: "DELETE" });
    } catch {
      const docs = loadLocalDocs().filter((d) => d.id !== docId);
      saveLocalDocs(docs);
      return { ok: true, deleted_id: docId };
    }
  },

  queryDocuments: async (query, collection = "calculus_101", topK = 3) => {
    try {
      return await request("/documents/query", {
        method: "POST",
        body: { query, collection, top_k: topK },
      });
    } catch {
      return retrieveLocalContext(query, collection, topK);
    }
  },

  listCollections: async () => {
    try {
      return await request("/collections");
    } catch {
      const docs = loadLocalDocs();
      const set = new Set();
      for (const d of docs) {
        if (d.collection) set.add(d.collection);
      }
      return Array.from(set);
    }
  },

  // Attention Tracking APIs
  getAttentionStatus: async () => {
    try {
      return await request("/attention/status");
    } catch {
      return { status: "Attentive", is_distracted: false, metrics: {} };
    }
  },
  simulateAttention: async (type, sessionId = "default") => {
    try {
      return await request("/attention/simulate", {
        method: "POST",
        body: { type, session_id: sessionId },
      });
    } catch {
      return { status: "Attentive", is_distracted: false };
    }
  },
  postAttentionTelemetry: async (telemetry) => {
    try {
      return await request("/attention/telemetry", { method: "POST", body: telemetry });
    } catch {
      return { status: "Attentive", is_distracted: false };
    }
  },
};
