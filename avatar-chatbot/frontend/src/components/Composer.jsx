import React, { useRef, useState } from "react";

const SUGGESTIONS = [
  "💡 Explain with an intuitive analogy",
  "📝 Give me a practice problem with steps",
  "📐 Summarize the key definitions and formulas",
  "❓ Quiz my understanding of this topic",
];

export default function Composer({
  disabled,
  busy,
  voice,
  maxChars,
  onSend,
  onStop,
  onMicToggle,
  bargeIn,
  onBargeInChange,
}) {
  const [text, setText] = useState("");
  const inputRef = useRef(null);

  const submit = (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) submit(e);
  };

  const micLabel =
    voice.mode === "none"
      ? "Voice input is not supported in this browser"
      : voice.listening
      ? voice.mode === "recorder"
        ? "Stop recording and send"
        : "Stop listening"
      : "Start talking";

  return (
    <div className="composer-container">
      {/* Quick Prompt Chips */}
      <div className="quick-chips-row">
        {SUGGESTIONS.map((s, idx) => (
          <button
            key={idx}
            type="button"
            className="chip-btn"
            disabled={disabled}
            onClick={() => onSend(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <form className="composer" onSubmit={submit}>
        {(voice.interim || voice.transcribing) && (
          <div className="interim">{voice.transcribing ? "Transcribing speech…" : voice.interim}</div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className={`icon-btn mic ${voice.listening ? "on" : ""}`}
            onClick={onMicToggle}
            disabled={voice.mode === "none" || disabled}
            aria-pressed={voice.listening}
            aria-label={micLabel}
            title={micLabel}
          >
            {voice.listening ? "⏺" : "🎤"}
          </button>
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            maxLength={maxChars || 2000}
            placeholder={voice.listening ? "Listening… speak naturally" : "Ask a textbook question or talk..."}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
          />
          {busy ? (
            <button type="button" className="btn danger" onClick={onStop} title="Interrupt avatar speech">
              ■ Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={disabled || !text.trim()}>
              Send
            </button>
          )}
        </div>
        <div className="composer-footer">
          <label className="toggle">
            <input type="checkbox" checked={bargeIn} onChange={(e) => onBargeInChange(e.target.checked)} />
            <span>Interrupt avatar by speaking (use headphones to prevent feedback)</span>
          </label>
        </div>
      </form>
    </div>
  );
}
