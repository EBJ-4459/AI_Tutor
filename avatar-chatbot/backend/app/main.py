import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Optional, List, Dict, Any, Set

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import stt
from .config import settings, DISTRACTION_SYSTEM_PROMPT, PERSONAS
from .db import Database
from .llm import LLMNotConfigured, stream_chat
from .rag_engine import rag_engine
from .attention_tracker import attention_tracker
from .security import limiter, origin_allowed, require_client, token_ok, valid_client_id
from .textstream import SentenceSplitter, TagParser, is_speakable
from .tts import TTSNotConfigured, synthesize

log = logging.getLogger("avatar-chat")
logging.basicConfig(level=logging.INFO)

db = Database(settings.db_path)
app = FastAPI(title="AI Tutor & Avatar API", docs_url="/api/docs", openapi_url="/api/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|.*\.vercel\.app)(:\d+)?$",
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "X-Client-Id", "Content-Type"],
)


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Permissions-Policy", "microphone=(self), camera=(self)")
        return resp


app.add_middleware(SecurityHeaders)


# ------------------------------------------------------------------ Startup / Seeding
async def _deferred_seed():
    """Runs in the background AFTER Uvicorn binds to the port so cloud port scanners (Render/Railway) never time out."""
    await asyncio.sleep(3)
    try:
        await asyncio.to_thread(lambda: rag_engine.embeddings)
    except Exception as e:
        log.warning("Could not pre-warm embeddings: %s", e)


@app.on_event("startup")
async def seed_sample_docs():
    """Schedules background embedding warm-up without blocking port binding."""
    asyncio.create_task(_deferred_seed())


# ------------------------------------------------------------------ Configuration & Health
@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "assistant_name": settings.assistant_name,
        "attention_port": settings.attention_port,
    }


@app.get("/api/config")
async def get_config():
    collections = await asyncio.to_thread(db.list_collections)
    return {
        "auth_required": bool(settings.app_token),
        "assistant_name": settings.assistant_name,
        "llm_provider": settings.llm_provider,
        "tts_provider": settings.tts_provider,
        "stt_server_available": bool(settings.openai_key),
        "max_message_chars": settings.max_message_chars,
        "attention_port": settings.attention_port,
        "personas": list(PERSONAS.keys()),
        "collections": collections,
        "default_collection": "general",
        "avatar": {
            "url": settings.avatar_url,
            "body": settings.avatar_body,
            "lipsyncLang": settings.lipsync_lang,
        },
    }


# ------------------------------------------------------------------ Chat Sessions
@app.get("/api/sessions")
async def list_sessions(client_id: str = Depends(require_client)):
    return await asyncio.to_thread(db.list_sessions, client_id)


@app.post("/api/sessions")
async def create_session(client_id: str = Depends(require_client)):
    return await asyncio.to_thread(db.create_session, client_id)


@app.get("/api/sessions/{session_id}/messages")
async def get_messages(session_id: str, client_id: str = Depends(require_client)):
    if not await asyncio.to_thread(db.get_session, client_id, session_id):
        raise HTTPException(404, "Session not found")
    msgs = await asyncio.to_thread(db.messages, session_id)
    # Parse stored sources_json if present
    for m in msgs:
        if m.get("sources_json"):
            try:
                m["sources"] = json.loads(m["sources_json"])
            except Exception:
                m["sources"] = []
    return msgs


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, client_id: str = Depends(require_client)):
    if not await asyncio.to_thread(db.delete_session, client_id, session_id):
        raise HTTPException(404, "Session not found")
    return {"ok": True}


# ------------------------------------------------------------------ STT
MAX_AUDIO_BYTES = 10 * 1024 * 1024


