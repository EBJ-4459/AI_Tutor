"""
attention_server.py: Standalone Visual Attention Checker Monitor Server.
Runs on Port 8001 (http://localhost:8001).

Provides:
- Web-based Visual Attention HUD with live webcam feed, 3D head pose & EAR gauges
- WebSocket /attention_stream for real-time telemetry streaming
- REST APIs for telemetry inspection, sensitivity thresholds & simulated tests
- Bi-directional synchronization with Main App Backend (port 8000)
"""

import os
import json
import time
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.attention_tracker import attention_tracker
from app.config import settings

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("attention-server")

app = FastAPI(
    title="Visual Attention Checker HUD",
    version="1.0.0",
    description="Dedicated Real-time Attention & Drowsiness Tracker Monitor",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent / "static_attention"
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Telemetry log history for the HUD
telemetry_event_log: List[Dict[str, Any]] = []
_forward_client: Optional[httpx.AsyncClient] = None


async def forward_to_main_backend(payload: Dict[str, Any]) -> None:
    """Pushes attention telemetry to Port 8000 so the 3D Avatar reacts immediately."""
    global _forward_client
    try:
        if _forward_client is None or _forward_client.is_closed:
            _forward_client = httpx.AsyncClient(timeout=1.5)
        await _forward_client.post("http://127.0.0.1:8000/api/attention/telemetry", json=payload)
    except Exception as exc:
        logger.debug("Telemetry forward skipped: %s", exc)


@app.get("/")
async def serve_hud():
    """Serves the interactive Attention Checker HUD."""
    index_path = STATIC_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return HTMLResponse("<h1>Attention Checker HUD</h1><p>Please place index.html in static_attention.</p>")


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "port": settings.attention_port,
        "main_backend": "http://localhost:8000",
        "thresholds": {
            "yaw_deg": attention_tracker.yaw_threshold,
            "ear": attention_tracker.ear_threshold,
            "eyes_closed_sec": attention_tracker.eyes_closed_sec,
        },
    }


@app.get("/api/status")
async def get_status():
    return {
        "telemetry": attention_tracker.latest_telemetry,
        "thresholds": {
            "yaw_deg": attention_tracker.yaw_threshold,
            "ear": attention_tracker.ear_threshold,
            "eyes_closed_sec": attention_tracker.eyes_closed_sec,
        },
        "event_history": telemetry_event_log[-20:],
    }


class ThresholdUpdateRequest(BaseModel):
    yaw_threshold: Optional[float] = None
    ear_threshold: Optional[float] = None
    eyes_closed_sec: Optional[float] = None


@app.post("/api/thresholds")
async def update_thresholds(req: ThresholdUpdateRequest):
    if req.yaw_threshold is not None:
        attention_tracker.yaw_threshold = float(req.yaw_threshold)
    if req.ear_threshold is not None:
        attention_tracker.ear_threshold = float(req.ear_threshold)
    if req.eyes_closed_sec is not None:
        attention_tracker.eyes_closed_sec = float(req.eyes_closed_sec)
    return {
        "ok": True,
        "thresholds": {
            "yaw_deg": attention_tracker.yaw_threshold,
            "ear": attention_tracker.ear_threshold,
            "eyes_closed_sec": attention_tracker.eyes_closed_sec,
        },
    }


class SimRequest(BaseModel):
    type: str = "normal"  # "yaw" | "drowsy" | "normal"
    session_id: str = "default"


@app.post("/api/simulate")
async def simulate_event(req: SimRequest):
    result = attention_tracker.simulate(req.type, session_id=req.session_id)
    # Log event
    telemetry_event_log.append(
        {
            "timestamp": time.time(),
            "time_str": time.strftime("%H:%M:%S"),
            "status": result["status"],
            "reason": result["reason"],
            "simulated": True,
        }
    )
    # Forward to main backend (port 8000)
    await forward_to_main_backend({"session_id": req.session_id, **result})
    return result


@app.websocket("/attention_stream")
async def attention_stream_endpoint(websocket: WebSocket, session_id: str = "default"):
    await websocket.accept()
    logger.info(f"Attention Stream connected for session: {session_id}")
    last_forward_ts = 0.0
    prev_distracted: Optional[bool] = None
    try:
        while True:
            data = await websocket.receive_json()
            width = data.get("width", 640)
            height = data.get("height", 480)

            result = None
            if "landmarks" in data:
                result = attention_tracker.process_landmarks(
                    data["landmarks"],
                    session_id=session_id,
                    image_width=width,
                    image_height=height,
                )
            elif data.get("no_face"):
                result = attention_tracker.process_no_face(session_id=session_id)
            elif "simulate" in data:
                result = attention_tracker.simulate(data["simulate"], session_id=session_id)

            if result:
                now = time.time()
                is_distracted = bool(result.get("is_distracted"))
                state_changed = prev_distracted is None or (is_distracted != prev_distracted)
                prev_distracted = is_distracted

                # If status changed or distracted, record event
                if is_distracted and (state_changed or result.get("trigger_prompt_override")):
                    telemetry_event_log.append(
                        {
                            "timestamp": now,
                            "time_str": time.strftime("%H:%M:%S"),
                            "status": result["status"],
                            "reason": result["reason"],
                            "metrics": result["metrics"],
                        }
                    )

                # Forward immediately on state transition / alert trigger, or every 0.4s for live HUD sync
                if state_changed or result.get("trigger_prompt_override") or (now - last_forward_ts >= 0.4):
                    last_forward_ts = now
                    await forward_to_main_backend({"session_id": session_id, **result})

                await websocket.send_json(result)

    except WebSocketDisconnect:
        logger.info(f"Attention Stream disconnected for session: {session_id}")
    except Exception as e:
        logger.warning(f"WebSocket error: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.attention_port)
