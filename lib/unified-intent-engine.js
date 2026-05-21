'use strict';

/**
 * unified-intent-engine.js (v1.0.0 — enterprise restructure)
 *
 * SINGLE AUTHORITY for intent state inference in the OPE system.
 *
 * Merges the best of three previously competing modules:
 *   - intent-state-engine:          Explicit transition graph, engagement/uncertainty axes,
 *                                    evidence-based transitions, persistence.
 *   - interaction-transition-layer: Hysteresis, momentum, oscillation detection,
 *                                    probabilistic stabilization.
 *   - behavioral-intelligence-layer: Pattern detection (ENRICHMENT ONLY, not decision-making).
 *
 * Design decisions:
 *   1. The TRANSITION GRAPH from intent-state-engine is the authority for
 *      which state transitions are allowed.
 *   2. The HYSTERESIS and OSCILLATION DETECTION from interaction-transition-layer
 *      stabilize transitions (prevent flickering).
 *   3. behavioral-intelligence-layer provides ENRICHMENT signals (micro-intentions,
 *      hesitation score, comparison depth, return risk) that are READ-ONLY context
 *      for consumers. They do NOT determine intent state.
 *
 * Guarantees:
 *   - Deterministic: NO Date.now() internally. All functions receive `nowMs`.
 *   - Replay-safe: Snapshot/restore preserves full state.
 *   - Bounded memory: Ring buffers, LRU caches, capped histories.
 *   - Single pipeline: One update() call produces one authoritative state.
 *   - 9 canonical intent states from ope-constants.
 *
 * No external dependencies beyond ope-constants.
 */

const {
  INTENT_STATES,
  VALID_INTENT_STATES,
  INITIAL_INTENT_STATE,
  INTENT_VALENCE,
  normalizeIntentState,
} = require('./ope-constants');

// ============================================================================
// CONFIGURATION
// ============================================================================

const ENGINE_VERSION = '1.0.0';
const SNAPSHOT_VERSION = '1.0.0';

const DEFAULT_CONFIG = Object.freeze({
  // --- Engagement / Uncertainty axes ---
  engagementWindowMs:     300_000,   // 5 min
  uncertaintyWindowMs:    120_000,   // 2 min
  momentumWindowMs:        30_000,   // 30s

  // --- Decay rates (per minute) ---
  confidenceDecayPerMin:  0.05,
  engagementDecayPerMin:  0.15,
  momentumDecayPerMin:    1.20,

  // --- Confidence ---
  initialConfidence:      0.30,
  minConfidence:          0.00,
  maxConfidence:          0.95,
  confidenceToTransition: 0.45,

  // --- Hysteresis (from interaction-transition-layer) ---
  hysteresisTimeMs:       8_000,    // min time in state before allowing another transition
  oscillationWindowMs:    60_000,   // window for detecting A->B->A cycles
  maxOscillationsPerWindow: 2,
  oscillationPenaltyFactor: 0.5,    // multiplier on transition probability when oscillating

  // --- Dwell ---
  minDwellMsDefault:      1_500,

  // --- Capacity ---
  signalsHistoryCap:      100,
  transitionsRingSize:     25,
  seenIdsCap:             256,
  activeSessionsCap:     5_000,

  // --- Persistence ---
  persistMinIntervalMs:   500,
  persistEpsilon:         0.01,

  // --- Context weights (how much context amplifies transitions) ---
  contextWeights: Object.freeze({
    listing:        0.8,
    product_detail: 1.0,
    modal:          1.2,
    hover_cta:      1.5,
    cart:           1.3,
    checkout:       1.6,
  }),
});

// ============================================================================
// SIGNAL WEIGHTS (engagement axis contribution per event type)
// ============================================================================

const SIGNAL_WEIGHTS = Object.freeze({
  // Positive
  product_zoom:          0.05,
  add_to_cart:           0.40,
  start_checkout:        0.60,
  view_reviews:          0.10,
  size_selected:         0.15,
  variant_click:         0.10,
  repeated_add_to_cart:  0.20,
  cta_hover:             0.08,
  cta_click:             0.35,
  checkout_hover:        0.25,
  // Negative
  exit_intent:          -0.30,
  cart_removal:         -0.20,
  back_button:          -0.15,
  idle_long:            -0.10,
  scroll_up_fast:       -0.05,
  // Exploratory
  search:                0.02,
  filter:                0.02,
  page_scroll:           0.01,
  hover:                 0.005,
  product_view:          0.03,
  modal_open:            0.06,
  variant_change:        0.04,
});

