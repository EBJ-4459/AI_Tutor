import React, { useState, useEffect, useRef, useCallback } from "react";
import { attentionWsUrl, api } from "../lib/api.js";

export default function BackgroundAttentionMonitor({
  enabled = true,
  onDistractionDetected,
  onCameraStatusChange,
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("Attentive");
  const [metrics, setMetrics] = useState({
    yaw_deg: 0,
    pitch_deg: 0,
    ear: 0.34,
    eyes_closed_duration_sec: 0,
  });
  const [cameraActive, setCameraActive] = useState(false);
  const [camError, setCamError] = useState("");
  const [focusScore, setFocusScore] = useState(92);

  const wrapperRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const wsRef = useRef(null);
  const cameraRef = useRef(null);
  const faceMeshRef = useRef(null);
  const streamRef = useRef(null);
  const workerRef = useRef(null);
  const lastFrameSentRef = useRef(0);
  const cameraActiveRef = useRef(false);
  cameraActiveRef.current = cameraActive;

  const onDistractionRef = useRef(onDistractionDetected);
  onDistractionRef.current = onDistractionDetected;

  // Close popover when clicking outside
  useEffect(() => {
    if (!open) return undefined;
    const handleOutsideClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  const computeTargetScore = useCallback((data) => {
    if (!data || !data.metrics) return 92;
    if (data.is_distracted) {
      const m = data.metrics;
      const yawPen = Math.min(55, Math.abs(m.yaw_deg || 0) * 1.1);
      const closedPen = (m.eyes_closed_duration_sec || 0) > 0 ? 35 : 0;
      return Math.max(18, Math.min(48, Math.round(75 - yawPen - closedPen)));
    }
    const m = data.metrics;
    const yaw = Math.abs(m.yaw_deg || 0);
    const pitch = Math.abs(m.pitch_deg || 0);
    const ear = m.ear ?? 0.32;
    const yawPenalty = Math.max(0, (yaw - 4) * 1.4);
    const pitchPenalty = Math.max(0, (pitch - 6) * 1.1);
    const earPenalty = ear > 0 && ear < 0.21 ? 22 : 0;
    return Math.max(55, Math.min(99, Math.round(98 - yawPenalty - pitchPenalty - earPenalty)));
  }, []);

  const applyTelemetry = useCallback(
    (data) => {
      if (!data || !data.metrics) return;
      if (!cameraActiveRef.current) return;
      setStatus(data.status || (data.is_distracted ? "Distracted" : "Attentive"));
      setMetrics(data.metrics);
      const target = computeTargetScore(data);
      setFocusScore((prev) => Math.round(prev * 0.65 + target * 0.35));
      onDistractionRef.current?.(data);
    },
    [computeTargetScore]
  );

  // Connect to /ws/attention
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let reconnectTimer = null;

    const connectWs = () => {
      if (disposed) return;
      try {
        const ws = new WebSocket(attentionWsUrl());
        wsRef.current = ws;

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            applyTelemetry(data);
          } catch {
            // ignore malformed packet
          }
        };

        ws.onerror = () => ws.close();
        ws.onclose = () => {
          if (!disposed) {
            reconnectTimer = setTimeout(connectWs, 2500);
          }
        };
      } catch {
        if (!disposed) {
          reconnectTimer = setTimeout(connectWs, 3000);
        }
      }
    };

    connectWs();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, applyTelemetry]);

  const stopCamera = useCallback(() => {
    try {
      workerRef.current?.postMessage("stop");
      workerRef.current?.terminate?.();
    } catch {
      // ignore
    }
    workerRef.current = null;

    try {
      cameraRef.current?.stop?.();
    } catch {
      // ignore
    }
    cameraRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    cameraActiveRef.current = false;
    setCameraActive(false);
    onCameraStatusChange?.(false);
    setStatus("Attentive");
    setFocusScore(92);
    onDistractionRef.current?.({ is_distracted: false });
    api.simulateAttention("normal").catch(() => {});
  }, []);

  const startCamera = useCallback(async () => {
    if (streamRef.current) return;
    setCamError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("Camera API is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 480, height: 320, facingMode: "user" },
      });
      streamRef.current = stream;
      cameraActiveRef.current = true;
      setCameraActive(true);
      onCameraStatusChange?.(true);

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      const { FaceMesh, Camera } = window;
      if (FaceMesh && videoRef.current) {
        if (!faceMeshRef.current) {
          const fm = new FaceMesh({
            locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
          });
          fm.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          fm.onResults((results) => {
            const canvas = canvasRef.current;
            if (canvas) {
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                const lms = results.multiFaceLandmarks?.[0];
                if (lms) {
                  const keyIndices = [1, 33, 133, 362, 263, 152, 61, 291];
                  ctx.fillStyle = "#10b981";
                  for (const idx of keyIndices) {
                    const pt = lms[idx];
                    if (!pt) continue;
                    ctx.beginPath();
                    ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 2.5, 0, 2 * Math.PI);
                    ctx.fill();
                  }
                }
              }
            }

            if (wsRef.current?.readyState === WebSocket.OPEN) {
              if (results.multiFaceLandmarks?.[0]) {
                wsRef.current.send(
                  JSON.stringify({
                    landmarks: results.multiFaceLandmarks[0],
                    width: 480,
                    height: 320,
                  })
                );
              } else {
                wsRef.current.send(JSON.stringify({ no_face: true }));
              }
              return;
            }

            // Local browser head-pose & EAR fallback (for Vercel standalone deployment)
            const lms = results.multiFaceLandmarks?.[0];
            const nowSec = performance.now() / 1000;
            if (!lms) {
              if (!faceMeshRef.current._noFaceSince) faceMeshRef.current._noFaceSince = nowSec;
              const awaySec = nowSec - faceMeshRef.current._noFaceSince;
              const distracted = awaySec > 2.2;
              applyTelemetry({
                status: distracted ? "Distracted" : "Attentive",
                is_distracted: distracted,
                reason: distracted ? "Face not visible / stepped away" : "",
                metrics: { yaw_deg: 35, pitch_deg: 0, ear: 0, eyes_closed_duration_sec: 0 },
              });
              return;
            }
            faceMeshRef.current._noFaceSince = null;

            const dist = (a, b) => Math.hypot((a.x - b.x) * 480, (a.y - b.y) * 320);
            const leftEar =
              (dist(lms[160], lms[144]) + dist(lms[158], lms[153])) /
              Math.max(1e-4, 2 * dist(lms[33], lms[133]));
            const rightEar =
              (dist(lms[385], lms[380]) + dist(lms[387], lms[373])) /
              Math.max(1e-4, 2 * dist(lms[362], lms[263]));
            const ear = Number(((leftEar + rightEar) / 2).toFixed(3));

            const eyeMidX = (lms[33].x + lms[263].x) / 2;
            const eyeSpan = Math.max(0.05, Math.abs(lms[263].x - lms[33].x));
            const yaw_deg = Number((((lms[1].x - eyeMidX) / (eyeSpan * 0.5)) * 42).toFixed(1));

            const faceH = Math.max(0.08, Math.abs(lms[152].y - lms[10].y));
            const pitch_deg = Number(((((lms[1].y - lms[10].y) / faceH) - 0.56) * 85).toFixed(1));

            if (ear < 0.2) {
              if (!faceMeshRef.current._eyesClosedSince) faceMeshRef.current._eyesClosedSince = nowSec;
            } else {
              faceMeshRef.current._eyesClosedSince = null;
            }
            const closedSec = faceMeshRef.current._eyesClosedSince
              ? Number((nowSec - faceMeshRef.current._eyesClosedSince).toFixed(1))
              : 0;

            const lookingAway = Math.abs(yaw_deg) > 25 || Math.abs(pitch_deg) > 26;
            const drowsy = closedSec >= 2.5;
            const distracted = lookingAway || drowsy;
            const reason = drowsy
              ? "Eyes closed / drowsy"
              : lookingAway
              ? "Looking away from screen"
              : "Attentive and engaged";

            applyTelemetry({
              status: distracted ? "Distracted" : "Attentive",
              is_distracted: distracted,
              reason,
              metrics: { yaw_deg, pitch_deg, ear, eyes_closed_duration_sec: closedSec },
            });
          });
          faceMeshRef.current = fm;
        }

        if (Camera) {
          const cam = new Camera(videoRef.current, {
            onFrame: async () => {
              if (document.hidden) return;
              const now = performance.now();
              if (now - lastFrameSentRef.current < 130) return;
              lastFrameSentRef.current = now;
              if (videoRef.current && faceMeshRef.current) {
                try {
                  await faceMeshRef.current.send({ image: videoRef.current });
                } catch {
                  // ignore frame error
                }
              }
            },
            width: 480,
            height: 320,
          });
          cameraRef.current = cam;
          cam.start();
        }

        // Background Web Worker keep-alive so tracking continues even if tab is backgrounded
        try {
          const blob = new Blob(
            [
              "let t=null;self.onmessage=e=>{if(e.data==='start'){t=setInterval(()=>self.postMessage('tick'),250);}else{clearInterval(t);}};",
            ],
            { type: "application/javascript" }
          );
          const worker = new Worker(URL.createObjectURL(blob));
          let busy = false;
          worker.onmessage = async () => {
            if (document.hidden && videoRef.current && faceMeshRef.current && !busy) {
              busy = true;
              try {
                await faceMeshRef.current.send({ image: videoRef.current });
              } catch {
                // ignore
              } finally {
                busy = false;
              }
            }
          };
          worker.postMessage("start");
          workerRef.current = worker;
        } catch {
          // ignore worker fallback error
        }
      }
    } catch (err) {
      setCameraActive(false);
      setCamError("Could not access camera. Please allow camera permissions or close other apps using it.");
      console.warn("Camera start error:", err);
    }
  }, []);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    onCameraStatusChange?.(cameraActive);
  }, [cameraActive, onCameraStatusChange]);

  const toggleCamera = (e) => {
    e?.stopPropagation();
    if (cameraActive) {
      stopCamera();
    } else {
      startCamera();
    }
  };

  const isDistracted = cameraActive && status === "Distracted";
  const barColorClass =
    focusScore >= 70 ? "high" : focusScore >= 45 ? "medium" : "low";

  return (
    <div className="awareness-popover-anchor" ref={wrapperRef}>
      {/* Topbar Trigger Button right next to Light/Dark Mode */}
      <button
        type="button"
        className={`awareness-trigger-btn ${open ? "open" : ""} ${cameraActive ? "cam-on" : ""} ${isDistracted ? "distracted" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Click to open Camera & Awareness Eye Contact"
      >
        <span className={`awareness-trigger-dot ${cameraActive ? (isDistracted ? "danger" : "live") : "idle"}`} />
        <svg
          className="awareness-trigger-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>Camera</span>
        <span className="awareness-trigger-score">{focusScore}%</span>
      </button>

      {/* Expandable Small Box (kept mounted so camera keeps running even when closed) */}
      <div
        className={`awareness-dropdown-card ${open ? "expanded" : "collapsed"} ${isDistracted ? "is-distracted" : ""}`}
        aria-hidden={!open}
      >
        {/* Header Row */}
        <div className="awareness-header">
          <div className="awareness-title-group">
            <svg
              className="awareness-eye-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <h3 className="awareness-title">Camera &amp; Eye Contact</h3>
          </div>

          <button
            type="button"
            className={`awareness-cam-btn ${cameraActive ? "active" : ""}`}
            onClick={toggleCamera}
          >
            <svg
              className="awareness-cam-btn-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
            <span>{cameraActive ? "Stop Camera" : "Start Camera"}</span>
          </button>
        </div>

        {/* Camera / Placeholder Viewport */}
        <div className={`awareness-viewport ${cameraActive ? "live" : "idle"}`}>
          <video
            ref={videoRef}
            playsInline
            muted
            className={`awareness-video ${cameraActive ? "visible" : "hidden"}`}
          />
          <canvas
            ref={canvasRef}
            width={480}
            height={320}
            className={`awareness-canvas ${cameraActive ? "visible" : "hidden"}`}
          />

          {cameraActive ? (
            <div className="awareness-live-hud">
              <span className={`awareness-status-badge ${isDistracted ? "distracted" : "attentive"}`}>
                <span className="status-dot" />
                {isDistracted ? "Distracted — Pay Attention!" : "Attentive & Focused"}
              </span>
              <span className="awareness-metrics-badge">
                Yaw: {metrics.yaw_deg > 0 ? "+" : ""}
                {metrics.yaw_deg}° &bull; EAR: {metrics.ear}
              </span>
            </div>
          ) : (
            <div className="awareness-placeholder" onClick={startCamera}>
              <svg
                className="awareness-placeholder-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3.2" />
              </svg>
              <p className="awareness-placeholder-text">
                Enable your camera to track eye contact, posture, and active focus during lessons.
              </p>
              <span className="awareness-privacy-note">
                {camError ||
                  "Privacy First: All computer-vision analysis runs 100% locally in your browser."}
              </span>
            </div>
          )}
        </div>

        {/* Engagement & Focus Score Footer */}
        <div className="awareness-footer">
          <div className="awareness-score-row">
            <span className="awareness-score-label">Engagement &amp; Focus Score</span>
            <span className="awareness-score-value">{focusScore}%</span>
          </div>
          <div className="awareness-progress-track">
            <div
              className={`awareness-progress-fill ${barColorClass}`}
              style={{ width: `${focusScore}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
