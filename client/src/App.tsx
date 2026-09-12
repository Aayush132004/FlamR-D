/**
 * App.tsx — Main React Application
 *
 * Wires together: connection ↔ protocol ↔ renderer ↔ React UI.
 *
 * Architecture:
 *   - One `useEffect` mounts the WebSocket room + canvas renderer. Both are
 *     torn down and rebuilt if the component unmounts (hot-reload / StrictMode).
 *   - Cursor sends are throttled to CURSOR_THROTTLE_MS (33ms = ~30Hz) using a
 *     last-sent timestamp ref. No `setInterval` needed — event-driven.
 *   - Peer state lives in a Map ref (peersRef) for real-time access inside event
 *     handlers (avoids stale closure), and a mirrored React state array (peerList)
 *     for re-rendering the sidebar.
 *   - Local reactions are rendered immediately (optimistic) without waiting for
 *     the server round-trip, giving instant feedback.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createRoom, getOrCreateClientId, getOrCreateDisplayName } from './connection';
import type { Room, ConnectionState } from './connection';
import { CanvasRenderer } from './render';
import type { InboundMessage } from './protocol';

// ─── Constants / Config ─────────────────────────────────────────────────────────

const EMOJIS = ['🎉', '❤️', '🔥', '⭐', '👏', '🎊', '✨', '💫'];

/** Cursor send interval: 33ms ≈ 30Hz (10× less than raw mousemove at 300Hz). */
const CURSOR_THROTTLE_MS = 33;

const WS_URL = ((import.meta as unknown) as Record<string, Record<string, string>>).env?.['VITE_WS_URL']
  ?? `ws://${window.location.hostname}:8080`;

const CLIENT_ID = getOrCreateClientId();
const DISPLAY_NAME = getOrCreateDisplayName();
const ROOM_ID = new URLSearchParams(window.location.search).get('room') ?? 'watch-party-42';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface PeerInfo {
  clientId: string;
  color: string;
  displayName: string;
}

const STATUS_STYLES: Record<ConnectionState, { dot: string; bg: string; border: string; label: string }> = {
  connected:    { dot: '#10b981', bg: 'rgba(16,185,129,0.12)',  border: 'rgba(16,185,129,0.28)',  label: 'Connected'      },
  connecting:   { dot: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)',  label: 'Connecting…'    },
  reconnecting: { dot: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)',  label: 'Reconnecting…'  },
  disconnected: { dot: '#ef4444', bg: 'rgba(239,68,68,0.12)',   border: 'rgba(239,68,68,0.28)',   label: 'Disconnected'   },
};

// ─── Component ──────────────────────────────────────────────────────────────────