// ============================================================================
// ALLOWED TRANSITIONS GRAPH (from intent-state-engine, expanded to 9 states)
// ============================================================================

const ALLOWED_TRANSITIONS = Object.freeze({
  exploring: [
    { to: 'evaluating',  minEngagement:  0.15, maxUncertainty: 0.7, minEvidenceN: 3, minDwellMs: 1500 },
    { to: 'exit_risk',   maxEngagement: -0.30, maxUncertainty: 0.9, minEvidenceN: 2, minDwellMs: 800 },
    { to: 'disengaging', maxEngagement: -0.15, maxUncertainty: 0.5, minEvidenceN: 2, minDwellMs: 5000 },
  ],
  evaluating: [
    { to: 'comparing',   minEngagement:  0.10, minUncertainty: 0.3, minEvidenceN: 3, minDwellMs: 2000 },
    { to: 'high_intent', minEngagement:  0.45, maxUncertainty: 0.5, minEvidenceN: 4, minDwellMs: 2000 },
    { to: 'hesitating',  minEngagement: -0.10, maxEngagement: 0.30, minUncertainty: 0.55, minEvidenceN: 3, minDwellMs: 1500 },
    { to: 'exit_risk',   maxEngagement: -0.35, minEvidenceN: 2, minDwellMs: 1000 },
    { to: 'exploring',   maxEngagement:  0.05, maxUncertainty: 0.5, minEvidenceN: 2, minDwellMs: 5000 },
  ],
  comparing: [
    { to: 'evaluating',  maxUncertainty: 0.35, minEvidenceN: 3, minDwellMs: 3000 },
    { to: 'hesitating',  minUncertainty: 0.50, minEvidenceN: 3, minDwellMs: 2000 },
    { to: 'high_intent', minEngagement:  0.45, maxUncertainty: 0.45, minEvidenceN: 4, minDwellMs: 2500 },
    { to: 'exit_risk',   maxEngagement: -0.30, minEvidenceN: 2, minDwellMs: 1500 },
  ],
  hesitating: [
    { to: 'high_intent', minEngagement:  0.40, maxUncertainty: 0.4, minEvidenceN: 4, minDwellMs: 2500 },
    { to: 'evaluating',  maxUncertainty: 0.40, minEvidenceN: 3, minDwellMs: 3000 },
    { to: 'comparing',   minUncertainty: 0.40, minEngagement: 0.05, minEvidenceN: 3, minDwellMs: 2000 },
    { to: 'exit_risk',   maxEngagement: -0.30, minEvidenceN: 2, minDwellMs: 1500 },
    { to: 'disengaging', maxEngagement: -0.10, maxUncertainty: 0.35, minEvidenceN: 2, minDwellMs: 5000 },
  ],
  high_intent: [
    { to: 'purchase_ready', minEngagement: 0.65, maxUncertainty: 0.35, minEvidenceN: 3, minDwellMs: 1500 },
    { to: 'hesitating',     minUncertainty: 0.55, minEvidenceN: 3, minDwellMs: 2500 },
    { to: 'evaluating',     maxEngagement:  0.20, minEvidenceN: 3, minDwellMs: 3000 },
    { to: 'exit_risk',      maxEngagement: -0.40, minEvidenceN: 2, minDwellMs: 1500 },
  ],
  purchase_ready: [
    { to: 'high_intent', maxEngagement:  0.50, minEvidenceN: 2, minDwellMs: 2000 },
    { to: 'hesitating',  minUncertainty: 0.55, minEvidenceN: 3, minDwellMs: 2000 },
    { to: 'exit_risk',   maxEngagement: -0.35, minEvidenceN: 2, minDwellMs: 1000 },
  ],
  exit_risk: [
    { to: 'exploring',  minEngagement: -0.05, maxUncertainty: 0.7, minEvidenceN: 2, minDwellMs: 3000 },
    { to: 'evaluating', minEngagement:  0.20, maxUncertainty: 0.6, minEvidenceN: 3, minDwellMs: 3000 },
    { to: 'disengaging', maxEngagement: -0.40, minEvidenceN: 2, minDwellMs: 5000 },
  ],
  disengaging: [
    { to: 'exploring',  minEngagement:  0.05, minEvidenceN: 2, minDwellMs: 3000 },
    { to: 'evaluating', minEngagement:  0.25, minEvidenceN: 3, minDwellMs: 3000 },
    { to: 'exit_risk',  maxEngagement: -0.35, minEvidenceN: 2, minDwellMs: 2000 },
  ],
});

