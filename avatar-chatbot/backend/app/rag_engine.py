"""
rag_engine.py: RAG Knowledge Engine for AI Tutoring & Document Management.

Handles:
- PDF text extraction via PyMuPDF (fitz)
- Plain text & Markdown extraction
- Semantic text chunking (LangChain RecursiveCharacterTextSplitter)
- Local vector database persistence (ChromaDB)
- Embeddings via HuggingFace (all-MiniLM-L6-v2)
- Citation tracking (source file, page, excerpts)
- Document deletion from vector index
- Retrieval inspection & test querying
"""

import os
import logging
import threading
from pathlib import Path
from typing import List, Dict, Any, Optional, Union

try:
    import fitz  # PyMuPDF
except ImportError:
    try:
        import pymupdf as fitz
    except ImportError:
        fitz = None

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from .config import settings

logger = logging.getLogger("avatar-rag")
logger.setLevel(logging.INFO)


class OnnxMiniLMEmbeddings:
    """Lightweight 384-dim all-MiniLM-L6-v2 embeddings via Chroma's ONNX runtime (no PyTorch required)."""

    def __init__(self):
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

        self._ef = DefaultEmbeddingFunction()

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        res = self._ef(texts)
        return [[float(x) for x in vec] for vec in res]

    def embed_query(self, text: str) -> List[float]:
        res = self._ef([text])
        return [float(x) for x in res[0]]


