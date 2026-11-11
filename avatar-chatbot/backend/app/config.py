import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


def _list(name: str, default: str) -> list[str]:
    return [v.strip() for v in os.getenv(name, default).split(",") if v.strip()]


DEFAULT_SYSTEM_PROMPT = """You are {name}, an expert AI tutor shown as an interactive 3D avatar.
Your replies are spoken aloud to the student, so:
- Speak naturally in clear, conversational sentences. No markdown code blocks or raw URLs read out.
- Keep answers focused (2-4 sentences) unless explaining a detailed concept requested by the student.
- Begin every reply with exactly one mood tag in square brackets, chosen from:
  [neutral] [happy] [sad] [angry] [fear] [disgust] [love]
  You may place another mood tag at the start of a later sentence if your feeling changes.
- If textbook context is provided below, use it to accurately teach the student, and cite the concepts gently.
- Maintain an encouraging, clear, and pedagogical tone."""

PERSONAS = {
    "socratic": (
        "You are a Socratic AI Tutor. Guide the student by asking thoughtful questions, "
        "providing strategic hints, and encouraging them to derive principles from first principles."
    ),
    "encouraging": (
        "You are a warm, encouraging AI Tutor. Provide positive reinforcement, celebrate effort, "
        "and break down complex ideas into simple, approachable steps."
    ),
    "rigorous": (
        "You are a rigorous, academic professor. Emphasize precision, formal definitions, logical proofs, "
        "and scholarly depth while keeping spoken delivery natural."
    ),
    "buddy": (
        "You are a friendly study buddy. Use casual, energetic language, relatable everyday analogies, "
        "and collaborative learning tricks to keep studying fun and interactive."
    ),
}

DISTRACTION_SYSTEM_PROMPT = (
    "You are an attentive AI tutor. The student appears to have gotten distracted, looked away, or dozed off. "
    "Begin your spoken response directly with: '[happy] Pay attention here!' or '[neutral] Pay attention here!' "
    "Follow with a friendly, brief 1-sentence reminder: 'I noticed you got distracted. Let's refocus on our lesson together!' "
    "Do not give long lectures, keep it brief, spoken, and encouraging."
)


@dataclass
class Settings:
    llm_provider: str = os.getenv("LLM_PROVIDER", "gemini").lower()
    gemini_key: str = os.getenv("GEMINI_API_KEY", "")
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")
    openai_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
    llm_max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "700"))
    max_history: int = int(os.getenv("MAX_HISTORY_MESSAGES", "30"))
    assistant_name: str = os.getenv("ASSISTANT_NAME", "Aria")
    system_prompt: str = os.getenv("SYSTEM_PROMPT", "")

    # TTS Settings
    tts_provider: str = os.getenv("TTS_PROVIDER", "edge").lower()
    edge_voice: str = os.getenv("EDGE_VOICE", "en-US-AriaNeural")
    eleven_key: str = os.getenv("ELEVENLABS_API_KEY", "")
    eleven_voice: str = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
    eleven_model: str = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5")
    openai_tts_model: str = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
    openai_tts_voice: str = os.getenv("OPENAI_TTS_VOICE", "alloy")
    openai_stt_model: str = os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")

    # 3D Avatar Settings
    avatar_url: str = os.getenv(
        "AVATAR_URL",
        "https://cdn.jsdelivr.net/gh/met4citizen/TalkingHead@1.7/avatars/brunette.glb",
    )
    avatar_body: str = os.getenv("AVATAR_BODY", "F")
    lipsync_lang: str = os.getenv("LIPSYNC_LANG", "en")

    # Security & Server
    app_token: str = os.getenv("APP_TOKEN", "")
    allowed_origins: list[str] = field(
        default_factory=lambda: _list(
            "ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000,http://localhost:8001,http://127.0.0.1:8001",
        )
    )
    max_message_chars: int = int(os.getenv("MAX_MESSAGE_CHARS", "2000"))
    rate_limit_per_minute: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "30"))
    db_path: str = os.getenv("DB_PATH", str(BASE_DIR / "chat.db"))

    # RAG & Document Store
    chroma_persist_dir: str = os.getenv("CHROMA_PERSIST_DIR", str(BASE_DIR / "data" / "chroma_db"))
    upload_dir: str = os.getenv("UPLOAD_DIR", str(BASE_DIR / "data" / "uploads"))
    embedding_model_name: str = os.getenv("EMBEDDING_MODEL_NAME", "sentence-transformers/all-MiniLM-L6-v2")
    chunk_size: int = int(os.getenv("CHUNK_SIZE", "800"))
    chunk_overlap: int = int(os.getenv("CHUNK_OVERLAP", "150"))
    retrieval_top_k: int = int(os.getenv("RETRIEVAL_TOP_K", "3"))

    # Attention Tracking Thresholds & Separate Port
    attention_port: int = int(os.getenv("ATTENTION_PORT", "8001"))
    yaw_threshold_deg: float = float(os.getenv("YAW_THRESHOLD_DEG", "25.0"))
    ear_threshold: float = float(os.getenv("EAR_THRESHOLD", "0.21"))
    eyes_closed_duration_sec: float = float(os.getenv("EYES_CLOSED_DURATION_SEC", "3.0"))

    def system_text(self, persona: str = "socratic") -> str:
        base = self.system_prompt or DEFAULT_SYSTEM_PROMPT
        base = base.replace("{name}", self.assistant_name)
        if persona in PERSONAS:
            base += f"\n\nPersona Guidance: {PERSONAS[persona]}"
        return base


settings = Settings()

# Ensure directories exist
for p in [settings.chroma_persist_dir, settings.upload_dir]:
    Path(p).mkdir(parents=True, exist_ok=True)