// ============================================================================
// PURE HELPERS
// ============================================================================

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(Math.max(x, lo), hi);
}

function decayValue(value, ratePerMin, minutesIdle) {
  if (minutesIdle <= 0) return value;
  return value * Math.exp(-ratePerMin * minutesIdle);
}

// ============================================================================
// RING BUFFER
// ============================================================================

class RingBuffer {
  constructor(cap) { this.cap = cap; this.buf = new Array(cap); this.head = 0; this.size = 0; }
  push(item) {
    const idx = (this.head + this.size) % this.cap;
    if (this.size < this.cap) { this.buf[idx] = item; this.size++; }
    else { this.buf[this.head] = item; this.head = (this.head + 1) % this.cap; }
  }
  toArray() {
    const out = new Array(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(this.head + i) % this.cap];
    return out;
  }
  fromArray(arr) { this.head = 0; this.size = 0; for (const x of arr || []) this.push(x); }
  clear() { this.head = 0; this.size = 0; }
}

// ============================================================================
// LRU SET (for dedup)
// ============================================================================

class LruSet {
  constructor(cap) { this.cap = cap; this.map = new Map(); }
  has(id) {
    if (!this.map.has(id)) return false;
    const v = this.map.get(id); this.map.delete(id); this.map.set(id, v); return true;
  }
  add(id) {
    if (this.map.has(id)) this.map.delete(id);
    else if (this.map.size >= this.cap) { this.map.delete(this.map.keys().next().value); }
    this.map.set(id, 1);
  }
  serialize() { return Array.from(this.map.keys()).slice(-this.cap); }
  hydrate(arr) { this.map.clear(); for (const id of arr || []) this.add(id); }
}

// ============================================================================
// AXIS COMPUTATION (engagement, uncertainty, momentum)
// ============================================================================

function computeEngagement(history, nowMs, windowMs) {
  let pos = 0, neg = 0;
  for (const ev of history) {
    if (nowMs - ev.ts > windowMs) continue;
    const w = SIGNAL_WEIGHTS[ev.type];
    if (w === undefined) continue;
    const age = (nowMs - ev.ts) / 1000;
    const decay = Math.exp(-0.02 * age);
    if (w > 0) pos += w * decay;
    else if (w < 0) neg += Math.abs(w) * decay;
  }
  const total = pos + neg;
  if (total === 0) return 0;
  return clamp((pos - neg) / total, -1, 1);
}

function computeUncertainty(history, nowMs, windowMs) {
  let lastSign = 0, flips = 0, count = 0;
  for (const ev of history) {
    if (nowMs - ev.ts > windowMs) continue;
    const w = SIGNAL_WEIGHTS[ev.type];
    if (w === undefined || w === 0) continue;
    const s = w > 0 ? 1 : -1;
    if (lastSign !== 0 && s !== lastSign) flips++;
    lastSign = s;
    count++;
  }
  if (count < 2) return 0;
  return clamp(flips / (count - 1), 0, 1);
}

function computeMomentum(history, nowMs, windowMs) {
  let weighted = 0;
  for (const s of history) {
    if (nowMs - s.ts > windowMs) continue;
    const age = (nowMs - s.ts) / 1000;
    const sigW = Math.abs(SIGNAL_WEIGHTS[s.type] || 0);
    weighted += sigW * Math.exp(-0.02 * age);
  }
  return clamp(weighted / 0.6, 0, 1);
}

function countRecentEvidence(history, nowMs, windowMs) {
  let n = 0;
  for (const ev of history) {
    if (nowMs - ev.ts > windowMs) continue;
    if (SIGNAL_WEIGHTS[ev.type] !== undefined) n++;
  }
  return n;
}

// ============================================================================
// MOMENTUM DIRECTION (from interaction-transition-layer)
// ============================================================================

