"""SQLite chat history & document store. Sync API; call through asyncio.to_thread from async code."""
import sqlite3
import threading
import time
import uuid
from typing import Optional, List, Dict, Any


class Database:
    def __init__(self, path: str):
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions(client_id, updated_at);

                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    interrupted INTEGER NOT NULL DEFAULT 0,
                    sources_json TEXT DEFAULT '',
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    collection TEXT NOT NULL DEFAULT 'calculus_101',
                    title TEXT NOT NULL,
                    file_size INTEGER NOT NULL DEFAULT 0,
                    pages_count INTEGER NOT NULL DEFAULT 1,
                    chunks_count INTEGER NOT NULL DEFAULT 0,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    custom_notes TEXT DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_documents_col ON documents(collection);
                """
            )
            # Migrate pre-existing tables if columns were added in newer schema
            msg_cols = {
                row["name"]
                for row in self._conn.execute("PRAGMA table_info(messages)").fetchall()
            }
            if "sources_json" not in msg_cols:
                self._conn.execute(
                    "ALTER TABLE messages ADD COLUMN sources_json TEXT DEFAULT ''"
                )
            if "interrupted" not in msg_cols:
                self._conn.execute(
                    "ALTER TABLE messages ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0"
                )
            self._conn.commit()

    # ---------------------------------------------------------------- Sessions
    def create_session(self, client_id: str, title: str = "New chat") -> dict:
        sid = uuid.uuid4().hex
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions(id, client_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
                (sid, client_id, title, now, now),
            )
            self._conn.commit()
        return {"id": sid, "title": title, "updated_at": now}

    def list_sessions(self, client_id: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, title, updated_at FROM sessions WHERE client_id=? ORDER BY updated_at DESC LIMIT 100",
                (client_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_session(self, client_id: str, session_id: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, title, updated_at FROM sessions WHERE id=? AND client_id=?",
                (session_id, client_id),
            ).fetchone()
        return dict(row) if row else None

    def set_title_if_default(self, session_id: str, title: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE sessions SET title=? WHERE id=? AND title='New chat'",
                (title.strip()[:60], session_id),
            )
            self._conn.commit()

    def delete_session(self, client_id: str, session_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM sessions WHERE id=? AND client_id=?", (session_id, client_id)
            )
            self._conn.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
            self._conn.commit()
            return cur.rowcount > 0

    # ---------------------------------------------------------------- Messages
    def messages(self, session_id: str, limit: int | None = None) -> list[dict]:
        with self._lock:
            if limit:
                rows = self._conn.execute(
                    "SELECT * FROM (SELECT id, role, content, interrupted, sources_json, created_at FROM messages "
                    "WHERE session_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
                    (session_id, limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, role, content, interrupted, sources_json, created_at FROM messages "
                    "WHERE session_id=? ORDER BY id ASC",
                    (session_id,),
                ).fetchall()
        return [dict(r) for r in rows]

    def add_message(
        self,
        session_id: str,
        role: str,
        content: str,
        interrupted: bool = False,
        sources_json: str = "",
    ) -> int:
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages(session_id, role, content, interrupted, sources_json, created_at) VALUES (?,?,?,?,?,?)",
                (session_id, role, content, int(interrupted), sources_json, now),
            )
            self._conn.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, session_id))
            self._conn.commit()
            return cur.lastrowid

    # ---------------------------------------------------------------- Documents
    def create_document(
        self,
        doc_id: str,
        filename: str,
        original_name: str,
        collection: str,
        title: str,
        file_size: int,
        pages_count: int,
        chunks_count: int,
        custom_notes: str = "",
    ) -> dict:
        now = time.time()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO documents (
                    id, filename, original_name, collection, title,
                    file_size, pages_count, chunks_count, is_active,
                    custom_notes, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    doc_id,
                    filename,
                    original_name,
                    collection,
                    title,
                    file_size,
                    pages_count,
                    chunks_count,
                    custom_notes,
                    now,
                    now,
                ),
            )
            self._conn.commit()
        return self.get_document(doc_id)

    def list_documents(self, collection: Optional[str] = None) -> List[dict]:
        with self._lock:
            if collection and collection.lower() != "all":
                rows = self._conn.execute(
                    "SELECT * FROM documents WHERE LOWER(collection)=LOWER(?) ORDER BY created_at DESC",
                    (collection.strip(),),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM documents ORDER BY created_at DESC"
                ).fetchall()
        return [dict(r) for r in rows]

    def get_document(self, doc_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
        return dict(row) if row else None

    def update_document(
        self,
        doc_id: str,
        title: Optional[str] = None,
        collection: Optional[str] = None,
        is_active: Optional[bool] = None,
        custom_notes: Optional[str] = None,
    ) -> Optional[dict]:
        doc = self.get_document(doc_id)
        if not doc:
            return None
        now = time.time()
        new_title = title if title is not None else doc["title"]
        new_coll = collection if collection is not None else doc["collection"]
        new_active = int(is_active) if is_active is not None else doc["is_active"]
        new_notes = custom_notes if custom_notes is not None else doc["custom_notes"]
        with self._lock:
            self._conn.execute(
                """
                UPDATE documents
                SET title=?, collection=?, is_active=?, custom_notes=?, updated_at=?
                WHERE id=?
                """,
                (new_title, new_coll, new_active, new_notes, now, doc_id),
            )
            self._conn.commit()
        return self.get_document(doc_id)

    def delete_document(self, doc_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM documents WHERE id=?", (doc_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def list_collections(self) -> List[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT collection FROM documents ORDER BY collection ASC"
            ).fetchall()
        return [r["collection"] for r in rows if r["collection"]]
