import React, { useState, useEffect, useRef } from "react";
import { api } from "../lib/api.js";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function DocumentManager({
  activeCollection,
  collections: propCollections,
  onCollectionChange,
  onCollectionsRefresh,
  onNotification,
}) {
  const [documents, setDocuments] = useState([]);
  const [localCollections, setLocalCollections] = useState(["calculus_101"]);
  const collections = propCollections && propCollections.length ? propCollections : localCollections;
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  
  // Modals state
  const [inspectDoc, setInspectDoc] = useState(null); // doc to view chunks
  const [inspectChunks, setInspectChunks] = useState([]);
  const [inspectLoading, setInspectLoading] = useState(false);
  
  const [editDoc, setEditDoc] = useState(null); // doc being modified
  const [editTitle, setEditTitle] = useState("");
  const [editCollection, setEditCollection] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Upload inputs
  const [selectedFile, setSelectedFile] = useState(null);
  const [targetCollection, setTargetCollection] = useState(
    activeCollection && activeCollection !== "all" ? activeCollection : "calculus_101"
  );
  const [isNewSubject, setIsNewSubject] = useState(false);
  const [newSubjectName, setNewSubjectName] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [customNotes, setCustomNotes] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (activeCollection && activeCollection !== "all" && !isNewSubject) {
      setTargetCollection(activeCollection);
    }
  }, [activeCollection, isNewSubject]);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const docs = await api.listDocuments(activeCollection);
      setDocuments(docs);
      const colls = await api.listCollections();
      if (colls && colls.length) setLocalCollections(colls);
      onCollectionsRefresh?.();
    } catch (err) {
      onNotification?.(`Could not load files: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDocuments();
  }, [activeCollection]);

  // Upload Document
  const handleUpload = async (e) => {
    e.preventDefault();
    if (!selectedFile) {
      onNotification?.("Please select a document file (.pdf, .txt, .md)");
      return;
    }
    const chosenSubject = (isNewSubject ? newSubjectName : targetCollection).trim() || "calculus_101";
    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("collection", chosenSubject);
    if (customTitle.trim()) formData.append("title", customTitle.trim());
    if (customNotes.trim()) formData.append("custom_notes", customNotes.trim());

    try {
      setUploading(true);
      setUploadProgress("Uploading...");
      const created = await api.uploadDocument(formData);
      onNotification?.(`Uploaded "${created.title}" successfully!`);
      setSelectedFile(null);
      setCustomTitle("");
      setCustomNotes("");
      setIsNewSubject(false);
      setNewSubjectName("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (created?.collection) {
        setTargetCollection(created.collection);
        onCollectionChange?.(created.collection);
      }
      fetchDocuments();
    } catch (err) {
      onNotification?.(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadProgress("");
    }
  };

  // Toggle Active status in chat
  const toggleActive = async (doc) => {
    try {
      const updated = await api.updateDocument(doc.id, { is_active: !doc.is_active });
      setDocuments((docs) => docs.map((d) => (d.id === doc.id ? updated : d)));
    } catch (err) {
      onNotification?.(`Update failed: ${err.message}`);
    }
  };

  // Delete Document
  const handleDelete = async (doc) => {
    if (!window.confirm(`Delete "${doc.title}" from knowledge base and disk?`)) return;
    try {
      await api.deleteDocument(doc.id);
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
      onCollectionsRefresh?.();
      onNotification?.(`Deleted "${doc.title}"`);
    } catch (err) {
      onNotification?.(`Delete failed: ${err.message}`);
    }
  };

  // Inspect Chunks Modal
  const openInspectModal = async (doc) => {
    setInspectDoc(doc);
    setInspectLoading(true);
    try {
      const res = await api.getDocument(doc.id);
      setInspectChunks(res.chunks || []);
    } catch (err) {
      onNotification?.(`Could not load chunks: ${err.message}`);
    } finally {
      setInspectLoading(false);
    }
  };

  // Open Edit Modal
  const openEditModal = (doc) => {
    setEditDoc(doc);
    setEditTitle(doc.title);
    setEditCollection(doc.collection);
    setEditNotes(doc.custom_notes || "");
  };

  // Save Edit
  const handleSaveEdit = async (e) => {
    e.preventDefault();
    if (!editDoc) return;
    try {
      setEditSaving(true);
      const updated = await api.updateDocument(editDoc.id, {
        title: editTitle.trim(),
        collection: editCollection.trim(),
        custom_notes: editNotes.trim(),
      });
      setDocuments((docs) => docs.map((d) => (d.id === editDoc.id ? updated : d)));
      onNotification?.(`Updated "${updated.title}"`);
      setEditDoc(null);
    } catch (err) {
      onNotification?.(`Save failed: ${err.message}`);
    } finally {
      setEditSaving(false);
    }
  };

  const totalChunks = documents.reduce((acc, d) => acc + (d.chunks_count || 0), 0);

  return (
    <div className="doc-manager">
      {/* Partition Header */}
      <div className="doc-header">
        <div>
          <div className="doc-title-row">
            <h2>📚 Knowledge Base</h2>
            <span className="badge-pill">{documents.length} {documents.length === 1 ? "file" : "files"}</span>
          </div>
          <p className="doc-subtitle">Upload textbooks and notes for avatar RAG retrieval</p>
        </div>

        {/* Subject Filter */}
        <div className="collection-bar">
          <label className="coll-label">Subject:</label>
          <select
            value={activeCollection || "all"}
            onChange={(e) => onCollectionChange(e.target.value)}
            className="coll-select"
          >
            <option value="all">All Subjects</option>
            {collections.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="doc-scroll-area">
        {/* Upload Form Card */}
        <div className="doc-card upload-card">
          <h3 className="card-title">📤 Upload Document</h3>
          <form onSubmit={handleUpload} className="upload-form">
            <div
              className={`drop-area ${selectedFile ? "has-file" : ""}`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.md,.docx,.json"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="hidden-file-input"
              />
              <span className="drop-icon">{selectedFile ? "📄" : "📥"}</span>
              <div className="drop-text">
                <strong>{selectedFile ? selectedFile.name : "Choose or drag a textbook/file"}</strong>
                <span>Supports PDF, TXT, Markdown, Word</span>
              </div>
            </div>

            <div className="form-grid">
              <div>
                <label className="input-label">Subject</label>
                <select
                  value={isNewSubject ? "__new__" : (collections.includes(targetCollection) ? targetCollection : (collections[0] || "calculus_101"))}
                  onChange={(e) => {
                    if (e.target.value === "__new__") {
                      setIsNewSubject(true);
                      setNewSubjectName("");
                    } else {
                      setIsNewSubject(false);
                      setTargetCollection(e.target.value);
                    }
                  }}
                  className="text-input"
                >
                  {collections.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  <option value="__new__">+ New Subject...</option>
                </select>
                {isNewSubject && (
                  <input
                    type="text"
                    value={newSubjectName}
                    onChange={(e) => setNewSubjectName(e.target.value)}
                    placeholder="Enter new subject name..."
                    className="text-input"
                    style={{ marginTop: "6px" }}
                    autoFocus
                    required
                  />
                )}
              </div>
              <div>
                <label className="input-label">Custom Title (Optional)</label>
                <input
                  type="text"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="e.g. Calculus Derivatives Notes"
                  className="text-input"
                />
              </div>
            </div>

            <div>
              <label className="input-label">Notes / Instructions for AI Tutor (Optional)</label>
              <textarea
                value={customNotes}
                onChange={(e) => setCustomNotes(e.target.value)}
                placeholder="Key concepts or focus areas..."
                rows={1}
                className="text-input notes-input"
              />
            </div>

            <button
              type="submit"
              disabled={uploading || !selectedFile}
              className="btn primary full-width"
            >
              {uploading ? (uploadProgress || "Uploading...") : "Upload"}
            </button>
          </form>
        </div>

        {/* Document Cards List */}
        <div className="doc-list-section">
          <div className="section-head">
            <h3>Indexed Documents</h3>
            <button className="btn ghost small" onClick={fetchDocuments} title="Refresh list">↻ Refresh</button>
          </div>

          {loading && <p className="hint">Loading documents…</p>}
          {!loading && documents.length === 0 && (
            <div className="empty-docs">
              <span className="empty-icon">📂</span>
              <p>No documents found in this subject.</p>
              <span className="empty-sub">Upload a PDF or text file above to get started!</span>
            </div>
          )}

          <div className="cards-grid">
            {documents.map((doc) => (
              <div key={doc.id} className={`doc-item-card ${doc.is_active ? "active" : "inactive"}`}>
                <div className="doc-item-header">
                  <div className="doc-item-icon">
                    {doc.original_name.endsWith(".pdf") ? "📕" : "📝"}
                  </div>
                  <div className="doc-item-meta">
                    <h4 className="doc-item-title" title={doc.title}>{doc.title}</h4>
                    <span className="doc-item-filename">{doc.original_name}</span>
                  </div>
                  <button
                    className={`toggle-pill ${doc.is_active ? "on" : "off"}`}
                    onClick={() => toggleActive(doc)}
                    title={doc.is_active ? "Active in Chat RAG" : "Excluded from Chat"}
                  >
                    {doc.is_active ? "Active" : "Muted"}
                  </button>
                </div>

                <div className="doc-item-stats">
                  <span className="stat-tag collection-tag">🏷️ {doc.collection}</span>
                  <span className="stat-tag">📄 {doc.pages_count}p</span>
                  <span className="stat-tag">💾 {formatBytes(doc.file_size)}</span>
                  <span className="stat-tag date-tag">🕒 {formatDate(doc.created_at)}</span>
                </div>

                {doc.custom_notes && (
                  <p className="doc-item-notes">"{doc.custom_notes}"</p>
                )}

                {/* Card Actions: Modify, Delete */}
                <div className="doc-item-actions">
                  <button
                    className="action-btn edit"
                    onClick={() => openEditModal(doc)}
                    title="Edit title, subject, or notes"
                  >
                    ✏️ Modify
                  </button>
                  <button
                    className="action-btn delete"
                    onClick={() => handleDelete(doc)}
                    title="Delete document"
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modify / Edit Document Modal */}
      {editDoc && (
        <div className="modal-backdrop" onClick={() => setEditDoc(null)}>
          <div className="modal-content small-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>✏️ Modify Document</h3>
              <button className="icon-btn" onClick={() => setEditDoc(null)}>✕</button>
            </div>
            <form onSubmit={handleSaveEdit} className="modal-form">
              <div>
                <label className="input-label">Document Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="text-input"
                  required
                />
              </div>
              <div>
                <label className="input-label">Subject Name</label>
                <input
                  type="text"
                  value={editCollection}
                  onChange={(e) => setEditCollection(e.target.value)}
                  className="text-input"
                  required
                />
              </div>
              <div>
                <label className="input-label">Custom Notes</label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                  className="text-input"
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={() => setEditDoc(null)}>Cancel</button>
                <button type="submit" disabled={editSaving} className="btn primary">
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