function computeMomentumDirection(history, nowMs, windowMs) {
  let dirSum = 0, totalW = 0;
  for (const ev of history) {
    if (nowMs - ev.ts > windowMs) continue;
    const w = SIGNAL_WEIGHTS[ev.type];
    if (w === undefined) continue;
    const absW = Math.abs(w);
    const dir = w > 0 ? 1 : (w < 0 ? -1 : 0);
    dirSum += dir * absW;
    totalW += absW;
  }
  return totalW === 0 ? 0 : clamp(dirSum / totalW, -1, 1);
}

// ============================================================================
// TRANSITION SELECTION
// ============================================================================

function pickAllowedTransition({ currentState, engagement, uncertainty, evidenceN, dwellMs }) {
  const edges = ALLOWED_TRANSITIONS[currentState] || [];
  let best = null, bestScore = -Infinity;

  for (const edge of edges) {
    if (edge.minDwellMs !== undefined && dwellMs < edge.minDwellMs) continue;
    if (edge.minEvidenceN !== undefined && evidenceN < edge.minEvidenceN) continue;
    if (edge.minEngagement !== undefined && engagement < edge.minEngagement) continue;
    if (edge.maxEngagement !== undefined && engagement > edge.maxEngagement) continue;
    if (edge.minUncertainty !== undefined && uncertainty < edge.minUncertainty) continue;
    if (edge.maxUncertainty !== undefined && uncertainty > edge.maxUncertainty) continue;

    let score = 0;
    if (edge.minEngagement !== undefined) score += engagement - edge.minEngagement;
    if (edge.maxEngagement !== undefined) score += edge.maxEngagement - engagement;
    if (edge.minUncertainty !== undefined) score += uncertainty - edge.minUncertainty;
    if (edge.maxUncertainty !== undefined) score += edge.maxUncertainty - uncertainty;

    if (score > bestScore) { bestScore = score; best = edge; }
  }
  return best;
}

// ============================================================================
// OSCILLATION DETECTOR (from interaction-transition-layer)
// ============================================================================

class OscillationDetector {
  constructor(config) {
    this.windowMs = config.oscillationWindowMs;
    this.maxOscillations = config.maxOscillationsPerWindow;
    this.penaltyFactor = config.oscillationPenaltyFactor;
    this.transitions = [];
    this.windowStart = 0;
    this.penaltyActive = false;
  }

  recordTransition(from, to, nowMs) {
    // Reset window if expired
    if (nowMs - this.windowStart > this.windowMs) {
      this.windowStart = nowMs;
      this.transitions = [];
      this.penaltyActive = false;
    }
    this.transitions.push({ from, to, timestamp: nowMs });

    // Detect A->B->A cycles
    const last2 = this.transitions.slice(-2);
    if (last2.length === 2 && last2[0].from === last2[1].to && last2[0].to === last2[1].from) {
      this.penaltyActive = true;
    }
    // Cap
    if (this.transitions.length > 20) this.transitions = this.transitions.slice(-20);
  }

  shouldBlockTransition(nowMs) {
    if (!this.penaltyActive) return false;
    // Check if last oscillation is still within window
    const lastOsc = this.transitions[this.transitions.length - 1];
    if (lastOsc && (nowMs - lastOsc.timestamp) > this.windowMs) {
      this.penaltyActive = false;
      return false;
    }
    return true;
  }

  snapshot() {
    return {
      windowStart: this.windowStart,
      transitions: this.transitions.slice(),
      penaltyActive: this.penaltyActive,
    };
  }

  restore(snap) {
    if (!snap) return;
    this.windowStart = snap.windowStart || 0;
    this.transitions = Array.isArray(snap.transitions) ? snap.transitions.slice() : [];
    this.penaltyActive = !!snap.penaltyActive;
  }
}

// ============================================================================
// SESSION INTENT STATE (unified per-session state)
// ============================================================================

class SessionIntentState {
  constructor(sessionId, config) {
    this.sessionId = sessionId;
    this.config = config;
    this.currentState = INITIAL_INTENT_STATE;
    this.confidence = config.initialConfidence;
    this.momentum = 0;
    this.momentumDirection = 0;
    this.engagement = 0;
    this.uncertainty = 0;
    this.lastUpdate = 0;
    this.stateEnteredAt = 0;
    this.version = 0;
    this.context = 'listing';

    this.signalsHistory = new RingBuffer(config.signalsHistoryCap);
    this.seenEventIds = new LruSet(config.seenIdsCap);
    this.transitions = new RingBuffer(config.transitionsRingSize);
    this.oscillationDetector = new OscillationDetector(config);
  }