@app.post("/api/stt")
async def speech_to_text(file: UploadFile = File(...), client_id: str = Depends(require_client)):
    if not settings.openai_key:
        raise HTTPException(501, "Server-side speech recognition is not configured")
    if not limiter.allow("stt:" + client_id):
        raise HTTPException(429, "Too many requests, slow down")
    content = await file.read(MAX_AUDIO_BYTES + 1)
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio too large")
    if not content:
        raise HTTPException(400, "Empty audio")
    try:
        text = await stt.transcribe(file.filename or "speech.webm", content, file.content_type or "audio/webm")
    except Exception as e:
        log.exception("STT failed")
        raise HTTPException(502, "Transcription failed") from e
    return {"text": text}


# ------------------------------------------------------------------ Document Management (Partition 3)
class DocumentUpdateRequest(BaseModel):
    title: Optional[str] = None
    collection: Optional[str] = None
    is_active: Optional[bool] = None
    custom_notes: Optional[str] = None


class DocumentQueryRequest(BaseModel):
    query: str
    collection: str = "calculus_101"
    top_k: int = 3


@app.get("/api/documents")
async def list_documents(collection: Optional[str] = None):
    return await asyncio.to_thread(db.list_documents, collection)


@app.get("/api/collections")
async def list_collections():
    return await asyncio.to_thread(db.list_collections)


@app.post("/api/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    collection: str = Form("calculus_101"),
    title: Optional[str] = Form(None),
    custom_notes: Optional[str] = Form(""),
):
    """Uploads, chunks, and indexes a textbook / document into ChromaDB."""
    filename = file.filename or "document.pdf"
    doc_id = "doc_" + uuid.uuid4().hex[:12]
    doc_title = title.strip() if title and title.strip() else Path(filename).stem.replace("_", " ").title()

    save_path = Path(settings.upload_dir) / f"{doc_id}_{filename}"
    contents = await file.read()
    with open(save_path, "wb") as f:
        f.write(contents)

    try:
        # Ingest into vector store
        ingest_res = await asyncio.to_thread(
            rag_engine.ingest_document,
            doc_id=doc_id,
            file_path_or_bytes=contents,
            filename=filename,
            collection_name=collection.strip().lower(),
        )

        doc_record = await asyncio.to_thread(
            db.create_document,
            doc_id=doc_id,
            filename=save_path.name,
            original_name=filename,
            collection=collection.strip().lower(),
            title=doc_title,
            file_size=len(contents),
            pages_count=ingest_res["pages_extracted"],
            chunks_count=ingest_res["chunks_created"],
            custom_notes=custom_notes or "",
        )
        return doc_record

    except Exception as e:
        log.exception("Document ingestion failed: %s", e)
        if save_path.exists():
            save_path.unlink()
        raise HTTPException(500, f"Document ingestion failed: {str(e)}")


