/**
 * render.ts — Canvas Rendering Engine
 *
 * Owns the requestAnimationFrame loop and all canvas drawing.
 * This module is deliberately decoupled from WebSocket and protocol logic:
 *   - It accepts push updates via `pushPosition()` and `addReaction()`.
 *   - On each animation frame it calls RemoteCursorBuffer.getInterpolated()
 *     and draws the result.
 *
 * Rendering layers (bottom to top):
 *   1. Cleared background (transparent — CSS handles the page background).
 *   2. Remote cursors: interpolated arrow + name label.
 *   3. Emoji reaction particles: burst animation, removed after REACTION_DURATION_MS.
 *
 * DPI handling:
 *   canvas.width/height = logical size × devicePixelRatio (physical pixels).
 *   All drawing uses logical pixel coordinates — ctx.setTransform scales for DPI.
 */

import { RemoteCursorBuffer } from './interpolation';
import type { PositionSample } from './interpolation';

// ─── Constants ──────────────────────────────────────────────────────────────────

const REACTION_DURATION_MS = 1_400;
const PARTICLE_COUNT = 10;
const CURSOR_LABEL_FONT = '500 12px Inter, system-ui, sans-serif';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface RemoteCursor {
  clientId: string;
  color: string;
  displayName: string;
  buffer: RemoteCursorBuffer;
}

interface ReactionParticle {
  angle: number;   // radians
  speed: number;   // logical px/s
  rotSpeed: number;
  rot: number;
}

interface ActiveReaction {
  id: string;
  /** Logical canvas coordinates of the click origin. */
  x: number;
  y: number;
  emoji: string;
  color: string;
  startTime: number;
  particles: ReactionParticle[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Cross-browser `roundRect` helper.
 * `CanvasRenderingContext2D.roundRect` is available in Chrome 99+ / Firefox 112+.
 * Fall back to manual quadratic curves for older browsers.
 */
function canvasRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

// ─── CanvasRenderer ─────────────────────────────────────────────────────────────

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly cursors = new Map<string, RemoteCursor>();
  private readonly reactions: ActiveReaction[] = [];
  private rafId: number | null = null;
  private lastFrameTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** Recomputes canvas physical size to match its CSS logical size. Call on resize events. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const logicalW = this.canvas.offsetWidth;
    const logicalH = this.canvas.offsetHeight;
    this.canvas.width = logicalW * dpr;
    this.canvas.height = logicalH * dpr;
    // setTransform replaces (not multiplies) the current transform — idempotent.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ── Cursor management ─────────────────────────────────────────────────────────

  /** Registers or updates a remote cursor's metadata (color, name). */
  addOrUpdateCursor(opts: { clientId: string; color: string; displayName: string }): void {
    if (this.cursors.has(opts.clientId)) {
      const existing = this.cursors.get(opts.clientId)!;
      existing.color = opts.color;
      existing.displayName = opts.displayName;
    } else {
      this.cursors.set(opts.clientId, { ...opts, buffer: new RemoteCursorBuffer() });
    }
  }

  /** Removes a cursor (called on `peer_leave`). */
  removeCursor(clientId: string): void {
    this.cursors.delete(clientId);
  }

  /**
   * Pushes a new position sample into the cursor's interpolation buffer.
   * `t` defaults to Date.now() — pass a client-adjusted time if available.
   */
  pushPosition(clientId: string, x: number, y: number, seq: number, _serverTs: number): void {
    const cursor = this.cursors.get(clientId);
    if (!cursor) return;
    const sample: PositionSample = { x, y, t: Date.now(), seq };
    cursor.buffer.push(sample);
  }

  // ── Reaction management ───────────────────────────────────────────────────────

  /**
   * Adds an emoji burst at logical canvas coordinates (px, py).
   * Duplicate IDs are silently ignored — safe for optimistic local rendering.
   */
  addReaction(id: string, px: number, py: number, emoji: string, color: string): void {
    if (this.reactions.find(r => r.id === id)) return;

    const particles: ReactionParticle[] = Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      angle: (i / PARTICLE_COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.6,
      speed: 70 + Math.random() * 90,
      rotSpeed: (Math.random() - 0.5) * 5,
      rot: Math.random() * Math.PI * 2,
    }));