  /**
   * Core update: ingests signals, recomputes axes, evaluates transitions.
   * Returns a complete state descriptor.
   */
  update(recognizedSignals, nowMs) {
    if (this.lastUpdate === 0) this.lastUpdate = nowMs;
    if (this.stateEnteredAt === 0) this.stateEnteredAt = nowMs;

    const minutesIdle = Math.max(0, (nowMs - this.lastUpdate) / 60000);
    this.confidence = decayValue(this.confidence, this.config.confidenceDecayPerMin, minutesIdle);

    // Ingest signals (dedup by id)
    for (const sig of recognizedSignals) {
      if (sig.id !== undefined) {
        if (this.seenEventIds.has(sig.id)) continue;
        this.seenEventIds.add(sig.id);
      }
      this.signalsHistory.push({
        type: sig.type,
        ts: typeof sig.ts === 'number' ? sig.ts : nowMs,
        id: sig.id,
      });
    }

    const history = this.signalsHistory.toArray();

    // Recompute axes
    this.engagement = computeEngagement(history, nowMs, this.config.engagementWindowMs);
    this.uncertainty = computeUncertainty(history, nowMs, this.config.uncertaintyWindowMs);
    this.momentum = computeMomentum(history, nowMs, this.config.momentumWindowMs);
    this.momentumDirection = computeMomentumDirection(history, nowMs, this.config.momentumWindowMs);

    const evidenceN = countRecentEvidence(history, nowMs, this.config.engagementWindowMs);
    const dwellMs = nowMs - this.stateEnteredAt;

    // --- HYSTERESIS CHECK (from interaction-transition-layer) ---
    const timeSinceStateEntry = nowMs - this.stateEnteredAt;
    const hysteresisBlocking = timeSinceStateEntry < this.config.hysteresisTimeMs;

    // --- OSCILLATION CHECK ---
    const oscillationBlocking = this.oscillationDetector.shouldBlockTransition(nowMs);

    // --- TRANSITION EVALUATION ---
    let triggered = null;
    let stateChanged = false;

    if (this.confidence >= this.config.confidenceToTransition && !hysteresisBlocking && !oscillationBlocking) {
      // Apply context weight: boost transition probability in high-engagement contexts
      const contextWeight = this.config.contextWeights[this.context] || 1.0;
      const adjustedEngagement = this.engagement * contextWeight;

      triggered = pickAllowedTransition({
        currentState: this.currentState,
        engagement: adjustedEngagement,
        uncertainty: this.uncertainty,
        evidenceN,
        dwellMs,
      });
    }

    if (triggered && triggered.to !== this.currentState) {
      const from = this.currentState;
      const to = triggered.to;

      // Record oscillation BEFORE mutating state
      this.oscillationDetector.recordTransition(from, to, nowMs);

      const transition = {
        from, to,
        timestamp: nowMs,
        confidence: this.confidence,
        engagement: this.engagement,
        uncertainty: this.uncertainty,
        momentum: this.momentum,
        momentumDirection: this.momentumDirection,
        evidenceN, dwellMs,
        context: this.context,
        hysteresisApplied: false,
        oscillationRisk: this.oscillationDetector.penaltyActive,
      };

      this.transitions.push(transition);
      this.currentState = to;
      this.stateEnteredAt = nowMs;
      this.version++;
      stateChanged = true;
    }

    // Update confidence by agreement between engagement and state valence
    const stateVal = INTENT_VALENCE[this.currentState] || 0;
    const engSign = this.engagement > 0.1 ? 1 : this.engagement < -0.1 ? -1 : 0;

    let dC;
    if (stateVal === 0 && engSign === 0) dC = -0.02;
    else if (stateVal === engSign) dC = +0.05 + 0.05 * this.momentum;
    else if (stateVal === 0 || engSign === 0) dC = +0.01;
    else dC = -0.10 - 0.05 * this.uncertainty;

    this.confidence = clamp(this.confidence + dC, this.config.minConfidence, this.config.maxConfidence);
    this.lastUpdate = nowMs;
    this.version++;

    // Stability score (from interaction-transition-layer formula)
    const timeInStateSec = Math.max(0, (nowMs - this.stateEnteredAt) / 1000);
    const stateStability = clamp(
      this.confidence * 0.6 + Math.min(1, timeInStateSec / 30) * 0.4, 0, 1
    );

    return {
      state: this.currentState,
      confidence: this.confidence,
      momentum: this.momentum,
      momentumDirection: this.momentumDirection,
      engagement: this.engagement,
      uncertainty: this.uncertainty,
      stateChanged,
      stateStability,
      oscillationRisk: this.oscillationDetector.penaltyActive,
      hysteresisApplied: hysteresisBlocking,
      transition: stateChanged ? this.transitions.toArray().slice(-1)[0] : null,
      evidenceN,
      dwellMs,
      context: this.context,
      version: this.version,
    };
  }

