'use strict';

/**
 * mobile-behavior-engine.js
 *
 * MOBILE BEHAVIOR ENGINE — Captura e inferencia de comportamiento táctil.
 *
 * ============================================================================
 * DISEÑO
 * ============================================================================
 *
 * Captura señales de bajo nivel del dispositivo touch y las transforma en
 * señales comportamentales normalizadas, sin afectar el comportamiento desktop.
 *
 * Señales capturadas:
 *   - touch duration       tiempo de contacto en ms
 *   - touch velocity       desplazamiento / tiempo (px/ms)
 *   - swipe direction      'up' | 'down' | 'left' | 'right'
 *   - swipe velocity       magnitud del swipe (px/ms)
 *   - viewport attention   fracción del viewport ocupada por el elemento de interés
 *   - thumb-zone           si el toque ocurrió en la zona natural del pulgar
 *   - hesitation patterns  pausas largas sin acción en un producto/elemento
 *
 * Output de inferencia:
 *   {
 *     intent:     string,  // 'exploring' | 'hesitating' | 'high_intent' | 'disengaged'
 *     confidence: number,  // 0–1
 *     signals:    object,  // señales crudas normalizadas
 *   }
 *
 * Reglas:
 *   - NO Date.now() — timestamps inyectados
 *   - NO Math.random()
 *   - NO DOM manipulation
 *   - Determinista: mismas entradas → mismas salidas
 *   - Desktop-safe: si no hay eventos touch, el motor queda silencioso
 *   - Bounded: LRU en todos los buffers
 *   - Replay-safe: snapshot() / restore()
 *   - Authority: SIGNALS only — no decide, no interviene
 *
 * ============================================================================
 * INTEGRACIÓN
 * ============================================================================
 *
 *   - signal-derivation-engine puede leer inferMobileIntent() como señal adicional
 *   - session-orchestrator puede inyectarlo como optional dep (no rompe desktop)
 *   - logger-v2 puede alimentar recordTouch() / recordScroll() / recordGesture()
 *   - El engine es PASIVO: solo es llamado, no emite eventos propios
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

// Thumb-zone: bottom 40% of viewport height is natural thumb reach
// (simplified model — real thumb zones vary by device/hand size)
const THUMB_ZONE_FRACTION = 0.40;

// Intent thresholds
const HIGH_INTENT_LONG_PRESS_MS    = 800;   // >800ms press → consideración seria
const HESITATION_DWELL_MS          = 2000;  // >2s sin swipe en elemento → hesitación
const FAST_SWIPE_PX_MS             = 1.5;   // >1.5px/ms → scroll rápido (explorando)
const SLOW_SWIPE_PX_MS             = 0.3;   // <0.3px/ms → scroll lento (atención)

const INTENT_STATES = Object.freeze({
  EXPLORING:   'exploring',
  HESITATING:  'hesitating',
  HIGH_INTENT: 'high_intent',
  DISENGAGED:  'disengaged',
});

const SWIPE_DIRECTIONS = Object.freeze({
  UP:    'up',
  DOWN:  'down',
  LEFT:  'left',
  RIGHT: 'right',
  NONE:  'none',
});

const DEFAULT_CONFIG = Object.freeze({
  // Buffer sizes
  maxTouchEvents:    200,
  maxScrollEvents:   200,
  maxGestures:       100,

  // Hesitation detection window
  hesitationWindowMs: 5000,

  // Minimum events before inference is considered reliable
  minEventsForInference: 3,

  // Viewport dimensions (can be overridden per-call if known)
  defaultViewportHeight: 812,   // iPhone 14 Pro in portrait
  defaultViewportWidth:  390,

  // Long-press threshold
  longPressThresholdMs: HIGH_INTENT_LONG_PRESS_MS,

  // Swipe classification thresholds
  fastSwipeThreshold: FAST_SWIPE_PX_MS,
  slowSwipeThreshold: SLOW_SWIPE_PX_MS,
});

// ============================================================================
// LRU Map (minimal)
// ============================================================================

class LRUMap {
  constructor(cap) {
    this._cap = Math.max(1, cap | 0);
    this._map = new Map();
  }
  get size() { return this._map.size; }
  get(k) {
    if (!this._map.has(k)) return undefined;
    const v = this._map.get(k); this._map.delete(k); this._map.set(k, v); return v;
  }
  set(k, v) {
    if (this._map.has(k)) this._map.delete(k);
    this._map.set(k, v);
    while (this._map.size > this._cap) this._map.delete(this._map.keys().next().value);
  }
  has(k) { return this._map.has(k); }
  clear() { this._map.clear(); }
  values() { return this._map.values(); }
  entries() { return this._map.entries(); }
}

// ============================================================================
// Ring buffer for bounded event storage
// ============================================================================

class RingBuffer {
  constructor(cap) {
    this._cap = Math.max(1, cap | 0);
    this._buf = new Array(this._cap);
    this._head = 0;
    this._size = 0;
  }

  push(item) {
    this._buf[this._head % this._cap] = item;
    this._head++;
    if (this._size < this._cap) this._size++;
  }

  toArray() {
    if (this._size === 0) return [];
    const start = this._size < this._cap ? 0 : this._head % this._cap;
    const out = [];
    for (let i = 0; i < this._size; i++) {
      out.push(this._buf[(start + i) % this._cap]);
    }
    return out;
  }

  get size() { return this._size; }
  clear() { this._head = 0; this._size = 0; }

  snapshot() { return { buf: this._buf.slice(), head: this._head, size: this._size, cap: this._cap }; }
  restore(s) {
    if (!s) return;
    this._cap  = s.cap  || this._cap;
    this._buf  = s.buf  || [];
    this._head = s.head || 0;
    this._size = s.size || 0;
  }
}

// ============================================================================
// MobileBehaviorEngine
// ============================================================================

class MobileBehaviorEngine {
  /**
   * @param {object} [config]  Overrides DEFAULT_CONFIG
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    // Per-session buffers
    // sessionId → { touches: RingBuffer, scrolls: RingBuffer, gestures: RingBuffer, dwellStart: number|null }
    this._sessions = new LRUMap(5000);

    this._disposed = false;
  }

  // ==========================================================================
  // RECORDING
  // ==========================================================================

  /**
   * Records a touch start/end event.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {'touchstart'|'touchend'|'touchcancel'} p.eventType
   * @param {number} p.x           Client X coordinate
   * @param {number} p.y           Client Y coordinate
   * @param {number} p.viewportHeight
   * @param {number} p.viewportWidth
   * @param {number} p.nowMs
   * @param {string} [p.elementContext]  e.g. 'product_card', 'add_to_cart_button'
   */
  recordTouch({ sessionId, eventType, x, y, viewportHeight, viewportWidth, nowMs, elementContext }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    const sess = this._getOrInitSession(sessionId);
    const vH = viewportHeight || this._config.defaultViewportHeight;
    const vW = viewportWidth  || this._config.defaultViewportWidth;

    const inThumbZone = typeof y === 'number' && y > vH * (1 - THUMB_ZONE_FRACTION);

    const record = {
      type:           eventType || 'touchstart',
      x:              x || 0,
      y:              y || 0,
      timestamp:      nowMs,
      inThumbZone,
      elementContext: elementContext || null,
      viewportH:      vH,
      viewportW:      vW,
    };

    sess.touches.push(record);

    // Track dwell for hesitation detection
    if (eventType === 'touchstart') {
      sess.dwellStart = nowMs;
      sess.dwellElement = elementContext || null;
    } else if (eventType === 'touchend' || eventType === 'touchcancel') {
      if (sess.dwellStart !== null) {
        const duration = nowMs - sess.dwellStart;
        record.dwellMs = duration;
        sess.lastTouchDurationMs = duration;
        sess.dwellStart = null;
      }
    }
  }

  /**
   * Records a scroll event.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {number} p.deltaY         Vertical delta in pixels (positive = down)
   * @param {number} p.deltaX         Horizontal delta in pixels
   * @param {number} p.velocityPxMs   Optional: pre-computed velocity
   * @param {number} p.nowMs
   */
  recordScroll({ sessionId, deltaY, deltaX, velocityPxMs, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    const sess = this._getOrInitSession(sessionId);
    const last = sess.scrolls.size > 0 ? sess.lastScrollAt : null;
    const timeDelta = last !== null ? nowMs - last : null;

    // Compute velocity if not provided
    let velocity = velocityPxMs;
    if (velocity == null && timeDelta != null && timeDelta > 0) {
      const dist = Math.sqrt((deltaY || 0) ** 2 + (deltaX || 0) ** 2);
      velocity = dist / timeDelta;
    }

    sess.scrolls.push({
      deltaY:    deltaY || 0,
      deltaX:    deltaX || 0,
      velocity:  velocity != null ? velocity : null,
      timestamp: nowMs,
      timeDelta,
    });

    sess.lastScrollAt = nowMs;
  }

  /**
   * Records a recognized gesture (swipe, pinch, long-press, tap).
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {'swipe'|'pinch'|'long_press'|'tap'|'double_tap'} p.gestureType
   * @param {string} [p.direction]   For swipes: 'up'|'down'|'left'|'right'
   * @param {number} [p.velocity]    px/ms
   * @param {number} [p.durationMs]  For long_press
   * @param {string} [p.elementContext]
   * @param {number} p.nowMs
   */
  recordGesture({ sessionId, gestureType, direction, velocity, durationMs, elementContext, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    const sess = this._getOrInitSession(sessionId);

    sess.gestures.push({
      gestureType:    gestureType || 'tap',
      direction:      direction   || SWIPE_DIRECTIONS.NONE,
      velocity:       typeof velocity   === 'number' ? velocity   : null,
      durationMs:     typeof durationMs === 'number' ? durationMs : null,
      elementContext: elementContext || null,
      timestamp:      nowMs,
    });
  }

  // ==========================================================================
  // INFERENCE
  // ==========================================================================

  /**
   * Infers the current mobile behavioral intent from accumulated signals.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {number} p.nowMs
   * @param {string} [p.currentElement]  Element currently in viewport
   * @returns {{ intent: string, confidence: number, signals: object }}
   */
  inferMobileIntent({ sessionId, nowMs, currentElement }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    const sess = this._sessions.get(sessionId);
    if (!sess) {
      return {
        intent:     INTENT_STATES.EXPLORING,
        confidence: 0,
        signals:    { noData: true },
      };
    }

    const touches  = sess.touches.toArray();
    const scrolls  = sess.scrolls.toArray();
    const gestures = sess.gestures.toArray();
    const total    = touches.length + scrolls.length + gestures.length;

    if (total < this._config.minEventsForInference) {
      return {
        intent:     INTENT_STATES.EXPLORING,
        confidence: 0,
        signals:    { insufficientData: true, eventCount: total },
      };
    }

    // ── Compute raw signals
    const signals = this._computeSignals(touches, scrolls, gestures, sess, nowMs, currentElement);

    // ── Rule-based intent classification
    const { intent, confidence, rationale } = this._classifyIntent(signals, nowMs);

    return { intent, confidence, signals: { ...signals, rationale } };
  }

  // ==========================================================================
  // PRIVATE — Signal computation
  // ==========================================================================

  _computeSignals(touches, scrolls, gestures, sess, nowMs, currentElement) {
    // ── Touch duration
    const touchDurations = touches
      .filter(t => t.dwellMs != null)
      .map(t => t.dwellMs);
    const avgTouchDurationMs = touchDurations.length > 0
      ? touchDurations.reduce((s, v) => s + v, 0) / touchDurations.length
      : 0;
    const maxTouchDurationMs = touchDurations.length > 0
      ? Math.max(...touchDurations)
      : 0;

    // ── Thumb zone ratio
    const thumbZoneTouches = touches.filter(t => t.inThumbZone).length;
    const thumbZoneRatio   = touches.length > 0 ? thumbZoneTouches / touches.length : 0;

    // ── Scroll velocity (recent 5 scrolls)
    const recentScrolls  = scrolls.slice(-5);
    const scrollVelocities = recentScrolls.filter(s => s.velocity != null).map(s => s.velocity);
    const avgScrollVelocity = scrollVelocities.length > 0
      ? scrollVelocities.reduce((s, v) => s + v, 0) / scrollVelocities.length
      : null;

    // ── Swipe direction distribution
    const swipes = gestures.filter(g => g.gestureType === 'swipe');
    const swipeDir = { up: 0, down: 0, left: 0, right: 0 };
    for (const s of swipes) {
      if (s.direction in swipeDir) swipeDir[s.direction]++;
    }

    // ── Hesitation: time since last touch without scroll, on same element
    const lastTouch = touches.length > 0 ? touches[touches.length - 1] : null;
    const timeSinceLastTouch = lastTouch ? nowMs - lastTouch.timestamp : Infinity;
    const isHesitating = (
      timeSinceLastTouch > HESITATION_DWELL_MS &&
      timeSinceLastTouch < this._config.hesitationWindowMs &&
      (currentElement === null || currentElement === lastTouch?.elementContext)
    );

    // ── Long press detected
    const hasLongPress = gestures.some(
      g => g.gestureType === 'long_press' && g.durationMs != null && g.durationMs >= this._config.longPressThresholdMs
    );

    // ── Viewport attention: fraction of scrolls that were slow (attending)
    const slowScrolls = scrollVelocities.filter(v => v < this._config.slowSwipeThreshold).length;
    const viewportAttention = scrollVelocities.length > 0 ? slowScrolls / scrollVelocities.length : 0;

    return {
      avgTouchDurationMs,
      maxTouchDurationMs,
      thumbZoneRatio,
      avgScrollVelocity,
      swipeDir,
      isHesitating,
      hasLongPress,
      viewportAttention,
      touchCount:   touches.length,
      scrollCount:  scrolls.length,
      gestureCount: gestures.length,
      timeSinceLastTouchMs: timeSinceLastTouch === Infinity ? null : timeSinceLastTouch,
    };
  }

  // ==========================================================================
  // PRIVATE — Intent classification (rule-based)
  // ==========================================================================

  _classifyIntent(signals, nowMs) {
    const scores = {
      [INTENT_STATES.HIGH_INTENT]:  0,
      [INTENT_STATES.HESITATING]:   0,
      [INTENT_STATES.EXPLORING]:    0,
      [INTENT_STATES.DISENGAGED]:   0,
    };
    const rationale = [];

    // Long press → strong purchase consideration
    if (signals.hasLongPress) {
      scores[INTENT_STATES.HIGH_INTENT] += 0.4;
      rationale.push('long_press_detected');
    }

    // Long average touch duration → considering
    if (signals.avgTouchDurationMs > 600) {
      scores[INTENT_STATES.HIGH_INTENT] += 0.2;
      rationale.push(`long_avg_touch:${signals.avgTouchDurationMs.toFixed(0)}ms`);
    }

    // Hesitation pattern
    if (signals.isHesitating) {
      scores[INTENT_STATES.HESITATING] += 0.5;
      rationale.push('hesitation_dwell_detected');
    }

    // Slow scroll = viewport attention = engaging
    if (signals.viewportAttention > 0.6) {
      scores[INTENT_STATES.HIGH_INTENT] += 0.15;
      scores[INTENT_STATES.HESITATING]  += 0.15;
      rationale.push(`high_viewport_attention:${(signals.viewportAttention * 100).toFixed(0)}%`);
    }

    // Fast scroll = exploring / disengaged
    if (signals.avgScrollVelocity != null && signals.avgScrollVelocity > this._config.fastSwipeThreshold) {
      scores[INTENT_STATES.EXPLORING] += 0.35;
      rationale.push(`fast_scroll:${signals.avgScrollVelocity.toFixed(2)}px/ms`);
    }

    // Thumb zone usage → natural engagement (not disengaged)
    if (signals.thumbZoneRatio > 0.7) {
      scores[INTENT_STATES.HIGH_INTENT] += 0.1;
      rationale.push(`thumb_zone_ratio:${(signals.thumbZoneRatio * 100).toFixed(0)}%`);
    }

    // Long inactivity → disengaged
    if (signals.timeSinceLastTouchMs != null && signals.timeSinceLastTouchMs > this._config.hesitationWindowMs) {
      scores[INTENT_STATES.DISENGAGED] += 0.5;
      rationale.push(`inactivity:${(signals.timeSinceLastTouchMs / 1000).toFixed(1)}s`);
    }

    // Dominant left/right swipe → navigating / comparing (exploring)
    const { swipeDir } = signals;
    const lateralSwipes = (swipeDir.left || 0) + (swipeDir.right || 0);
    const verticalSwipes = (swipeDir.up || 0) + (swipeDir.down || 0);
    if (lateralSwipes > verticalSwipes && lateralSwipes > 2) {
      scores[INTENT_STATES.EXPLORING] += 0.2;
      rationale.push('lateral_swipe_dominant');
    }

    // Default mass to exploring when few signals
    if (signals.touchCount < 3 && signals.scrollCount < 3) {
      scores[INTENT_STATES.EXPLORING] += 0.2;
    }

    // Pick dominant intent
    let maxScore = -1;
    let intent = INTENT_STATES.EXPLORING;
    for (const [k, v] of Object.entries(scores)) {
      if (v > maxScore) { maxScore = v; intent = k; }
    }

    // Confidence: proportion of max score vs theoretical max
    const THEORETICAL_MAX = 1.0;
    const confidence = Math.min(1, Math.max(0, Math.round(maxScore / THEORETICAL_MAX * 100) / 100));

    return { intent, confidence, rationale };
  }

  // ==========================================================================
  // PRIVATE — Session init
  // ==========================================================================

  _getOrInitSession(sessionId) {
    const existing = this._sessions.get(sessionId);
    if (existing) return existing;
    const sess = {
      touches:              new RingBuffer(this._config.maxTouchEvents),
      scrolls:              new RingBuffer(this._config.maxScrollEvents),
      gestures:             new RingBuffer(this._config.maxGestures),
      dwellStart:           null,
      dwellElement:         null,
      lastScrollAt:         null,
      lastTouchDurationMs:  null,
    };
    this._sessions.set(sessionId, sess);
    return sess;
  }

  _assertAlive() {
    if (this._disposed) throw new Error('MobileBehaviorEngine: instance has been disposed');
  }

  // ==========================================================================
  // SNAPSHOT / RESTORE
  // ==========================================================================

  snapshot() {
    this._assertAlive();
    const sessions = [];
    for (const [k, sess] of this._sessions.entries()) {
      sessions.push({
        _key:                k,
        touches:             sess.touches.snapshot(),
        scrolls:             sess.scrolls.snapshot(),
        gestures:            sess.gestures.snapshot(),
        dwellStart:          sess.dwellStart,
        dwellElement:        sess.dwellElement,
        lastScrollAt:        sess.lastScrollAt,
        lastTouchDurationMs: sess.lastTouchDurationMs,
      });
    }
    return { __schemaVersion: SCHEMA_VERSION, sessions };
  }

  restore(snap) {
    this._assertAlive();
    if (!snap || snap.__schemaVersion !== SCHEMA_VERSION) return;
    this._sessions.clear();
    for (const item of (snap.sessions || [])) {
      const { _key, touches, scrolls, gestures, ...rest } = item;
      if (!_key) continue;
      const sess = this._getOrInitSession(_key);
      sess.touches.restore(touches);
      sess.scrolls.restore(scrolls);
      sess.gestures.restore(gestures);
      Object.assign(sess, rest);
    }
  }

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================

  getDiagnostics() {
    this._assertAlive();
    return {
      schemaVersion:  SCHEMA_VERSION,
      activeSessions: this._sessions.size,
      config: {
        longPressThresholdMs: this._config.longPressThresholdMs,
        fastSwipeThreshold:   this._config.fastSwipeThreshold,
        slowSwipeThreshold:   this._config.slowSwipeThreshold,
        hesitationWindowMs:   this._config.hesitationWindowMs,
      },
    };
  }

  dispose() {
    if (this._disposed) return;
    this._sessions.clear();
    this._disposed = true;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function _assertString(v, label) {
  if (!v || typeof v !== 'string') throw new TypeError(`MobileBehaviorEngine: ${label} must be a non-empty string`);
}

function _assertFinite(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`MobileBehaviorEngine: ${label} must be a finite number`);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  MobileBehaviorEngine,
  INTENT_STATES,
  SWIPE_DIRECTIONS,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  THUMB_ZONE_FRACTION,
  HIGH_INTENT_LONG_PRESS_MS,
  HESITATION_DWELL_MS,
};
