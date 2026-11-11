import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

const SR = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function pickRecorderMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
}

/**
 * Speech-to-text.
 *  - "webspeech": browser Web Speech API, continuous, with interim results (Chrome, Edge, Safari).
 *  - "recorder":  MediaRecorder + server-side transcription (/api/stt) for browsers without it (Firefox).
 *  - "none":      no voice input available; the UI falls back to typing.
 * Callbacks: onInterim(text) while speaking, onFinal(text) for a finished utterance,
 * onStart() when listening begins, onError(message).
 */
export function useVoiceInput({ lang, serverStt, onInterim, onFinal, onStart, onError }) {
  const mode = SR
    ? "webspeech"
    : serverStt && navigator.mediaDevices?.getUserMedia && window.MediaRecorder
    ? "recorder"
    : "none";

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [transcribing, setTranscribing] = useState(false);

  const cb = useRef({});
  cb.current = { onInterim, onFinal, onStart, onError };
  const wantRef = useRef(false);
  const recRef = useRef(null);
  const recorderRef = useRef(null);

  // ---- Web Speech API
  const startWeb = useCallback(() => {
    const rec = new SR();
    rec.lang = lang || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let partial = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          setInterim("");
          if (text) cb.current.onFinal?.(text);
        } else {
          partial += r[0].transcript;
        }
      }
      if (partial) {
        setInterim(partial);
        cb.current.onInterim?.(partial);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        wantRef.current = false;
        setListening(false);
        cb.current.onError?.("Microphone permission was denied. Allow it in your browser and try again.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        cb.current.onError?.(`Speech recognition error: ${e.error}`);
      }
    };
    rec.onend = () => {
      if (wantRef.current) {
        setTimeout(() => wantRef.current && startWeb(), 200); // Chrome ends sessions after silence
      } else {
        setListening(false);
        setInterim("");
      }
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
  }, [lang]);

  // ---- MediaRecorder fallback
  const startRecorder = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const mime = pickRecorderMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 1500) return;
        setTranscribing(true);
        try {
          const { text } = await api.transcribe(blob);
          if (text) cb.current.onFinal?.(text);
        } catch (err) {
          cb.current.onError?.(`Transcription failed: ${err.message}`);
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      cb.current.onStart?.();
    } catch {
      wantRef.current = false;
      setListening(false);
      cb.current.onError?.("Could not access the microphone.");
    }
  }, []);

  const start = useCallback(() => {
    if (mode === "none" || wantRef.current) return;
    wantRef.current = true;
    setListening(true);
    if (mode === "webspeech") startWeb();
    else startRecorder();
  }, [mode, startWeb, startRecorder]);

  const stop = useCallback(() => {
    wantRef.current = false;
    setListening(false);
    setInterim("");
    if (mode === "webspeech") {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
    } else if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, [mode]);

  const toggle = useCallback(() => (wantRef.current ? stop() : start()), [start, stop]);

  useEffect(() => () => {
    wantRef.current = false;
    try {
      recRef.current?.abort();
    } catch {
      /* ignore */
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }, []);

  return { mode, listening, interim, transcribing, start, stop, toggle };
}