  /**
   * Read-only snapshot with decay applied (no writes back).
   */
  decayedSnapshot(nowMs) {
    const minutesIdle = Math.max(0, (nowMs - this.lastUpdate) / 60000);
    return {
      state: this.currentState,
      confidence: decayValue(this.confidence, this.config.confidenceDecayPerMin, minutesIdle),
      momentum: decayValue(this.momentum, this.config.momentumDecayPerMin, minutesIdle),
      engagement: decayValue(this.engagement, this.config.engagementDecayPerMin, minutesIdle),
      uncertainty: this.uncertainty,
      stateStability: clamp(
        decayValue(this.confidence, this.config.confidenceDecayPerMin, minutesIdle) * 0.6 +
        Math.min(1, Math.max(0, (nowMs - this.stateEnteredAt) / 30000)) * 0.4, 0, 1
      ),
      momentumDirection: this.momentumDirection,
      oscillationRisk: this.oscillationDetector.penaltyActive,
    };
  }

  setContext(ctx) { this.context = ctx; }

  /**
   * Tick: recalculates axes without new signals (passive decay detection).
   */
  tick(nowMs) {
    return this.update([], nowMs);
  }

  serialize() {
    return {
      __engineVersion: ENGINE_VERSION,
      __snapshotVersion: SNAPSHOT_VERSION,
      sessionId: this.sessionId,
      currentState: this.currentState,
      confidence: this.confidence,
      momentum: this.momentum,
      momentumDirection: this.momentumDirection,
      engagement: this.engagement,
      uncertainty: this.uncertainty,
      lastUpdate: this.lastUpdate,
      stateEnteredAt: this.stateEnteredAt,
      version: this.version,
      context: this.context,
      signalsHistory: this.signalsHistory.toArray(),
      seenEventIds: this.seenEventIds.serialize(),
      transitions: this.transitions.toArray(),
      oscillation: this.oscillationDetector.snapshot(),
    };
  }

  static deserialize(blob, config) {
    const s = new SessionIntentState(blob.sessionId, config);
    s.currentState = VALID_INTENT_STATES.has(blob.currentState) ? blob.currentState : INITIAL_INTENT_STATE;
    s.confidence = Number.isFinite(blob.confidence) ? blob.confidence : config.initialConfidence;
    s.momentum = Number.isFinite(blob.momentum) ? blob.momentum : 0;
    s.momentumDirection = Number.isFinite(blob.momentumDirection) ? blob.momentumDirection : 0;
    s.engagement = Number.isFinite(blob.engagement) ? blob.engagement : 0;
    s.uncertainty = Number.isFinite(blob.uncertainty) ? blob.uncertainty : 0;
    s.lastUpdate = blob.lastUpdate || 0;
    s.stateEnteredAt = blob.stateEnteredAt || s.lastUpdate;
    s.version = blob.version || 0;
    s.context = blob.context || 'listing';
    s.signalsHistory.fromArray(blob.signalsHistory || []);
    s.seenEventIds.hydrate(blob.seenEventIds || []);
    s.transitions.fromArray(blob.transitions || []);
    s.oscillationDetector.restore(blob.oscillation);
    return s;
  }
}

// ============================================================================
// PUBLIC API (Stateless Factory)
// ============================================================================