export default function App() {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const roomRef      = useRef<Room | null>(null);
  const rendererRef  = useRef<CanvasRenderer | null>(null);
  const lastSentRef  = useRef(0);          // Timestamp of last cursor send
  const seqRef       = useRef(0);          // Monotonic cursor sequence counter
  const emojiRef     = useRef(EMOJIS[0]);  // Selected emoji (avoids closure staleness)
  const peersRef     = useRef<Map<string, PeerInfo>>(new Map());

  const [peerList,   setPeerList]   = useState<PeerInfo[]>([]);
  const [connState,  setConnState]  = useState<ConnectionState>('connecting');
  const [rtt,        setRtt]        = useState<number | null>(null);
  const [emoji,      setEmoji]      = useState(EMOJIS[0]);

  // Keep emoji ref in sync with state (used inside canvas event handler).
  useEffect(() => { emojiRef.current = emoji; }, [emoji]);

  // Helper: update both the ref map and trigger a React re-render.
  const mutatePeers = useCallback((fn: (m: Map<string, PeerInfo>) => void) => {
    fn(peersRef.current);
    setPeerList(Array.from(peersRef.current.values()));
  }, []);

  // ── Mount / unmount ──────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current!;

    // 1. Start canvas renderer.
    const renderer = new CanvasRenderer(canvas);
    rendererRef.current = renderer;
    renderer.start();

    // 2. Open WebSocket room.
    const room = createRoom({ serverUrl: WS_URL, roomId: ROOM_ID, clientId: CLIENT_ID, displayName: DISPLAY_NAME });
    roomRef.current = room;

    // 3. Handle inbound messages.
    const handleMessage = (msg: InboundMessage): void => {
      switch (msg.type) {
        case 'presence': {
          // Full snapshot — replace local peer map.
          mutatePeers(map => {
            map.clear();
            for (const c of msg.clients) {
              map.set(c.clientId, { clientId: c.clientId, color: c.color, displayName: c.displayName });
              renderer.addOrUpdateCursor({ clientId: c.clientId, color: c.color, displayName: c.displayName });
              // Seed interpolation buffer with last-known position so cursor
              // appears at the right spot immediately (not at 0,0).
              renderer.pushPosition(c.clientId, c.x, c.y, 0, Date.now());
            }
          });
          break;
        }
        case 'peer_join': {
          mutatePeers(map => {
            map.set(msg.clientId, { clientId: msg.clientId, color: msg.color, displayName: msg.displayName });
          });
          renderer.addOrUpdateCursor({ clientId: msg.clientId, color: msg.color, displayName: msg.displayName });
          break;
        }
        case 'peer_leave': {
          mutatePeers(map => { map.delete(msg.clientId); });
          renderer.removeCursor(msg.clientId);
          break;
        }
        case 'cursor': {
          renderer.pushPosition(msg.clientId, msg.x, msg.y, msg.seq, msg.serverTs);
          break;
        }
        case 'reaction': {
          // Convert normalized coords → logical canvas pixels for the renderer.
          const peer = peersRef.current.get(msg.clientId);
          const color = peer?.color ?? '#6366f1';
          renderer.addReaction(
            msg.id,
            msg.x * canvas.offsetWidth,
            msg.y * canvas.offsetHeight,
            msg.emoji,
            color,
          );
          break;
        }
        case 'pong': {
          // RTT = now − the clientTs we sent.
          setRtt(Date.now() - msg.clientTs);
          break;
        }
        case 'error': {
          console.warn('[App] Server error:', msg.code, msg.message);
          break;
        }
      }
    };

    const unsub = room.onRemoteAction(handleMessage);

    // 4. Poll connection state for UI indicator (low frequency is fine).
    const statePoller = setInterval(() => {
      setConnState(room.getState());
    }, 300);

    // 5. Resize handler.
    const onResize = (): void => renderer.resize();
    window.addEventListener('resize', onResize);

    return (): void => {
      unsub();
      room.destroy();
      renderer.stop();
      clearInterval(statePoller);
      window.removeEventListener('resize', onResize);
    };
  }, [mutatePeers]);

  // ── Input handlers ────────────────────────────────────────────────────────────

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>): void => {
    const now = Date.now();
    if (now - lastSentRef.current < CURSOR_THROTTLE_MS) return; // throttle to 30Hz
    lastSentRef.current = now;

    const rect = e.currentTarget.getBoundingClientRect();
    roomRef.current?.sendAction({
      type: 'cursor',
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      seq: ++seqRef.current,
    });
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const id = `${CLIENT_ID}-${Date.now()}`;
    const selectedEmoji = emojiRef.current;

    // Optimistic local render — don't wait for the server round-trip.
    rendererRef.current?.addReaction(id, e.clientX - rect.left, e.clientY - rect.top, selectedEmoji, '#6366f1');

    // Broadcast to peers.
    roomRef.current?.sendAction({ type: 'reaction', x, y, emoji: selectedEmoji, id });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────

  const s = STATUS_STYLES[connState] ?? STATUS_STYLES.connecting;
  const participantCount = peerList.length + 1; // +1 for self

  return (
    <div className="app-root">

      {/* ── Top bar ── */}
      <header className="top-bar">
        <div className="top-bar-left">
          <div className="logo">
            <span className="logo-pulse" aria-hidden="true" />
            <span className="logo-text">LiveRoom</span>
          </div>
          <span className="room-tag">#{ROOM_ID}</span>
        </div>
        <div className="top-bar-right">
          <div
            className="status-chip"
            style={{ color: s.dot, background: s.bg, border: `1px solid ${s.border}` }}
            role="status"
            aria-label={`Connection: ${s.label}`}
          >
            <span className="status-dot" style={{ background: s.dot }} aria-hidden="true" />
            {s.label}
          </div>
          {rtt !== null && (
            <div className="rtt-chip" title="Round-trip latency">
              ⚡ <span className="rtt-num">{rtt}</span>ms
            </div>
          )}
        </div>
      </header>

      {/* ── Full-viewport canvas ── */}
      <canvas
        id="sync-canvas"
        ref={canvasRef}
        className="sync-canvas"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        aria-label="Shared cursor canvas — move to show your cursor, click to react"
      />

      {/* ── Instruction hint ── */}
      <p className="canvas-hint" aria-hidden="true">Move your cursor · Click to react</p>

      {/* ── Sidebar: participants ── */}
      <aside className="sidebar" aria-label="Participants">
        <div className="sidebar-head">
          <span className="sidebar-title">Participants</span>
          <span className="sidebar-count" aria-label={`${participantCount} participants`}>
            {participantCount}
          </span>
        </div>
        <ul className="peer-list" role="list">
          {/* Self first */}
          <li className="peer-item peer-self" role="listitem">
            <span className="peer-dot" style={{ background: 'var(--accent)' }} aria-hidden="true" />
            <span className="peer-name">{DISPLAY_NAME}</span>
            <span className="peer-you-badge">you</span>
          </li>
          {peerList.map(p => (
            <li key={p.clientId} className="peer-item" role="listitem">
              <span className="peer-dot" style={{ background: p.color }} aria-hidden="true" />
              <span className="peer-name">{p.displayName}</span>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Emoji picker ── */}
      <div className="emoji-bar" role="toolbar" aria-label="Reaction emojis">
        {EMOJIS.map(e => (
          <button
            key={e}
            id={`emoji-btn-${e.codePointAt(0)}`}
            className={`emoji-btn${emoji === e ? ' active' : ''}`}
            onClick={() => setEmoji(e)}
            aria-label={`Select ${e} reaction`}
            aria-pressed={emoji === e}
            title={`React with ${e}`}
          >
            {e}
          </button>
        ))}
      </div>

    </div>
  );
}
