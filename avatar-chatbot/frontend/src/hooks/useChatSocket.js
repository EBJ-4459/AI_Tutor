import { useCallback, useEffect, useRef, useState } from "react";
import { getClientId, getToken, wsUrl } from "../lib/api";

/** WebSocket connection to the FastAPI backend with automatic reconnect. */
export function useChatSocket({ sessionId, enabled, onEvent }) {
  const [status, setStatus] = useState("connecting"); // connecting | open | closed
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!sessionId || !enabled) return undefined;
    let closed = false;
    let retry = 0;
    let retryTimer = null;
    let pingTimer = null;

    const connect = () => {
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            client_id: getClientId(),
            token: getToken(),
            session_id: sessionId,
          })
        );
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
        }, 25000);
      };

      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          retry = 0;
          setStatus("open");
        }
        onEventRef.current?.(msg);
      };

      ws.onerror = () => ws.close();

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (closed) return;
        setStatus("closed");
        retry += 1;
        retryTimer = setTimeout(connect, Math.min(500 * 2 ** retry, 10000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [sessionId, enabled]);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  return { status, send };
}