@app.get("/api/documents/{doc_id}")
async def get_document_details(doc_id: str):
    doc = await asyncio.to_thread(db.get_document, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    chunks = await asyncio.to_thread(
        rag_engine.get_document_chunks, doc_id, doc["collection"]
    )
    return {"document": doc, "chunks": chunks}


@app.put("/api/documents/{doc_id}")
async def update_document(doc_id: str, body: DocumentUpdateRequest):
    doc = await asyncio.to_thread(
        db.update_document,
        doc_id=doc_id,
        title=body.title,
        collection=body.collection,
        is_active=body.is_active,
        custom_notes=body.custom_notes,
    )
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    doc = await asyncio.to_thread(db.get_document, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")

    # Delete from vector store
    await asyncio.to_thread(rag_engine.delete_document, doc_id, doc["collection"])

    # Remove physical file if present
    file_path = Path(settings.upload_dir) / doc["filename"]
    if file_path.exists():
        try:
            file_path.unlink()
        except Exception:
            pass

    # Delete from DB
    await asyncio.to_thread(db.delete_document, doc_id)
    return {"ok": True, "deleted_id": doc_id}


@app.post("/api/documents/query")
async def test_document_query(req: DocumentQueryRequest):
    """Allows testing retrieval relevance without modifying chat history."""
    docs = await asyncio.to_thread(db.list_documents, req.collection)
    active_ids = [d["id"] for d in docs if d["is_active"]]
    res = await asyncio.to_thread(
        rag_engine.retrieve_context,
        query=req.query,
        collection_name=req.collection,
        top_k=req.top_k,
        active_doc_ids=active_ids,
    )
    return res


# ------------------------------------------------------------------ Attention Tracking & HUD APIs
attention_ws_clients: Set[WebSocket] = set()


async def broadcast_attention(payload: Dict[str, Any]) -> None:
    """Broadcasts live attention telemetry to all connected main-UI clients immediately."""
    if not attention_ws_clients:
        return
    dead: List[WebSocket] = []
    for client_ws in list(attention_ws_clients):
        try:
            await client_ws.send_json(payload)
        except Exception:
            dead.append(client_ws)
    for client_ws in dead:
        attention_ws_clients.discard(client_ws)


class AttentionSimulateRequest(BaseModel):
    type: str = "normal"  # "yaw" | "drowsy" | "normal"
    session_id: str = "default"


class AttentionTelemetryRequest(BaseModel):
    session_id: str = "default"
    status: Optional[str] = None
    is_distracted: Optional[bool] = None
    trigger_prompt_override: Optional[bool] = None
    reason: Optional[str] = None
    metrics: Optional[Dict[str, Any]] = None
    timestamp: Optional[float] = None
    no_face: Optional[bool] = None
    landmarks: Optional[List[Dict[str, float]]] = None
    yaw: Optional[float] = None
    yaw_deg: Optional[float] = None
    pitch: Optional[float] = None
    pitch_deg: Optional[float] = None
    roll: Optional[float] = None
    roll_deg: Optional[float] = None
    ear: Optional[float] = None


@app.get("/api/attention/status")
async def get_attention_status():
    return attention_tracker.latest_telemetry


@app.post("/api/attention/simulate")
async def simulate_attention(req: AttentionSimulateRequest):
    res = attention_tracker.simulate(req.type, session_id=req.session_id)
    await broadcast_attention(res)
    return res


@app.post("/api/attention/telemetry")
async def post_attention_telemetry(req: AttentionTelemetryRequest):
    if req.status is not None and req.metrics is not None:
        # Direct telemetry snapshot forwarded from standalone Port 8001 Attention Server
        res = {
            "status": req.status,
            "is_distracted": bool(req.is_distracted),
            "trigger_prompt_override": bool(req.trigger_prompt_override),
            "reason": req.reason or ("Distracted" if req.is_distracted else "Attentive and engaged"),
            "metrics": req.metrics,
            "timestamp": req.timestamp or time.time(),
        }
        attention_tracker.latest_telemetry = res
        await broadcast_attention(res)
    elif req.landmarks:
        res = attention_tracker.process_landmarks(req.landmarks, session_id=req.session_id)
        await broadcast_attention(res)
    elif req.no_face:
        res = attention_tracker.process_no_face(session_id=req.session_id)
        await broadcast_attention(res)
    elif (req.yaw is not None or req.yaw_deg is not None) and req.ear is not None:
        yaw_val = req.yaw if req.yaw is not None else (req.yaw_deg or 0.0)
        pitch_val = req.pitch if req.pitch is not None else (req.pitch_deg or 0.0)
        roll_val = req.roll if req.roll is not None else (req.roll_deg or 0.0)
        res = attention_tracker.evaluate_attention(
            yaw=yaw_val,
            pitch=pitch_val,
            roll=roll_val,
            ear=req.ear,
            session_id=req.session_id,
        )
        await broadcast_attention(res)
    else:
        res = attention_tracker.latest_telemetry
    return res


# ------------------------------------------------------------------ Conversation Turn with RAG & Lip Sync
async def run_turn(
    send,
    session_id: str,
    turn_id: str,
    history: list[dict],
    persona: str = "socratic",
    collection: str = "calculus_101",
    system_override: Optional[str] = None,
) -> None:
    """Streams LLM text -> sentences -> Edge-TTS audio + visemes to the client."""
    parser = TagParser()
    splitter = SentenceSplitter()
    queue: asyncio.Queue = asyncio.Queue()
    sent_text: list[str] = []
    state = {"mood": None, "tts_failed": False}

    # Step 1: Perform RAG retrieval for the user's latest query
    sources = []
    rag_context = ""
    if history and history[-1]["role"] == "user":
        latest_query = history[-1]["content"]
        try:
            docs = await asyncio.to_thread(db.list_documents, collection)
            active_docs = [d for d in docs if d["is_active"]]
            if active_docs:
                by_coll: Dict[str, List[str]] = {}
                for d in active_docs:
                    c_name = (d.get("collection") or "calculus_101").strip().lower()
                    by_coll.setdefault(c_name, []).append(d["id"])
                all_sources = []
                all_contexts = []
                for c_name, doc_ids in by_coll.items():
                    rag_res = await asyncio.to_thread(
                        rag_engine.retrieve_context,
                        query=latest_query,
                        collection_name=c_name,
                        top_k=settings.retrieval_top_k,
                        active_doc_ids=doc_ids,
                    )
                    if rag_res.get("sources"):
                        all_sources.extend(rag_res["sources"])
                    if rag_res.get("context"):
                        all_contexts.append(rag_res["context"])
                sources = all_sources[: settings.retrieval_top_k]
                rag_context = "\n\n".join(all_contexts)
                if sources:
                    await send({"type": "rag_sources", "turn": turn_id, "sources": sources})
        except Exception as e:
            log.warning("RAG retrieval failed: %s", e)

    # Step 2: Build tailored System Instruction with Persona & RAG Context
    if system_override:
        system = system_override
    else:
        system = settings.system_text(persona=persona)
        if rag_context:
            system += (
                f"\n\n--- TEXTBOOK KNOWLEDGE (CITE IN NATURAL CONVERSATION) ---\n"
                f"{rag_context}\n"
                f"--- END TEXTBOOK KNOWLEDGE ---\n"
                f"Instruction: Use the textbook facts above to answer the student's question accurately. "
                f"Explain concepts step-by-step and cite textbook definitions where appropriate."
            )

    def enqueue_sentences(pieces: list[str]) -> None:
        for piece in pieces:
            queue.put_nowait((piece, state["mood"]))
            state["mood"] = None

    async def handle(kind: str, value: str) -> None:
        if kind == "mood":
            state["mood"] = value
        else:
            await send({"type": "text_delta", "turn": turn_id, "text": value})
            enqueue_sentences(splitter.feed(value))

    async def producer() -> None:
        try:
            async for delta in stream_chat(history, system=system):
                for kind, value in parser.feed(delta):
                    await handle(kind, value)
            for kind, value in parser.flush():
                await handle(kind, value)
            enqueue_sentences(splitter.flush())
        finally:
            queue.put_nowait(None)

    async def consumer() -> None:
        seq = 0
        while True:
            item = await queue.get()
            if item is None:
                return
            text, mood = item
            if is_speakable(text) and not state["tts_failed"]:
                try:
                    result = await synthesize(text)
                    if result:
                        await send(
                            {
                                "type": "audio",
                                "turn": turn_id,
                                "seq": seq,
                                "text": text,
                                "mood": mood,
                                **result.to_event(),
                            }
                        )
                        seq += 1
                except TTSNotConfigured as e:
                    log.warning("TTS not configured: %s", e)
                    state["tts_failed"] = True
                    await send({"type": "error", "turn": turn_id, "message": f"Voice unavailable: {e}"})
                except Exception as e:
                    log.warning("TTS synthesis failed for clip: %s", e)
            elif mood:
                await send({"type": "mood", "turn": turn_id, "mood": mood})
            sent_text.append(text)

    prod = asyncio.create_task(producer())
    cons = asyncio.create_task(consumer())
    interrupted, error = False, None
    try:
        await asyncio.gather(prod, cons)
    except asyncio.CancelledError:
        interrupted = True
    except LLMNotConfigured as e:
        error = str(e)
    except Exception as e:
        log.exception("Turn failed: %s", e)
        err_msg = str(e)
        if "API_KEY" in err_msg or "api_key" in err_msg:
            error = "Gemini API key is invalid or missing. Please check backend/.env."
        elif "503" in err_msg or "UNAVAILABLE" in err_msg:
            error = "The AI service is experiencing high traffic. Please try again in a moment."
        else:
            error = f"Language model error: {err_msg[:120]}"
    finally:
        for t in (prod, cons):
            t.cancel()
        await asyncio.gather(prod, cons, return_exceptions=True)

    text = " ".join(sent_text).strip()
    message_id = None
    sources_json = json.dumps(sources) if sources else ""
    if text:
        message_id = await asyncio.to_thread(
            db.add_message, session_id, "assistant", text, interrupted, sources_json
        )
    try:
        await send(
            {
                "type": "turn_end",
                "turn": turn_id,
                "interrupted": interrupted,
                "error": error,
                "message_id": message_id,
                "sources": sources,
            }
        )
    except Exception:
        pass


async def run_distraction_nudge(
    send,
    session_id: str,
    turn_id: str,
    reason: str = "",
) -> None:
    """Delivers an immediate, lip-synced spoken distraction alert and cue via the 3D avatar."""
    lower_reason = (reason or "").lower()
    if "drows" in lower_reason or "eyes closed" in lower_reason:
        nudge_text = (
            "Hey, I noticed you got distracted and your eyes were closing! "
            "Pay attention here, let's stay focused together!"
        )
    elif "stepped away" in lower_reason or "face not visible" in lower_reason:
        nudge_text = (
            "Hey, you got distracted and stepped away! "
            "Pay attention here, let's get right back to your lesson!"
        )
    else:
        nudge_text = (
            "Hey, I noticed you got distracted! "
            "Pay attention here, let's stay focused on our lesson!"
        )

    interrupted = False
    error = None
    message_id = None
    try:
        await send({"type": "text_delta", "turn": turn_id, "text": nudge_text})
        try:
            tts_res = await synthesize(nudge_text)
            if tts_res:
                await send(
                    {
                        "type": "audio",
                        "turn": turn_id,
                        "seq": 0,
                        "text": nudge_text,
                        "mood": "happy",
                        **tts_res.to_event(),
                    }
                )
        except Exception as tts_err:
            log.warning("Distraction TTS synthesis failed: %s", tts_err)

        message_id = await asyncio.to_thread(
            db.add_message, session_id, "assistant", nudge_text, False, ""
        )
    except asyncio.CancelledError:
        interrupted = True
    except Exception as exc:
        log.exception("Distraction nudge failed: %s", exc)
        error = str(exc)
    finally:
        try:
            await send(
                {
                    "type": "turn_end",
                    "turn": turn_id,
                    "interrupted": interrupted,
                    "error": error,
                    "message_id": message_id,
                    "sources": [],
                }
            )
        except Exception:
            pass


# ------------------------------------------------------------------ WebSocket Chat Endpoint
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=1008)
        return
    await ws.accept()
    send_lock = asyncio.Lock()

    async def send(obj: dict) -> None:
        async with send_lock:
            await ws.send_json(obj)

    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
    except Exception:
        await ws.close(code=1008)
        return
    if (
        not isinstance(hello, dict)
        or hello.get("type") != "hello"
        or not token_ok(hello.get("token"))
        or not valid_client_id(hello.get("client_id"))
    ):
        await send({"type": "error", "message": "Unauthorized"})
        await ws.close(code=1008)
        return

    client_id = hello["client_id"]
    session = None
    if hello.get("session_id"):
        session = await asyncio.to_thread(db.get_session, client_id, str(hello["session_id"]))
    if not session:
        session = await asyncio.to_thread(db.create_session, client_id)
    session_id = session["id"]
    await send({"type": "ready", "session_id": session_id})

    turn_task: asyncio.Task | None = None
    turn_is_nudge: bool = False

    async def cancel_turn() -> None:
        nonlocal turn_task, turn_is_nudge
        if turn_task and not turn_task.done():
            turn_task.cancel()
            await asyncio.gather(turn_task, return_exceptions=True)
        turn_task = None
        turn_is_nudge = False

    try:
        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except (ValueError, json.JSONDecodeError):
                await send({"type": "error", "message": "Invalid message"})
                continue
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")

            try:
                if kind == "ping":
                    await send({"type": "pong"})
                elif kind == "interrupt":
                    await cancel_turn()
                elif kind == "user_message":
                    text = msg.get("text")
                    persona = msg.get("persona", "encouraging")
                    collection = msg.get("collection", "calculus_101")
                    if not isinstance(text, str) or not text.strip():
                        continue
                    text = text.strip()
                    if len(text) > settings.max_message_chars:
                        await send(
                            {
                                "type": "error",
                                "message": f"Message too long (max {settings.max_message_chars} characters)",
                            }
                        )
                        continue
                    if not limiter.allow("ws:" + client_id):
                        await send(
                            {"type": "error", "message": "You're sending messages too fast. Please wait a moment."}
                        )
                        continue
                    await cancel_turn()
                    user_msg_id = await asyncio.to_thread(db.add_message, session_id, "user", text)
                    await asyncio.to_thread(db.set_title_if_default, session_id, text[:48])
                    history = await asyncio.to_thread(db.messages, session_id, settings.max_history)
                    turn_id = uuid.uuid4().hex[:8]
                    turn_is_nudge = False
                    await send({"type": "turn_start", "turn": turn_id, "message_id": user_msg_id})
                    turn_task = asyncio.create_task(
                        run_turn(
                            send,
                            session_id,
                            turn_id,
                            history,
                            persona=persona,
                            collection=collection,
                        )
                    )

                elif kind == "distraction_nudge":
                    # Never cancel an active user_message turn or an already-playing distraction nudge
                    if turn_task and not turn_task.done():
                        continue
                    reason = msg.get("reason", "looking away or eyes closed")
                    turn_id = uuid.uuid4().hex[:8]
                    turn_is_nudge = True
                    await send({"type": "turn_start", "turn": turn_id, "is_nudge": True})
                    turn_task = asyncio.create_task(
                        run_distraction_nudge(
                            send,
                            session_id,
                            turn_id,
                            reason=reason,
                        )
                    )
            except Exception as err:
                log.exception("WebSocket message handler error: %s", err)
                await send({"type": "error", "message": f"Server error: {err}"})

    finally:
        await cancel_turn()


# ------------------------------------------------------------------ Background Attention WebSocket
@app.websocket("/ws/attention")
async def attention_ws_endpoint(ws: WebSocket):
    await ws.accept()
    attention_ws_clients.add(ws)
    try:
        # Push current telemetry snapshot immediately on connect
        await ws.send_json(attention_tracker.latest_telemetry)
        while True:
            data = await ws.receive_json()
            if "landmarks" in data:
                res = attention_tracker.process_landmarks(
                    data["landmarks"],
                    session_id=data.get("session_id", "default"),
                    image_width=data.get("width", 640),
                    image_height=data.get("height", 480),
                )
                await broadcast_attention(res)
            elif data.get("no_face"):
                res = attention_tracker.process_no_face(
                    session_id=data.get("session_id", "default")
                )
                await broadcast_attention(res)
            elif "simulate" in data:
                res = attention_tracker.simulate(data["simulate"])
                await broadcast_attention(res)
            elif "ping" in data:
                await ws.send_json({"type": "pong", "status": attention_tracker.latest_telemetry["status"]})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning("Attention WS disconnect: %s", e)
    finally:
        attention_ws_clients.discard(ws)


# ------------------------------------------------------------------ Static frontend (production)
_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
else:
    @app.get("/")
    async def root_status():
        return {"ok": True, "service": "AI Tutor & Avatar Backend", "health": "/api/health"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", settings.backend_port))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port)
