import React from "react";

function when(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export default function Sidebar({ sessions, activeId, open, onSelect, onNew, onDelete, onClose, onSignOut, authRequired }) {
  return (
    <>
      {open && <div className="scrim" onClick={onClose} />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-head">
          <h2>Chats</h2>
          <button className="btn primary small" onClick={onNew}>
            + New
          </button>
        </div>
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={s.id === activeId ? "active" : ""}>
              <button className="session-main" onClick={() => onSelect(s.id)}>
                <span className="session-title">{s.title}</span>
                <span className="session-time">{when(s.updated_at)}</span>
              </button>
              <button
                className="icon-btn danger"
                aria-label={`Delete chat ${s.title}`}
                onClick={() => window.confirm("Delete this chat?") && onDelete(s.id)}
              >
                ✕
              </button>
            </li>
          ))}
          {sessions.length === 0 && <li className="empty">No chats yet</li>}
        </ul>
        {authRequired && (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "auto", paddingTop: "8px", borderTop: "1px solid var(--line)" }}>
            <button className="btn ghost small signout" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
