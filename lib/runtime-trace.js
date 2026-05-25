/**
 * runtime-trace.js — End-to-end behavioral flow tracer
 *
 * Traces the canonical user journey through the OPE behavioral intelligence
 * system:
 *   listing -> dwell -> revisit -> PDP -> cart -> checkout
 *
 * Responsibilities:
 *  - Record timestamped flow transitions with bounded buffer.
 *  - Detect out-of-order or impossible transitions (e.g. checkout -> listing
 *    without cart).
 *  - Provide snapshot/restore for deterministic replay.
 *  - Expose diagnostics for health-check integration.
 *
 * Guarantees:
 *  - NO Date.now(): all timestamps come from injected `now`.
 *  - Bounded: circular buffer with configurable cap.
 *  - Deterministic: same input sequence -> same trace output.
 *  - Replay-safe: snapshot() + restore() for session-simulator-runner.
 *
 * This module is a passive observer: it does NOT make decisions or produce
 * side-effects. It only records.
 */

'use strict';

// ============================================================================
// Canonical flow stages (ordered by typical progression)
// ============================================================================
const FLOW_STAGES = Object.freeze([
  'listing',
  'hover',
  'dwell',
  'revisit',
  'product_detail',
  'add_to_cart',
  'cart',
  'cart_hesitation',
  'checkout',
  'post_purchase',
]);

const STAGE_INDEX = Object.freeze(
  FLOW_STAGES.reduce((acc, stage, i) => { acc[stage] = i; return acc; }, {})
);

// Valid transitions: from -> [allowed next stages]
// This is lenient: users can go backward (revisit, return to listing, etc.)
// but certain jumps are flagged as anomalous.
const ANOMALOUS_TRANSITIONS = Object.freeze({
  checkout: new Set(['post_purchase']), // once in checkout, only forward to post_purchase or stay
  post_purchase: new Set([]),           // terminal: no further transitions expected
});

// ============================================================================
// Default configuration
// ============================================================================
const DEFAULT_TRACE_CONFIG = Object.freeze({
  bufferCapacity: 1024,
  // Maximum time (ms) between two entries to consider them part of the same
  // "active flow". Gaps larger than this start a new flow segment.
  flowSegmentGapMs: 5 * 60 * 1000, // 5 minutes
  // Track revisit patterns: how many times a user returns to a stage
  trackRevisitPatterns: true,
});

// ============================================================================
// RuntimeTrace class
// ============================================================================
class RuntimeTrace {
  /**
   * @param {object} [config] Override defaults
   */
  /**
   * @param {object} [config]  Override defaults
   * @param {object} [deps]    Optional: { observabilityEngine }
   */
  constructor(config = {}, deps = {}) {
    this.config = Object.freeze({ ...DEFAULT_TRACE_CONFIG, ...config });

    // Optional: observability engine for anomaly recording
    this._observabilityEngine = deps.observabilityEngine || null;

    // Circular buffer of trace entries
    this._buffer = [];
    this._seq = 0;

    // Current flow state
    this._currentStage = null;
    this._currentProductId = null;
    this._lastTransitionAt = 0;
    this._flowSegmentId = 0;

    // Revisit tracking: stage -> count within current session
    this._revisitCounts = new Map();

    // Anomaly log (bounded to buffer capacity)
    this._anomalies = [];

    this._disposed = false;
  }

  // ====================================================================
  // Core API
  // ====================================================================

  /**
   * Record a flow transition.
   * @param {string} stage    One of FLOW_STAGES
   * @param {object} metadata { productId?, context?, trigger? }
   * @param {number} now      Injected timestamp
   * @returns {{ accepted: boolean, anomaly?: string }}
   */
  /**
   * Record a flow transition.
   * @param {string} stage        One of FLOW_STAGES
   * @param {object} metadata     { productId?, context?, trigger?, sessionId? }
   * @param {number} now          Injected timestamp
   * @returns {{ accepted: boolean, anomaly?: string }}
   */
  record(stage, metadata, now) {
    if (this._disposed) return { accepted: false, anomaly: 'disposed' };
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new TypeError('RuntimeTrace.record: `now` must be a finite number');
    }
    if (!STAGE_INDEX.hasOwnProperty(stage)) {
      return { accepted: false, anomaly: `unknown_stage:${stage}` };
    }

    const prevStage = this._currentStage;
    const prevProductId = this._currentProductId;
    let anomaly = null;

    // Detect flow segment breaks
    if (this._lastTransitionAt > 0 && (now - this._lastTransitionAt) > this.config.flowSegmentGapMs) {
      this._flowSegmentId++;
    }

    // Detect anomalous transitions
    if (prevStage && ANOMALOUS_TRANSITIONS[prevStage]) {
      const allowed = ANOMALOUS_TRANSITIONS[prevStage];
      if (allowed.size > 0 && !allowed.has(stage) && stage !== prevStage) {
        anomaly = `anomalous_transition:${prevStage}->${stage}`;
        this._recordAnomaly(anomaly, now);
        // ── Forward anomaly to observability engine ───────────────────────
        if (this._observabilityEngine) {
          try {
            this._observabilityEngine.recordError({
              sessionId:  (metadata && metadata.sessionId) || null,
              errorCode:  'TRACE_ANOMALY',
              message:    anomaly,
              severity:   'low',
              context:    stage,
              nowMs:      now,
            });
          } catch (_) {}
        }
      }
    }

    // Track revisits
    if (this.config.trackRevisitPatterns) {
      const count = this._revisitCounts.get(stage) || 0;
      this._revisitCounts.set(stage, count + 1);
    }

