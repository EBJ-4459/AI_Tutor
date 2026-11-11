import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const EMOJI_RE = /\p{Extended_Pictographic}/u;

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * 3D avatar powered by TalkingHead (met4citizen).
 * Supports camera view switching, lipsync visemes, emotional expressions, and gesture animation.
 */
const AvatarStage = forwardRef(function AvatarStage({ avatar, onSpeakingChange, assistantName = "Aria" }, ref) {
  const hostRef = useRef(null);
  const headRef = useRef(null);
  const epochRef = useRef(0);
  const chainRef = useRef(Promise.resolve());
  const queueEndRef = useRef(0);
  const speakingRef = useRef(false);
  const [state, setState] = useState({ phase: "loading", progress: 0, error: "" });
  const [currentView, setCurrentView] = useState("upper");

  // ---- load TalkingHead + avatar
  useEffect(() => {
    if (!avatar?.url) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const spec = "talkinghead";
        const { TalkingHead } = await import(/* @vite-ignore */ spec);
        if (cancelled) return;
        const head = new TalkingHead(hostRef.current, {
          ttsEndpoint: null,
          lipsyncModules: ["en", "fi", "de", "fr", "lt"],
          cameraView: "upper",
          cameraRotateEnable: true,
          cameraZoomEnable: true,
          cameraPanEnable: false,
          avatarMood: "neutral",
        });
        headRef.current = head;
        await head.showAvatar(
          {
            url: avatar.url,
            body: avatar.body || "F",
            avatarMood: "neutral",
            lipsyncLang: avatar.lipsyncLang || "en",
          },
          (ev) => {
            if (cancelled || !ev?.lengthComputable || !ev.total) return;
            setState((s) => ({ ...s, progress: Math.min(99, Math.round((ev.loaded / ev.total) * 100)) }));
          }
        );
        if (cancelled) return;
        head.speakWithHands?.();
        setState({ phase: "ready", progress: 100, error: "" });
      } catch (err) {
        console.error("TalkingHead failed to load", err);
        if (!cancelled)
          setState({
            phase: "error",
            progress: 0,
            error:
              "The 3D avatar could not be loaded. Please ensure WebGL is enabled.",
          });
      }
    })();

    return () => {
      cancelled = true;
      const head = headRef.current;
      headRef.current = null;
      try {
        head?.stopSpeaking?.();
        head?.stop?.();
        head?.renderer?.dispose?.();
      } catch {
        /* ignore */
      }
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [avatar?.url, avatar?.body, avatar?.lipsyncLang]);

  // ---- report speaking state
  useEffect(() => {
    const id = setInterval(() => {
      const speaking = Date.now() < queueEndRef.current;
      if (speaking !== speakingRef.current) {
        speakingRef.current = speaking;
        onSpeakingChange?.(speaking);
      }
    }, 120);
    return () => clearInterval(id);
  }, [onSpeakingChange]);

  const changeView = (view) => {
    setCurrentView(view);
    const head = headRef.current;
    if (head) {
      try {
        head.setView?.(view);
      } catch {
        // ignore
      }
    }
  };

  useImperativeHandle(ref, () => ({
    unlock() {
      const ctx = headRef.current?.audioCtx;
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    },

    setListening(on) {
      if (on) headRef.current?.lookAtCamera?.(2500);
    },

    interrupt() {
      epochRef.current += 1;
      queueEndRef.current = 0;
      chainRef.current = Promise.resolve();
      const head = headRef.current;
      try {
        head?.stopSpeaking?.();
        head?.setMood?.("neutral");
      } catch (e) {
        console.warn("stopSpeaking failed", e);
      }
    },

    enqueue(ev) {
      const epoch = epochRef.current;
      chainRef.current = chainRef.current.then(async () => {
        const head = headRef.current;
        if (!head || epoch !== epochRef.current) return;
        try {
          const ctx = head.audioCtx;
          if (ctx.state === "suspended") await ctx.resume();
          const buffer = await ctx.decodeAudioData(base64ToArrayBuffer(ev.data));
          if (epoch !== epochRef.current) return;

          const now = Date.now();
          const startAt = Math.max(now, queueEndRef.current);
          queueEndRef.current = startAt + buffer.duration * 1000 + 250;

          if (ev.mood) {
            setTimeout(() => {
              if (epoch === epochRef.current) {
                try {
                  head.setMood?.(ev.mood);
                } catch {
                  /* ignore */
                }
              }
            }, Math.max(0, startAt - now));
          }

          head.speakAudio(
            { audio: buffer, words: ev.words, wtimes: ev.wtimes, wdurations: ev.wdurations },
            {}
          );

          const emoji = EMOJI_RE.exec(ev.text || "")?.[0];
          if (emoji) head.speakEmoji?.(emoji);
        } catch (err) {
          console.error("Could not play audio", err);
        }
      });
    },
  }));

  return (
    <div className="avatar-stage">
      <div ref={hostRef} className="avatar-canvas" />

      {/* Camera View Controls */}
      <div className="avatar-controls-top">
        <div className="avatar-title-badge">
          <span className="dot pulse" />
          <span>{assistantName} (3D Avatar)</span>
        </div>
        <div className="view-switch-group">
          {["head", "upper", "full"].map((v) => (
            <button
              key={v}
              className={`view-btn ${currentView === v ? "active" : ""}`}
              onClick={() => changeView(v)}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {state.phase === "loading" && (
        <div className="avatar-overlay">
          <div className="spinner" />
          <p>Loading 3D avatar{state.progress ? ` · ${state.progress}%` : "…"}</p>
        </div>
      )}
      {state.phase === "error" && (
        <div className="avatar-overlay error">
          <p>{state.error}</p>
        </div>
      )}
    </div>
  );
});

export default AvatarStage;
