import React, { useEffect, useRef, useState } from "react";

export default function ChatPanel({
  messages,
  assistantName,
  loading,
  intervention,
  onDismissIntervention,
  onReplyIntervention,
}) {
  const endRef = useRef(null);
  const [expandedSources, setExpandedSources] = useState({});

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, intervention]);

  const toggleSource = (msgKey) => {
    setExpandedSources((prev) => ({ ...prev, [msgKey]: !prev[msgKey] }));
  };

  return (
    <div className="chat-scroll" role="log" aria-live="polite">
      {loading && <p className="hint">Loading conversation…</p>}

      {!loading && messages.length === 0 && (
        <div className="empty-chat">
          <div className="empty-avatar-icon">🎓</div>
          <h3>Welcome to {assistantName}!</h3>
          <p>
            Your AI tutor is ready. Ask questions from your uploaded textbooks, explore step-by-step
            derivations, or speak aloud using the microphone!
          </p>
        </div>
      )}

      {/* Re-engagement Intervention Banner */}
      {intervention && (
        <div className="intervention-alert-banner">
          <div className="intervention-content">
            <span className="intervention-icon">💡</span>
            <div className="intervention-text-box">
              <strong>Tutor Check-In Nudge</strong>
              <p>{intervention.message || "I noticed you drifted off for a moment. Ready to continue our lesson?"}</p>
            </div>
          </div>
          <div className="intervention-actions">
            <button
              className="btn primary small"
              onClick={() => {
                onReplyIntervention?.("I'm back, let's continue!");
                onDismissIntervention?.();
              }}
            >
              I'm Back!
            </button>
            <button className="icon-btn small close-btn" onClick={onDismissIntervention} title="Dismiss">
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.map((m) => {
        const hasSources = m.sources && m.sources.length > 0;
        const isSourcesOpen = !!expandedSources[m.key];

        return (
          <div key={m.key} className={`bubble ${m.role} ${m.error ? "error" : ""}`}>
            <div className="bubble-text">
              {m.content || (m.streaming ? <span className="typing"><i /><i /><i /></span> : "")}
            </div>

            {/* Source Citations Drawer */}
            {hasSources && (
              <div className="citations-wrapper">
                <button
                  type="button"
                  className="citation-toggle-btn"
                  onClick={() => toggleSource(m.key)}
                >
                  <span>📚 {m.sources.length} Textbook Citation{m.sources.length > 1 ? "s" : ""}</span>
                  <span>{isSourcesOpen ? "▲" : "▼"}</span>
                </button>

                {isSourcesOpen && (
                  <div className="citations-list">
                    {m.sources.map((s, idx) => (
                      <div key={idx} className="citation-item">
                        <div className="citation-header">
                          <span className="cit-source">📖 {s.source}</span>
                          <span className="cit-page">Page {s.page}</span>
                        </div>
                        <p className="cit-snippet">"{s.snippet}"</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {m.interrupted && <div className="tag">interrupted</div>}
            {m.error && <div className="tag err">{m.error}</div>}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