class RAGEngine:
    def __init__(
        self,
        persist_dir: str = settings.chroma_persist_dir,
        embedding_model_name: str = settings.embedding_model_name,
        chunk_size: int = settings.chunk_size,
        chunk_overlap: int = settings.chunk_overlap,
    ):
        self.persist_dir = persist_dir
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.embedding_model_name = embedding_model_name
        self._embeddings = None
        self._vector_stores: Dict[str, Any] = {}
        self._lock = threading.RLock()

    @property
    def embeddings(self):
        with self._lock:
            if self._embeddings is None:
                logger.info(f"Loading Embedding Model: {self.embedding_model_name}")
                use_onnx = bool(os.environ.get("RENDER") or os.environ.get("USE_ONNX_EMBEDDINGS"))
                if not use_onnx:
                    try:
                        try:
                            from langchain_huggingface import HuggingFaceEmbeddings
                        except ImportError:
                            from langchain_community.embeddings import HuggingFaceEmbeddings
                        self._embeddings = HuggingFaceEmbeddings(
                            model_name=self.embedding_model_name,
                            model_kwargs={"device": "cpu"},
                            encode_kwargs={"normalize_embeddings": True},
                        )
                    except Exception as e:
                        logger.info(f"Falling back to lightweight ONNX all-MiniLM-L6-v2 embeddings: {e}")
                        self._embeddings = OnnxMiniLMEmbeddings()
                else:
                    self._embeddings = OnnxMiniLMEmbeddings()
            return self._embeddings

    def get_vector_store(self, collection_name: str = "calculus_101") -> Any:
        try:
            from langchain_chroma import Chroma
        except ImportError:
            from langchain_community.vectorstores import Chroma
        with self._lock:
            if collection_name not in self._vector_stores:
                self._vector_stores[collection_name] = Chroma(
                    collection_name=collection_name,
                    embedding_function=self.embeddings,
                    persist_directory=self.persist_dir,
                )
            return self._vector_stores[collection_name]

    def extract_text(self, file_path_or_bytes: Union[str, Path, bytes], filename: str) -> List[Document]:
        """Extracts text documents (with page / section metadata) from PDF or plain text."""
        ext = Path(filename).suffix.lower()
        documents: List[Document] = []

        if ext == ".pdf":
            if fitz is None:
                raise RuntimeError("PyMuPDF (fitz) is not installed for PDF parsing.")
            if isinstance(file_path_or_bytes, (str, Path)):
                doc = fitz.open(str(file_path_or_bytes))
            else:
                doc = fitz.open(stream=file_path_or_bytes, filetype="pdf")

            total_pages = len(doc)
            for page_idx in range(total_pages):
                page = doc[page_idx]
                text = page.get_text("text").strip()
                if text:
                    documents.append(
                        Document(
                            page_content=text,
                            metadata={
                                "source_file": filename,
                                "page": page_idx + 1,
                                "total_pages": total_pages,
                            },
                        )
                    )
            doc.close()
        else:
            # Plain text, Markdown, etc.
            if isinstance(file_path_or_bytes, (str, Path)):
                with open(str(file_path_or_bytes), "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            else:
                content = file_path_or_bytes.decode("utf-8", errors="ignore")

            if content.strip():
                documents.append(
                    Document(
                        page_content=content.strip(),
                        metadata={"source_file": filename, "page": 1, "total_pages": 1},
                    )
                )

        return documents

    def ingest_document(
        self,
        doc_id: str,
        file_path_or_bytes: Union[str, Path, bytes],
        filename: str,
        collection_name: str = "calculus_101",
    ) -> Dict[str, Any]:
        """Ingests a document: extracts, chunks, tags with doc_id, and indexes in ChromaDB."""
        raw_docs = self.extract_text(file_path_or_bytes, filename)
        if not raw_docs:
            raise ValueError(f"No text could be extracted from '{filename}'.")

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=self.chunk_size,
            chunk_overlap=self.chunk_overlap,
            separators=["\n\n", "\n", ". ", " ", ""],
        )

        split_docs = splitter.split_documents(raw_docs)
        for i, chunk in enumerate(split_docs):
            chunk.metadata["doc_id"] = doc_id
            chunk.metadata["chunk_index"] = i
            chunk.metadata["collection"] = collection_name

        with self._lock:
            vector_store = self.get_vector_store(collection_name=collection_name)
            # Assign explicit IDs so they can be tracked/deleted
            chunk_ids = [f"{doc_id}_chunk_{i}" for i in range(len(split_docs))]
            vector_store.add_documents(split_docs, ids=chunk_ids)

        logger.info(
            f"Successfully indexed document '{filename}' (ID: {doc_id}): {len(raw_docs)} pages, {len(split_docs)} chunks into '{collection_name}'."
        )

        return {
            "status": "success",
            "doc_id": doc_id,
            "filename": filename,
            "collection": collection_name,
            "pages_extracted": len(raw_docs),
            "chunks_created": len(split_docs),
        }

    def delete_document(self, doc_id: str, collection_name: str = "calculus_101") -> bool:
        """Deletes all indexed chunks matching doc_id from ChromaDB."""
        try:
            with self._lock:
                vector_store = self.get_vector_store(collection_name=collection_name)
                vector_store.delete(where={"doc_id": doc_id})
            logger.info(f"Deleted vector chunks for doc_id '{doc_id}' from '{collection_name}'.")
            return True
        except Exception as e:
            logger.warning(f"Error removing doc_id '{doc_id}' from vector store: {e}")
            return False

    def retrieve_context(
        self,
        query: str,
        collection_name: str = "calculus_101",
        top_k: int = settings.retrieval_top_k,
        active_doc_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Retrieves top-k context chunks and citation sources for a user query."""
        try:
            with self._lock:
                vector_store = self.get_vector_store(collection_name=collection_name)
                # Fetch with relevance scores
                results = vector_store.similarity_search_with_relevance_scores(query, k=top_k * 2)

            sources = []
            context_blocks = []

            for doc, score in results:
                doc_id = doc.metadata.get("doc_id", "")
                if active_doc_ids is not None and doc_id not in active_doc_ids:
                    continue

                source_name = doc.metadata.get("source_file", "Document")
                page = doc.metadata.get("page", 1)
                text = doc.page_content.strip()

                context_blocks.append(f"[Source: {source_name}, Page {page}]\n{text}")
                sources.append(
                    {
                        "source": source_name,
                        "doc_id": doc_id,
                        "page": page,
                        "score": round(float(score), 3) if score is not None else 0.0,
                        "snippet": text[:180] + ("..." if len(text) > 180 else ""),
                    }
                )
                if len(sources) >= top_k:
                    break

            return {
                "context": "\n\n".join(context_blocks),
                "sources": sources,
            }
        except Exception as e:
            logger.warning(f"Retrieval error: {e}")
            return {"context": "", "sources": []}

    def get_document_chunks(
        self,
        doc_id: str,
        collection_name: str = "calculus_101",
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        """Returns the chunked text and metadata for a specific document."""
        try:
            with self._lock:
                vector_store = self.get_vector_store(collection_name=collection_name)
                raw = vector_store.get(where={"doc_id": doc_id}, limit=limit)
            chunks = []
            if raw and "documents" in raw and raw["documents"]:
                for i in range(len(raw["documents"])):
                    meta = raw["metadatas"][i] if i < len(raw["metadatas"]) else {}
                    chunks.append(
                        {
                            "chunk_id": raw["ids"][i],
                            "page": meta.get("page", 1),
                            "chunk_index": meta.get("chunk_index", i),
                            "content": raw["documents"][i],
                        }
                    )
            return sorted(chunks, key=lambda c: c.get("chunk_index", 0))
        except Exception as e:
            logger.warning(f"Error fetching chunks for {doc_id}: {e}")
            return []


rag_engine = RAGEngine()