    // Build trace entry
    this._seq++;
    const entry = {
      seq: this._seq,
      stage,
      prevStage,
      productId:  (metadata && metadata.productId)  || this._currentProductId,
      prevProductId,
      context:    (metadata && metadata.context)    || null,
      trigger:    (metadata && metadata.trigger)    || null,
      sessionId:  (metadata && metadata.sessionId)  || null,
      flowSegmentId: this._flowSegmentId,
      now,
      anomaly,
    };

    this._buffer.push(entry);
    if (this._buffer.length > this.config.bufferCapacity) {
      this._buffer.shift();
    }

    // Update state
    this._currentStage = stage;
    if (metadata && metadata.productId) {
      this._currentProductId = metadata.productId;
    }
    this._lastTransitionAt = now;

    return { accepted: true, anomaly };
  }

  /**
   * Record an anomaly without a stage transition.
   */
  _recordAnomaly(description, now) {
    this._anomalies.push({ description, now, seq: this._seq + 1 });
    if (this._anomalies.length > this.config.bufferCapacity) {
      this._anomalies.shift();
    }
  }

  // ====================================================================
  // Query API
  // ====================================================================

  /**
   * Get current flow state.
   */
  getCurrentState() {
    return {
      stage: this._currentStage,
      productId: this._currentProductId,
      flowSegmentId: this._flowSegmentId,
      lastTransitionAt: this._lastTransitionAt,
      totalTransitions: this._seq,
    };
  }

  /**
   * Get revisit counts per stage.
   */
  getRevisitCounts() {
    const result = {};
    for (const [stage, count] of this._revisitCounts) {
      result[stage] = count;
    }
    return result;
  }

  /**
   * Get trace entries matching a filter.
   * @param {object} filter { stage?, productId?, fromSeq?, limit? }
   * @returns {Array}
   */
  query(filter = {}) {
    let results = this._buffer;
    if (filter.sessionId) {
      results = results.filter(e => e.sessionId === filter.sessionId);
    }
    if (filter.stage) {
      results = results.filter(e => e.stage === filter.stage);
    }
    if (filter.productId) {
      results = results.filter(e => e.productId === filter.productId);
    }
    if (typeof filter.fromSeq === 'number') {
      results = results.filter(e => e.seq >= filter.fromSeq);
    }
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      results = results.slice(-filter.limit);
    }
    return results.map(e => ({ ...e }));
  }

  /**
   * Get all anomalies.
   */
  getAnomalies() {
    return this._anomalies.slice();
  }

  /**
   * Get flow funnel analysis: how many transitions reached each stage.
   */
  getFunnelAnalysis() {
    const counts = {};
    for (const stage of FLOW_STAGES) {
      counts[stage] = 0;
    }
    for (const entry of this._buffer) {
      if (counts.hasOwnProperty(entry.stage)) {
        counts[entry.stage]++;
      }
    }
    return counts;
  }

  // ====================================================================
  // Diagnostics
  // ====================================================================

  getDiagnostics() {
    return {
      bufferSize: this._buffer.length,
      bufferCapacity: this.config.bufferCapacity,
      totalTransitions: this._seq,
      currentStage: this._currentStage,
      flowSegmentId: this._flowSegmentId,
      anomalyCount: this._anomalies.length,
      revisitCounts: this.getRevisitCounts(),
      disposed: this._disposed,
    };
  }

  // ====================================================================
  // Snapshot / Restore
  // ====================================================================

  snapshot() {
    return {
      __type: 'RuntimeTrace',
      __version: 1,
      buffer: this._buffer.slice(),
      seq: this._seq,
      currentStage: this._currentStage,
      currentProductId: this._currentProductId,
      lastTransitionAt: this._lastTransitionAt,
      flowSegmentId: this._flowSegmentId,
      revisitCounts: Array.from(this._revisitCounts.entries()),
      anomalies: this._anomalies.slice(),
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.__type !== 'RuntimeTrace') return;
    if (snapshot.__version !== 1) return;

    this._buffer = Array.isArray(snapshot.buffer) ? snapshot.buffer.slice() : [];
    this._seq = typeof snapshot.seq === 'number' ? snapshot.seq : 0;
    this._currentStage = snapshot.currentStage || null;
    this._currentProductId = snapshot.currentProductId || null;
    this._lastTransitionAt = snapshot.lastTransitionAt || 0;
    this._flowSegmentId = typeof snapshot.flowSegmentId === 'number' ? snapshot.flowSegmentId : 0;

    this._revisitCounts = new Map();
    if (Array.isArray(snapshot.revisitCounts)) {
      for (const [k, v] of snapshot.revisitCounts) {
        this._revisitCounts.set(k, v);
      }
    }

    this._anomalies = Array.isArray(snapshot.anomalies) ? snapshot.anomalies.slice() : [];
  }

  // ====================================================================
  // Lifecycle
  // ====================================================================

  reset() {
    this._buffer.length = 0;
    this._seq = 0;
    this._currentStage = null;
    this._currentProductId = null;
    this._lastTransitionAt = 0;
    this._flowSegmentId = 0;
    this._revisitCounts.clear();
    this._anomalies.length = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._buffer.length = 0;
    this._revisitCounts.clear();
    this._anomalies.length = 0;
  }
}

module.exports = {
  RuntimeTrace,
  FLOW_STAGES,
  STAGE_INDEX,
  ANOMALOUS_TRANSITIONS,
  DEFAULT_TRACE_CONFIG,
};
