# AI Tutor Platform: 3D Avatar + RAG Knowledge Engine + Attention Checker

A unified AI Tutoring and Knowledge Platform combining:
1. **Interactive 3D Avatar (TalkingHead)** with real-time lip sync, visemes, and emotional expressions
2. **Conversational RAG Knowledge Engine** powered by ChromaDB, HuggingFace embeddings (`all-MiniLM-L6-v2`), PyMuPDF, and Gemini LLM
3. **Real-time Attention & Drowsiness Tracker** (MediaPipe Face Mesh, Head Pose estimation, Eye Aspect Ratio) running in the background and accessible via a **dedicated monitor on Port 8001**
4. **Modern 3-Partition UI**:
   - **Partition 1: 3D Avatar Stage**: Interactive avatar with camera view toggles (Head, Upper Body, Full), expression chips, and live speech/listening status.
   - **Partition 2: Interactive Chat & Tutor**: Multi-turn conversation with persona switcher (Socratic Guide, Encouraging Mentor, Rigorous Professor, Study Buddy), textbook citations drawer, distraction nudge alerts, voice input (STT), and barge-in interruption.
   - **Partition 3: Files & Knowledge Base Manager**: Upload textbooks (.pdf, .txt, .md, .docx), inspect extracted chunks and pages, modify titles/collections/notes, delete documents, and test retrieval relevance with the live search playground.

---

## Architecture Overview

```
                      ┌─────────────────────────────────────────────────────────────┐
                      │                     React Frontend (Port 5173)              │
                      │ ┌───────────────┐ ┌──────────────────┐ ┌──────────────────┐ │
                      │ │ Partition 1:  │ │ Partition 2:     │ │ Partition 3:     │ │
                      │ │ 3D Avatar     │ │ Chat & Tutor     │ │ Knowledge Base   │ │
                      │ │ TalkingHead   │ │ Citations + STT  │ │ Upload / Mod / Del│ │
                      │ └───────▲───────┘ └────────▲─────────┘ └────────▲─────────┘ │
                      └─────────┼──────────────────┼────────────────────┼───────────┘
                                │                  │                    │
          WebSocket & Audio     │                  │ REST / WebSocket   │ REST (Upload, Query)
                                ▼                  ▼                    ▼
                      ┌─────────────────────────────────────────────────────────────┐
                      │             AI Tutor Combined Backend (Port 8000)           │
                      │  - FastAPI REST & WebSocket APIs                            │
                      │  - Gemini LLM Streaming + Dynamic Persona Prompts           │
                      │  - Edge-TTS Voice Synthesis with per-word lip-sync timings  │
                      │  - RAG Engine: PyMuPDF + Recursive Splitter + ChromaDB      │
                      │  - SQLite Database (Sessions, Messages, Document Metadata)  │
                      └────────────────────────────▲────────────────────────────────┘
                                                   │
                                                   │ Telemetry Sync
                                                   ▼
                      ┌─────────────────────────────────────────────────────────────┐
                      │         Visual Attention Checker Server (Port 8001)         │
                      │  - Dedicated FastAPI server on http://localhost:8001        │
                      │  - Live Webcam Feed with MediaPipe Face Mesh Wireframe      │
                      │  - Real-time Gauges: Head Yaw (-60° to +60°), Pitch, Roll   │
                      │  - Eye Aspect Ratio (EAR) Gauge & Eyes Closed Duration Clock│
                      │  - Interactive Simulation Deck (Test Yaw, Drowsiness, Reset)│
                      │  - Distraction Audit Log & Re-engagement Trigger Broadcaster│
                      └─────────────────────────────────────────────────────────────┘
```

---

## Quick Start (One-Click)

Simply double-click or run:
```bash
run_local.bat
```
This automatically starts:
1. **Attention Checker Monitor** on `http://localhost:8001`
2. **AI Tutor Combined Backend** on `http://localhost:8000`
3. **3-Partition React Frontend** on `http://localhost:5173`
4. Automatically launches your web browser to `http://localhost:5173`!

---

## Manual Launch (Terminal by Terminal)

