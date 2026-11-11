import React, { useCallback, useEffect, useRef, useState } from "react";
import AvatarStage from "./components/AvatarStage.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import Composer from "./components/Composer.jsx";
import DocumentManager from "./components/DocumentManager.jsx";
import BackgroundAttentionMonitor from "./components/BackgroundAttentionMonitor.jsx";
import Sidebar from "./components/Sidebar.jsx";
import { useChatSocket } from "./hooks/useChatSocket.js";
import { useVoiceInput } from "./hooks/useVoiceInput.js";
import {
  api,
  DEFAULT_CONFIG,
  askStandaloneTutor,
  appendLocalMessage,
  getToken,
  setToken,
} from "./lib/api.js";

const STOP_WORDS = /^(stop|wait|pause|cancel|quiet|enough)\W*$/i;
const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;
let keySeq = 0;
const nextKey = (p) => `${p}-${Date.now()}-${keySeq++}`;

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [needsToken, setNeedsToken] = useState(false);
  const [authTick, setAuthTick] = useState(0);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [bargeIn, setBargeIn] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");

  // Active textbook collection state & available collections list
  const [activeCollection, setActiveCollection] = useState("all");
  const [collections, setCollections] = useState([]);

  const refreshCollections = useCallback(() => {
    api
      .listCollections()
      .then((colls) => {
        if (colls && colls.length) setCollections(colls);
      })
      .catch(() => {});
  }, []);

  // Theme state ("light" | "dark"), defaulting to light mode
  const [theme, setTheme] = useState(() => localStorage.getItem("avatarchat.theme") || "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("avatarchat.theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === "light" ? "dark" : "light"));

  // Distraction Intervention state
  const [intervention, setIntervention] = useState(null);
  const [cameraActive, setCameraActive] = useState(false);

  // Mobile partition view tab ("avatar" | "chat" | "docs")
  const [activeTab, setActiveTab] = useState("chat");

  const avatarRef = useRef(null);
  const activeTurnRef = useRef(null);
  const busyRef = useRef(false);
  const speakingStateRef = useRef(false);
  const nudgeActiveRef = useRef(false);
  const wasDistractedRef = useRef(false);
  const lastNudgeAtRef = useRef(0);
  const bargeInRef = useRef(true);
  busyRef.current = generating || speaking;
  speakingStateRef.current = speaking;
  bargeInRef.current = bargeIn;

  // Unlock browser WebAudio on first user gesture anywhere in the app so background distraction cues always play aloud
  useEffect(() => {
    const unlockAudio = () => avatarRef.current?.unlock();
    window.addEventListener("pointerdown", unlockAudio, { passive: true });
    window.addEventListener("keydown", unlockAudio, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (msg) setTimeout(() => setToast((t) => (t === msg ? "" : t)), 6000);
  }, []);

  const handleAuthError = useCallback((err) => {
    if (err?.status === 401) {
      setToken("");
      setNeedsToken(true);
      return true;
    }
    return false;
  }, []);

  // ---------------------------------------------------------------- Bootstrap
  useEffect(() => {
    api.config()
      .then((cfg) => {
        setConfig(cfg);
        refreshCollections();
      })
      .catch(() => showToast("Cannot reach server. Is the backend running on port 8000?"));
  }, [showToast, refreshCollections]);

  useEffect(() => {
    if (!config) return;
    if (config.auth_required && !getToken()) {
      setNeedsToken(true);
      return;
    }
    setNeedsToken(false);
    (async () => {
      try {
        let list = await api.listSessions();
        if (list.length === 0) list = [await api.createSession()];
        setSessions(list);
        setSessionId((cur) => cur || list[0].id);
      } catch (err) {
        if (!handleAuthError(err)) showToast(`Could not load chats: ${err.message}`);
      }
    })();
  }, [config, authTick, handleAuthError, showToast]);

  const refreshSessions = useCallback(() => {
    api.listSessions().then(setSessions).catch(() => {});
  }, []);

  // ---------------------------------------------------------------- Load history
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    avatarRef.current?.interrupt();
    activeTurnRef.current = null;
    setGenerating(false);
    setLoadingMsgs(true);
    api
      .messages(sessionId)
      .then((rows) => {
        if (cancelled) return;
        setMessages(
          rows.map((r) => ({
            key: `m-${r.id}`,
            role: r.role,
            content: r.content,
            interrupted: !!r.interrupted,
            sources: r.sources || [],
          }))
        );
      })
      .catch((err) => !handleAuthError(err) && showToast(`Could not load messages: ${err.message}`))
      .finally(() => !cancelled && setLoadingMsgs(false));
    return () => {
      cancelled = true;
    };
  }, [sessionId, handleAuthError, showToast]);

  // ---------------------------------------------------------------- Avatar / interruption
  const interruptLocal = useCallback(() => {
    avatarRef.current?.interrupt();
    activeTurnRef.current = null;
    nudgeActiveRef.current = false;
    setGenerating(false);
    setMessages((ms) =>
      ms
        .filter((m) => !(m.streaming && !m.content))
        .map((m) => (m.streaming ? { ...m, streaming: false, interrupted: true } : m))
    );
  }, []);

  // ---------------------------------------------------------------- WebSocket events
  const handleEvent = useCallback(
    (msg) => {
      switch (msg.type) {
        case "turn_start":
          activeTurnRef.current = msg.turn;
          nudgeActiveRef.current = !!msg.is_nudge;
          setGenerating(true);
          setMessages((ms) => [
            ...ms,
            {
              key: `a-${msg.turn}`,
              role: "assistant",
              content: "",
              streaming: true,
              turn: msg.turn,
              sources: [],
            },
          ]);
          break;

        case "rag_sources":
          if (msg.turn !== activeTurnRef.current) return;
          setMessages((ms) =>
            ms.map((m) => (m.turn === msg.turn ? { ...m, sources: msg.sources || [] } : m))
          );
          break;

        case "text_delta":
          if (msg.turn !== activeTurnRef.current) return;
          setMessages((ms) =>
            ms.map((m) => (m.turn === msg.turn ? { ...m, content: m.content + msg.text } : m))
          );
          break;

        case "audio":
          if (msg.turn !== activeTurnRef.current) return;
          avatarRef.current?.enqueue(msg);
          break;

        case "turn_end":
          if (msg.turn !== activeTurnRef.current) return;
          activeTurnRef.current = null;
          nudgeActiveRef.current = false;
          setGenerating(false);
          setMessages((ms) =>
            ms
              .map((m) =>
                m.turn === msg.turn
                  ? {
                      ...m,
                      streaming: false,
                      interrupted: msg.interrupted,
                      error: msg.error || undefined,
                      sources: msg.sources || m.sources || [],
                    }
                  : m
              )
              .filter((m) => !(m.turn === msg.turn && !m.content && !m.error))
          );
          refreshSessions();
          break;

        case "error":
          if (msg.message === "Unauthorized") {
            setToken("");
            setNeedsToken(true);
          } else {
            showToast(msg.message);
          }
          break;

        default:
          break;
      }
    },
    [refreshSessions, showToast]
  );

  const { status, send } = useChatSocket({ sessionId, enabled: !needsToken, onEvent: handleEvent });

  // ---------------------------------------------------------------- Send message
  const sendMessage = useCallback(
    async (text) => {
      avatarRef.current?.unlock();
      if (busyRef.current) interruptLocal();
      setMessages((ms) => [...ms, { key: nextKey("u"), role: "user", content: text }]);

      if (
        send({
          type: "user_message",
          text,
          collection: activeCollection,
        })
      ) {
        return;
      }

      // Standalone / Vercel Fallback when WebSocket backend is not connected
      appendLocalMessage(sessionId, "user", text);
      const turnId = `local-${Date.now()}`;
      activeTurnRef.current = turnId;
      setGenerating(true);
      setMessages((ms) => [
        ...ms,
        {
          key: `a-${turnId}`,
          role: "assistant",
          content: "",
          streaming: true,
          turn: turnId,
          sources: [],
        },
      ]);

      try {
        const res = await askStandaloneTutor({
          query: text,
          history: messages,
          collection: activeCollection,
        });
        if (activeTurnRef.current !== turnId) return;
        const replyText = res.reply || "I'm here to help with your study questions!";
        const sources = res.sources || [];
        activeTurnRef.current = null;
        setGenerating(false);
        setMessages((ms) =>
          ms.map((m) =>
            m.turn === turnId
              ? { ...m, content: replyText, streaming: false, sources }
              : m
          )
        );
        appendLocalMessage(sessionId, "assistant", replyText, sources);
        refreshSessions();
        avatarRef.current?.speakLocal?.(replyText, "happy");
      } catch (err) {
        if (activeTurnRef.current !== turnId) return;
        activeTurnRef.current = null;
        setGenerating(false);
        setMessages((ms) =>
          ms.map((m) =>
            m.turn === turnId
              ? { ...m, streaming: false, error: err?.message || "Could not generate response" }
              : m
          )
        );
      }
    },
    [send, interruptLocal, activeCollection, sessionId, messages, refreshSessions]
  );

  const stopAvatar = useCallback(() => {
    send({ type: "interrupt" });
    interruptLocal();
  }, [send, interruptLocal]);

  // Voice Input (STT)
  const voice = useVoiceInput({
    lang: navigator.language || "en-US",
    serverStt: config?.stt_server_available,
    onInterim: (text) => {
      if (busyRef.current && bargeInRef.current && wordCount(text) >= 2) stopAvatar();
    },
    onFinal: (text) => {
      const busy = busyRef.current;
      if (busy && !bargeInRef.current) return;
      if (STOP_WORDS.test(text.trim())) {
        if (busy) stopAvatar();
        return;
      }
      if (busy && wordCount(text) < 2) return;
      sendMessage(text);
    },
    onStart: () => busyRef.current && stopAvatar(),
    onError: showToast,
  });

  const toggleMic = () => {
    avatarRef.current?.unlock();
    if (!voice.listening) avatarRef.current?.setListening(true);
    voice.toggle();
  };

  const newChat = async () => {
    if (messages.length === 0 && sessionId) return setSidebarOpen(false);
    try {
      const s = await api.createSession();
      setSessions((l) => [s, ...l]);
      setSessionId(s.id);
      setSidebarOpen(false);
    } catch (err) {
      showToast(err.message);
    }
  };

  const deleteChat = async (id) => {
    try {
      await api.deleteSession(id);
      const rest = sessions.filter((s) => s.id !== id);
      if (id === sessionId) {
        if (rest.length) setSessionId(rest[0].id);
        else {
          const s = await api.createSession();
          rest.push(s);
          setSessionId(s.id);
        }
      }
      setSessions(rest);
    } catch (err) {
      showToast(err.message);
    }
  };

  // Background distraction trigger handler (edge-triggered with smart repeat cooldown)
  const handleDistractionDetected = useCallback(
    (data, { force = false } = {}) => {
      const distracted = !!(data?.is_distracted || data?.trigger_prompt_override || force);
      if (!distracted) {
        wasDistractedRef.current = false;
        return;
      }

      const now = Date.now();
      const justBecameDistracted = !wasDistractedRef.current;
      wasDistractedRef.current = true;

      if (!force) {
        // Never interrupt an active answer or spoken cue
        if (busyRef.current || nudgeActiveRef.current || speakingStateRef.current) return;
        const cooldownMs = justBecameDistracted || data?.trigger_prompt_override ? 7000 : 15000;
        if (now - lastNudgeAtRef.current < cooldownMs) return;
      }

      lastNudgeAtRef.current = now;
      avatarRef.current?.unlock();
      avatarRef.current?.setListening(true);
      const nudgeText =
        "Hey, I noticed you got distracted! Pay attention here, let's stay focused on our lesson!";
      setIntervention({
        message: nudgeText,
      });
      const sentOverWs = send({
        type: "distraction_nudge",
        reason: data?.reason || "getting distracted",
        collection: activeCollection,
      });
      if (!sentOverWs) {
        setMessages((ms) => [
          ...ms,
          { key: nextKey("a"), role: "assistant", content: nudgeText, sources: [] },
        ]);
        avatarRef.current?.speakLocal?.(nudgeText, "happy");
      }
    },
    [send, activeCollection]
  );

  if (needsToken) {
    return <TokenGate onSubmit={(t) => { setToken(t); setAuthTick((n) => n + 1); }} />;
  }

  const phase = voice.listening && !generating && !speaking ? "listening" : speaking ? "speaking" : generating ? "thinking" : "idle";
  const name = config?.assistant_name || "Aria";

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        open={sidebarOpen}
        authRequired={config?.auth_required}
        onSelect={(id) => { setSessionId(id); setSidebarOpen(false); }}
        onNew={newChat}
        onDelete={deleteChat}
        onClose={() => setSidebarOpen(false)}
        onSignOut={() => { setToken(""); setNeedsToken(true); }}
      />

      <div className="main">
        {/* Top Navigation Bar */}
        <header className="topbar">
          <button className="icon-btn menu" aria-label="Open chats" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          
          <div className="topbar-branding">
            <span className="logo-sparkle">✨</span>
            <div className="brand-texts">
              <h1>{name} &bull; AI Tutor</h1>
            </div>
          </div>

          {/* Awareness Popover & Theme Toggle */}
          <div className="topbar-status-group">
            {/* Expandable Camera & Awareness Checker near Light Mode */}
            <BackgroundAttentionMonitor
              enabled={true}
              onDistractionDetected={handleDistractionDetected}
              onCameraStatusChange={setCameraActive}
            />

            <button
              type="button"
              className="theme-toggle-btn"
              onClick={toggleTheme}
              title={theme === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
            >
              {theme === "light" ? "🌙 Dark Mode" : "☀️ Light Mode"}
            </button>
          </div>
        </header>

        {/* Mobile Partition Switcher Tabs */}
        <div className="mobile-tabs-bar">
          <button
            className={`tab-btn ${activeTab === "chat" || activeTab === "avatar" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            💬 Avatar &amp; Chat
          </button>
          <button
            className={`tab-btn ${activeTab === "docs" ? "active" : ""}`}
            onClick={() => setActiveTab("docs")}
          >
            📚 Knowledge Base
          </button>
        </div>

        {/* Main Grid Content: Combined (Avatar + Chat) + Knowledge Base */}
        <div className={`content partitions-2 tab-${activeTab}`}>

          {/* COMBINED PARTITION: 3D AVATAR + INTERACTIVE CHAT */}
          <section className="partition partition-tutor">
            <div className="partition-header">
              <span className="partition-title">Tutor Aria</span>
              <div className="tutor-header-controls">
                <div className="collection-bar">
                  <label className="coll-label" htmlFor="chat-collection-select">📚 Subject:</label>
                  <select
                    id="chat-collection-select"
                    value={activeCollection || "all"}
                    onChange={(e) => setActiveCollection(e.target.value)}
                    className="coll-select"
                  >
                    <option value="all">All Subjects</option>
                    {collections.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="tutor-combined-body">
              <div className="stage-inner">
                {config && (
                  <AvatarStage
                    ref={avatarRef}
                    avatar={config.avatar}
                    assistantName={name}
                    onSpeakingChange={setSpeaking}
                  />
                )}
              </div>

              <div className="chat-body">
                <ChatPanel
                  messages={messages}
                  assistantName={name}
                  loading={loadingMsgs}
                  intervention={intervention}
                  onDismissIntervention={() => setIntervention(null)}
                  onReplyIntervention={(reply) => sendMessage(reply)}
                />

                {toast && <div className="toast" role="alert">{toast}</div>}

                {!cameraActive && (
                  <div className="camera-lock-banner" role="alert">
                    <span className="camera-lock-icon">📷</span>
                    <div className="camera-lock-text">
                      <strong>Camera Required:</strong> Please turn on the <strong>Camera</strong> in the top-right header to activate your 3D tutor and continue lessons.
                    </div>
                  </div>
                )}

                <Composer
                  disabled={!cameraActive || loadingMsgs}
                  busy={generating || speaking}
                  voice={voice}
                  placeholder={!cameraActive ? "Turn on Camera above to unlock chat..." : undefined}
                  maxChars={config?.max_message_chars}
                  onSend={sendMessage}
                  onStop={stopAvatar}
                  onMicToggle={cameraActive ? toggleMic : () => showToast("Please turn on your camera first to speak with Aria.")}
                  bargeIn={bargeIn}
                  onBargeInChange={setBargeIn}
                />
              </div>
            </div>
          </section>

          {/* PARTITION 2: FILE & TEXTBOOK KNOWLEDGE BASE MANAGER */}
          <section className="partition partition-docs">
            <DocumentManager
              activeCollection={activeCollection}
              collections={collections}
              onCollectionChange={setActiveCollection}
              onCollectionsRefresh={refreshCollections}
              onNotification={showToast}
            />
          </section>

        </div>
      </div>
    </div>
  );
}

function TokenGate({ onSubmit }) {
  const [value, setValue] = useState("");
  return (
    <div className="gate">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1>Sign in</h1>
        <p>This server requires an access token.</p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Access token"
        />
        <button className="btn primary" type="submit">Continue</button>
      </form>
    </div>
  );
}