/**
 * Create a new session intent state. This is the ONLY way to get an intent state.
 * @param {string} sessionId
 * @param {object} [configOverrides]
 * @returns {SessionIntentState}
 */
function createSession(sessionId, configOverrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  return new SessionIntentState(sessionId, config);
}

/**
 * Restore a session from a serialized snapshot.
 */
function restoreSession(snapshot, configOverrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  return SessionIntentState.deserialize(snapshot, config);
}

/**
 * Check if a signal type is recognized by the intent engine.
 */
function isRecognizedSignal(type) {
  return SIGNAL_WEIGHTS[type] !== undefined;
}

/**
 * Filter an array of events to only those recognized by the intent engine.
 */
function filterRecognizedSignals(events) {
  return events.filter(e => e && e.type && SIGNAL_WEIGHTS[e.type] !== undefined);
}

// ============================================================================
// ADAPTER: UnifiedIntentEngine (orchestrator-compatible wrapper)
// ============================================================================

/**
 * UnifiedIntentEngine wraps SessionIntentState with the API contract expected
 * by session-orchestrator:
 *   .initialize(initialState, now)
 *   .reset(now)
 *   .update(now)           — internally uses accumulated signals
 *   .recordSignal(type, weight, now)
 *   .snapshot()
 *   .restore(snap, now)
 *   .getDiagnostics()
 *
 * Signals are accumulated between calls to update() and flushed on each update.
 */
class UnifiedIntentEngine {
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._session = null;
    this._pendingSignals = [];
    this._initialized = false;
  }

  initialize(initialState, now) {
    this._session = new SessionIntentState('orch-managed', this._config);
    if (initialState && typeof initialState === 'string') {
      this._session.currentState = normalizeIntentState(initialState);
    }
    this._session.lastUpdate = now;
    this._session.stateEnteredAt = now;
    this._pendingSignals = [];
    this._initialized = true;
  }

  reset(now) {
    this.initialize('exploring', now);
  }

  recordSignal(type, weight, now) {
    if (!this._initialized) return;
    this._pendingSignals.push({ type, weight: weight || SIGNAL_WEIGHTS[type] || 0.1, timestamp: now });
  }

  update(now) {
    if (!this._initialized || !this._session) {
      return { currentState: 'exploring', stateConfidence: 0, transitionOccurred: false };
    }
    // Flush pending signals into a recognized-signals array
    const recognized = this._pendingSignals
      .filter(s => SIGNAL_WEIGHTS[s.type] !== undefined)
      .map(s => ({ type: s.type, weight: s.weight, timestamp: s.timestamp }));
    this._pendingSignals = [];

    const result = this._session.update(recognized, now);
    return {
      currentState: result.currentState,
      previousState: result.previousState || this._session.currentState,
      stateConfidence: result.confidence != null ? result.confidence : this._session.confidence,
      transitionOccurred: result.transitionOccurred || false,
      enrichment: result.enrichment || null,
    };
  }

  snapshot() {
    if (!this._session) return null;
    return {
      session: this._session.serialize(),
      pendingSignals: [...this._pendingSignals],
    };
  }

  restore(snap, now) {
    if (!snap) return;
    if (snap.session) {
      this._session = SessionIntentState.deserialize(snap.session, this._config);
    } else {
      this._session = new SessionIntentState('orch-managed', this._config);
    }
    this._pendingSignals = Array.isArray(snap.pendingSignals) ? [...snap.pendingSignals] : [];
    this._initialized = true;
  }

  getDiagnostics() {
    if (!this._session) return { initialized: false };
    return {
      initialized: this._initialized,
      currentState: this._session.currentState,
      confidence: this._session.confidence,
      momentum: this._session.momentum,
      engagement: this._session.engagement,
      uncertainty: this._session.uncertainty,
      version: this._session.version,
      pendingSignals: this._pendingSignals.length,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Factory
  createSession,
  restoreSession,

  // Adapter (orchestrator-compatible)
  UnifiedIntentEngine,

  // Utilities
  isRecognizedSignal,
  filterRecognizedSignals,
  normalizeIntentState,

  // Class (for advanced usage / testing)
  SessionIntentState,

  // Constants
  SIGNAL_WEIGHTS,
  ALLOWED_TRANSITIONS,
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  SNAPSHOT_VERSION,
};
