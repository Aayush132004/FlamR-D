/**
 * interpolation.ts — Remote Cursor Interpolation Engine
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Strategy: Buffered Linear Interpolation with Dead-Reckoning Extrapolation
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Problem:
 *   Remote cursor updates arrive at irregular intervals due to:
 *     1. Throttling: we send at most 30Hz (33ms between frames).
 *     2. Network jitter: arrival times vary even for evenly-sent packets.
 *     3. Out-of-order delivery: occasional reordering drops updates.
 *   Naively rendering at each received position causes visible teleporting/snapping.
 *
 * Solution: Playback Delay Buffer
 *   Each remote client has a ring buffer of timestamped positions.
 *   The render loop reads at "renderTime = now − BUFFER_DELAY_MS" (80ms behind).
 *   We find the two buffer entries bracketing renderTime and linearly interpolate.
 *
 *   This guarantees we always have at least two points to interpolate between,
 *   as long as the network jitter is < BUFFER_DELAY_MS.
 *
 * Tradeoff:
 *   +80ms of added latency for smooth motion.
 *   At 30Hz sends + 80ms buffer, the worst-case perceived lag is ~113ms.
 *   For a "watching others' cursors" use case, this is imperceptible.
 *   Live typing or direct manipulation would require a shorter buffer (~30ms)
 *   at the cost of visible stuttering on high-jitter links.
 *
 * Extrapolation (dead-reckoning):
 *   When renderTime overshoots the newest buffer entry (e.g. sender paused),
 *   we extrapolate using the last observed velocity vector, capped at
 *   EXTRAPOLATION_MAX_MS to prevent phantom movement.
 *   After STALE_THRESHOLD_MS with no new position, the cursor fades out.
 *
 * Out-of-order handling:
 *   Sequence numbers from the server are checked — if seq ≤ lastSeq for a given
 *   sender, the update is discarded. This prevents older network packets from
 *   rewinding the cursor position.
 *
 * Memory:
 *   The ring buffer is capped at MAX_BUFFER_SIZE entries. Oldest entries are
 *   evicted when full. No unbounded growth.
 */

// ─── Constants ──────────────────────────────────────────────────────────────────

/**
 * How far behind real-time the renderer reads from the buffer (ms).
 * This must be > expected network jitter to guarantee smooth interpolation.
 * 80ms is comfortable for LAN; for mobile/WAN you might tune to 100–150ms.
 */
export const BUFFER_DELAY_MS = 80;

/** Ring buffer capacity. At 30Hz sends, 16 entries covers ~530ms of history. */
const MAX_BUFFER_SIZE = 16;

// Cursor fades and is hidden after 3s with no position update. Prevents zombie cursors.
const STALE_THRESHOLD_MS = 3_000;

/**
 * Maximum time (ms) beyond the latest sample we will extrapolate.
 * Prevents ghost movement when the cursor has genuinely stopped.
 */
const EXTRAPOLATION_MAX_MS = 200;

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface PositionSample {
  x: number;
  y: number;
  /** Local clock time (Date.now()) when this sample was inserted into the buffer. */
  t: number;
  seq: number;
}

export interface InterpolatedState {
  x: number;
  y: number;
  /** True if no new position has arrived in > STALE_THRESHOLD_MS. */
  isStale: boolean;
  /**
   * Fractional staleness [0, 1].
   *   0 = freshly updated
   *   1 = max stale (STALE_THRESHOLD_MS elapsed)
   * Use for alpha-fading the cursor as it goes stale.
   */
  staleness: number;
}

// ─── RemoteCursorBuffer ─────────────────────────────────────────────────────────

export class RemoteCursorBuffer {
  private readonly buffer: PositionSample[] = [];
  private lastSeq = -1;

  /**
   * Inserts a new position sample.
   * Samples with seq ≤ lastSeq are silently discarded (out-of-order delivery).
   * When the buffer is full, the oldest entry is evicted (ring buffer semantics).
   */
  push(sample: PositionSample): boolean {
    if (sample.seq <= this.lastSeq) {
      // Out-of-order or duplicate — discard.
      return false;
    }
    this.lastSeq = sample.seq;
    this.buffer.push(sample);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift(); // Evict oldest.
    }
    return true;
  }

  /**
   * Computes the interpolated position at renderTime = `now` − BUFFER_DELAY_MS.
   *
   * Four cases:
   *   1. Buffer empty → null (cursor not yet visible).
   *   2. renderTime < oldest sample → hold oldest (we're in the delay ramp-up).
   *   3. renderTime > newest sample → extrapolate or hold (sender paused/slow).
   *   4. renderTime between two samples → linear interpolate.
   *
   * @param now     Current time from Date.now().
   * @param extrap  If true, dead-reckoning extrapolation is applied for case 3.
   */
  getInterpolated(now: number, extrap = true): InterpolatedState | null {
    if (this.buffer.length === 0) return null;

    const renderTime = now - BUFFER_DELAY_MS;
    const newest = this.buffer[this.buffer.length - 1];

    const ageMs = now - newest.t;
    const staleness = Math.min(ageMs / STALE_THRESHOLD_MS, 1);
    const isStale = staleness >= 1;

    // Case 2: Not enough history yet, or renderTime is before our oldest sample.
    if (this.buffer.length === 1 || renderTime <= this.buffer[0].t) {
      return { x: this.buffer[0].x, y: this.buffer[0].y, isStale, staleness };
    }

    // Case 3: renderTime has overshot the newest sample.
    if (renderTime >= newest.t) {
      if (extrap && !isStale && this.buffer.length >= 2) {
        const prev = this.buffer[this.buffer.length - 2];
        const dt = newest.t - prev.t;
        if (dt > 0) {
          // Velocity from last two samples (units: normalized-coords / ms).
          const vx = (newest.x - prev.x) / dt;
          const vy = (newest.y - prev.y) / dt;
          // Cap extrapolation to avoid phantom movement.
          const elapsed = Math.min(renderTime - newest.t, EXTRAPOLATION_MAX_MS);
          return {
            x: Math.max(0, Math.min(1, newest.x + vx * elapsed)),
            y: Math.max(0, Math.min(1, newest.y + vy * elapsed)),
            isStale,
            staleness,
          };
        }
      }
      // Hold last known position.
      return { x: newest.x, y: newest.y, isStale, staleness };
    }

    // Case 4: Binary-search for the pair of samples bracketing renderTime.
    // Since the buffer is small (≤ 16 entries) a linear scan is fine.
    for (let i = 1; i < this.buffer.length; i++) {
      const left = this.buffer[i - 1];
      const right = this.buffer[i];
      if (renderTime >= left.t && renderTime <= right.t) {
        const alpha = (renderTime - left.t) / (right.t - left.t);
        return {
          x: left.x + alpha * (right.x - left.x),
          y: left.y + alpha * (right.y - left.y),
          isStale,
          staleness,
        };
      }
    }

    // Fallback — should not reach here, but hold newest to be safe.
    return { x: newest.x, y: newest.y, isStale, staleness };
  }

  /** True if no samples have been pushed yet. */
  get isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  /** Unix ms of the most recently pushed sample, or null. */
  get latestTimestamp(): number | null {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].t : null;
  }
}