    this.reactions.push({ id, x: px, y: py, emoji, color, startTime: Date.now(), particles });
  }

  // ── Animation loop ────────────────────────────────────────────────────────────

  start(): void {
    if (this.rafId !== null) return;
    const loop = (timestamp: number): void => {
      const dt = (timestamp - this.lastFrameTime) / 1_000; // seconds
      this.lastFrameTime = timestamp;
      this.render(dt);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  private render(dt: number): void {
    const { ctx, canvas } = this;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    const now = Date.now();

    ctx.clearRect(0, 0, W, H);

    this.renderCursors(now, W, H);
    this.renderReactions(now, dt);
  }

  private renderCursors(now: number, W: number, H: number): void {
    const { ctx } = this;

    for (const cursor of this.cursors.values()) {
      const state = cursor.buffer.getInterpolated(now);
      if (!state) continue;

      // Fade out as the cursor goes stale, disappear at full staleness.
      const alpha = Math.max(0, 1 - state.staleness * 2);
      if (alpha <= 0.02) continue;

      ctx.globalAlpha = alpha;
      this.drawCursor(state.x * W, state.y * H, cursor.color, cursor.displayName);
    }

    ctx.globalAlpha = 1;
  }

  private renderReactions(now: number, _dt: number): void {
    const { ctx } = this;
    let i = this.reactions.length;

    while (i-- > 0) {
      const r = this.reactions[i];
      const elapsed = now - r.startTime;

      if (elapsed >= REACTION_DURATION_MS) {
        this.reactions.splice(i, 1);
        continue;
      }

      // t ∈ [0, 1]: animation progress.
      const t = elapsed / REACTION_DURATION_MS;
      const opacity = Math.pow(1 - t, 1.5); // ease-out fade

      for (const p of r.particles) {
        // Position: ease-out arc — fast initial burst, decelerates.
        const dist = p.speed * t * (1 - 0.4 * t);
        const px = r.x + Math.cos(p.angle) * dist;
        const py = r.y + Math.sin(p.angle) * dist;

        // Scale: grow slightly then shrink.
        const scale = (1 + 0.3 * Math.sin(t * Math.PI)) * (1 - 0.4 * t);
        p.rot += p.rotSpeed * 0.016; // ~60fps assumed

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(px, py);
        ctx.rotate(p.rot);
        ctx.font = `${Math.round(18 * scale)}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.emoji, 0, 0);
        ctx.restore();
      }
    }

    ctx.globalAlpha = 1;
  }

  // ── Drawing primitives ────────────────────────────────────────────────────────

  /**
   * Draws a mouse-pointer arrow cursor at (x, y) — tip at the origin.
   * Shape: standard arrow (filled with `color`, white stroke outline).
   */
  private drawCursor(x: number, y: number, color: string, label: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);

    // Drop shadow for visibility on both dark and light backgrounds.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 2;

    // Arrow cursor path (tip at origin, pointing down-right).
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 14);
    ctx.lineTo(7, 19.5);
    ctx.lineTo(9, 18.5);
    ctx.lineTo(6.5, 13);
    ctx.lineTo(11, 13);
    ctx.closePath();

    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Name label pill.
    const labelX = 14;
    const labelY = 6;
    ctx.font = CURSOR_LABEL_FONT;
    ctx.textBaseline = 'middle';
    const textW = ctx.measureText(label).width;
    const padX = 6;
    const padY = 4;

    ctx.fillStyle = color;
    ctx.beginPath();
    canvasRoundRect(ctx, labelX - padX / 2, labelY - padY - 6, textW + padX, 20, 5);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.fillText(label, labelX, labelY);

    ctx.restore();
  }
}