### 1. Start the Attention Checker Monitor (Port 8001)
```bash
cd avatar-chatbot/backend
python attention_server.py
```
Open [http://localhost:8001](http://localhost:8001) to view the live Visual Attention HUD.

### 2. Start the AI Tutor Combined Backend (Port 8000)
```bash
cd avatar-chatbot/backend
python -m uvicorn app.main:app --reload --port 8000
```
Interactive API documentation: [http://localhost:8000/api/docs](http://localhost:8000/api/docs)

### 3. Start the Frontend (Port 5173)
```bash
cd avatar-chatbot/frontend
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) to interact with the full 3-Partition AI Tutor platform.

---

## Features Breakdown

### 1. Partition 1: 3D Avatar Stage
- Powered by `TalkingHead` with WebGL.
- Synchronized lip movement driven by per-word viseme timings generated by Edge-TTS.
- Controls bar:
  - Camera views: **Head**, **Upper Body**, **Full Body**.
  - Expressions/Moods: Happy 😊, Love ❤️, Sad 😔, Surprised 😮, Neutral 😐.
- Real-time status badge showing current avatar phase: `Idle`, `Listening`, `Thinking`, `Speaking`.
- Background Attention status pill indicating if the learner is currently attentive or distracted, with a one-click shortcut to the Port 8001 Monitor.

### 2. Partition 2: Interactive Chat & Tutor
- **Tutor Personas**:
  - `🎓 Socratic Guide`: Asks guiding questions and gives hints.
  - `🌟 Encouraging Mentor`: Warm, supportive, and breaks down complex concepts.
  - `📚 Rigorous Professor`: Academic precision, proofs, and textbook definitions.
  - `🤝 Study Buddy`: Casual analogies and interactive peer explanations.
- **Source Citations Drawer**:
  - Whenever textbook knowledge is retrieved, a clickable citation card appears under the tutor's response showing the source file, page number, and text excerpt.
- **Distraction Re-engagement Banner**:
  - If the learner is flagged as distracted or drowsy by the attention tracker, an alert banner drops down into the chat, and the avatar speaks a gentle pedagogical check-in!
- **Voice & Composition**:
  - Text input with multiline expansion.
  - Speech-to-Text (STT) microphone button with active wave animation.
  - Interrupt / Barge-in toggle.
  - Quick prompt suggestion chips.

### 3. Partition 3: Files & Knowledge Base Manager
- **File Upload**: Drag-and-drop or file picker supporting `.pdf`, `.txt`, `.md`, `.docx`, `.json`.
- **Collections**: Organize materials into collections (e.g. `calculus_101`, `physics`).
- **Document Cards**:
  - Displays original filename, title, file size, pages extracted, chunk count, and upload timestamp.
  - **Active in Chat Toggle**: Selectively include or exclude documents from RAG retrieval context.
  - **Inspect Chunks**: Modal viewing extracted text chunks and page numbers.
  - **Modify**: Rename title, change collection, or add custom tutor instructions/notes.
  - **Delete**: Removes document from SQLite, vector index, and storage disk with confirmation.
- **RAG Retrieval Playground**:
  - Real-time test input to verify semantic similarity scores and preview chunks matched for any query.

### 4. Attention Tracking & Standalone Port 8001
- **Head Pose Estimation**: Uses 6 facial landmarks with OpenCV `cv2.solvePnP` and `RQDecomp3x3` to compute Yaw, Pitch, and Roll angles. Flagged as distracted if `|Yaw| > 30°`.
- **Eye Aspect Ratio (EAR)**: Computes Euclidean eye landmark proportions. Flagged as drowsy if `EAR < 0.21` continuously for `> 5.0s`.
- **Dedicated Port 8001 HUD**:
  - Live webcam feed with MediaPipe Face Mesh wireframe overlay.
  - Interactive gauge needles for Head Yaw and EAR.
  - Closed-eyes timer with danger color transition.
  - Simulation Deck: test buttons to trigger distraction or drowsiness states on demand.
  - Real-time Distraction Audit Log table.
