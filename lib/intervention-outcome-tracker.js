'use strict';

/**
 * intervention-outcome-tracker.js
 *
 * Tracks the formal outcome of every intervention shown.
 * Links each outcome to its decisionId, messageId, productId, sessionId.
 * Measures behavioral deltas between exposure and subsequent actions.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO Math.random() — fully deterministic.
 *  - Bounded memory — circular buffer capped at maxOutcomes.
 *  - snapshot() / restore() — replay-safe.
 *  - cleanup(nowMs) — purges stale records.
 *  - No side-effects — records facts, makes no decisions.
 *
 * Integration:
 *  - Receives exposure events from session-orchestrator (INTERVENTION_TRIGGERED).
 *  - Receives outcome signals from processEvent (cart_add, dismiss, checkout, etc.).
 *  - Links back to decision-explainability-engine via decisionId.
 *  - Feed into intervention-learning-store via getOutcomesForLearning().
 *
 * Authority: TRACK only. Does NOT decide. Does NOT rank. Does NOT explain.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

/** All possible outcome types for an intervention */
const OUTCOME_TYPES = Object.freeze({
  SHOWN:                      'shown',
  IGNORED:                    'ignored',            // session ended or context changed without reaction
  DISMISSED:                  'dismissed',          // explicit user dismiss
  CLICKED:                    'clicked',            // user clicked the message CTA
  HOVER_AFTER:                'hover_after',        // user hovered CTA after seeing message
  ADD_TO_CART_AFTER:          'add_to_cart_after',  // added product after seeing message
  REMOVE_FROM_CART_AFTER:     'remove_from_cart_after',
  CHECKOUT_AFTER:             'checkout_after',     // completed checkout after message
  REVISIT_AFTER:              'revisit_after',      // returned to product after message
  CONVERSION_AFTER:           'conversion_after',   // revenue-positive conversion attributed
  FUNNEL_ADVANCED:            'funnel_advanced',    // funnel stage advanced after message
  INTENT_ESCALATED:           'intent_escalated',   // intent state improved after message
  HESITATION_REDUCED:         'hesitation_reduced', // hesitation signals decreased after message
  CART_RECOVERY:              'cart_recovery',      // removed from cart, then re-added after message
});

/** Attribution window: max ms between message shown and outcome attribution */
const DEFAULT_ATTRIBUTION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_CONFIG = Object.freeze({
  maxOutcomes: 4096,
  retentionMs: 60 * 60 * 1000,          // 1 hour
  attributionWindowMs: DEFAULT_ATTRIBUTION_WINDOW_MS,
  // Track deltas between exposure and outcome
  trackFunnelDelta: true,
  trackIntentDelta: true,
  trackRevenueDelta: true,
  trackHesitationDelta: true,
});

// ============================================================================
// InterventionOutcomeTracker
// ============================================================================

class InterventionOutcomeTracker {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    /** @type {Map<string, ExposureRecord>} messageId -> record (active exposures) */
    this._activeExposures = new Map();
    /** @type {Array<OutcomeRecord>} completed outcome records */
    this._completedOutcomes = [];
    this._seq = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API — called by session-orchestrator
  // ==========================================================================

  /**
   * Register that an intervention was shown.
   * Must be called immediately when INTERVENTION_TRIGGERED fires.
   *
   * @param {object} params
   * @param {string} params.decisionId    — from decision-explainability-engine
   * @param {string} params.messageId     — candidate id from message-ranking-engine
   * @param {string} params.sessionId
   * @param {string} params.storeId
   * @param {string} params.productId
   * @param {string} params.context
   * @param {string} params.family        — message family
   * @param {string} [params.subtype]
   * @param {string} [params.intentStateAtExposure]
   * @param {string} [params.funnelStageAtExposure]
   * @param {number} [params.hesitationScoreAtExposure]
   * @param {number} [params.revenueAtExposure]
   * @param {number} params.nowMs
   * @returns {string} exposureId
   */
  recordExposure({
    decisionId, messageId, sessionId, storeId, productId, context,
    family, subtype,
    intentStateAtExposure, funnelStageAtExposure,
    hesitationScoreAtExposure, revenueAtExposure,
    nowMs,
  }) {
    _assertFiniteNumber(nowMs, 'recordExposure.nowMs');
    if (this._disposed) throw new Error('InterventionOutcomeTracker: disposed');

    this._seq++;
    const exposureId = `exp_${sessionId}_${this._seq}_${nowMs}`;

    const record = {
      exposureId,
      decisionId: decisionId || null,
      messageId: messageId || null,
      sessionId,
      storeId: storeId || null,
      productId: productId || null,
      context,
      family,
      subtype: subtype || null,
      exposedAt: nowMs,
      closedAt: null,

      // State at exposure time (for delta computation)
      intentStateAtExposure: intentStateAtExposure || null,
      funnelStageAtExposure: funnelStageAtExposure || null,
      hesitationScoreAtExposure: typeof hesitationScoreAtExposure === 'number' ? hesitationScoreAtExposure : null,
      revenueAtExposure: typeof revenueAtExposure === 'number' ? revenueAtExposure : 0,

      // Outcome signals (filled as events arrive)
      outcomes: [],         // Array of { type, nowMs, delta } in order
      primaryOutcome: null, // Most significant outcome type
      attributed: false,
      expired: false,
    };

    this._activeExposures.set(exposureId, record);

    // Also index by messageId for quick lookup
    this._messageIndex = this._messageIndex || new Map();
    this._messageIndex.set(messageId, exposureId);

    return exposureId;
  }

  /**
   * Record an outcome signal for an active exposure.
   * Call this from session-orchestrator.processEvent() when behavioral
   * signals arrive after an exposure.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} [params.messageId]    — preferred lookup key
   * @param {string} [params.exposureId]   — alternative lookup key
   * @param {string} params.outcomeType    — one of OUTCOME_TYPES
   * @param {object} [params.delta]        — { intentState?, funnelStage?, revenue?, hesitationScore? }
   * @param {number} params.nowMs
   * @returns {boolean} true if attributed, false if not found/expired
   */
  recordOutcome({ sessionId, messageId, exposureId, outcomeType, delta, nowMs }) {
    _assertFiniteNumber(nowMs, 'recordOutcome.nowMs');

    const id = exposureId || (this._messageIndex && this._messageIndex.get(messageId));
    if (!id) return false;

    const record = this._activeExposures.get(id);
    if (!record) return false;
    if (record.sessionId !== sessionId) return false;

    // Check attribution window
    if ((nowMs - record.exposedAt) > this._config.attributionWindowMs) {
      record.expired = true;
      this._closeExposure(id, 'ignored', nowMs);
      return false;
    }

    const outcomeEntry = {
      type: outcomeType,
      nowMs,
      deltaMs: nowMs - record.exposedAt,
      delta: delta || null,
    };
    record.outcomes.push(outcomeEntry);
    record.attributed = true;

    // Set primary outcome (highest-priority outcome wins)
    const priority = _outcomePriority(outcomeType);
    if (!record.primaryOutcome || priority > _outcomePriority(record.primaryOutcome)) {
      record.primaryOutcome = outcomeType;
    }

    // Terminal outcomes close the record
    const TERMINAL = new Set([
      OUTCOME_TYPES.CONVERSION_AFTER,
      OUTCOME_TYPES.CHECKOUT_AFTER,
      OUTCOME_TYPES.DISMISSED,
      OUTCOME_TYPES.IGNORED,
    ]);
    if (TERMINAL.has(outcomeType)) {
      this._closeExposure(id, outcomeType, nowMs);
    }

    return true;
  }

  /**
   * Signal that the session ended or the context changed irreversibly.
   * Closes all active exposures as 'ignored' unless already attributed.
   *
   * @param {string} sessionId
   * @param {number} nowMs
   */
  closeSession(sessionId, nowMs) {
    _assertFiniteNumber(nowMs, 'closeSession.nowMs');
    for (const [exposureId, record] of this._activeExposures.entries()) {
      if (record.sessionId === sessionId) {
        if (!record.attributed) {
          record.outcomes.push({ type: OUTCOME_TYPES.IGNORED, nowMs, deltaMs: nowMs - record.exposedAt, delta: null });
          record.primaryOutcome = OUTCOME_TYPES.IGNORED;
        }
        this._closeExposure(exposureId, record.primaryOutcome || OUTCOME_TYPES.IGNORED, nowMs);
      }
    }
  }

  /**
   * Close a single active exposure, moving it to completedOutcomes.
   * @private
   */
  _closeExposure(exposureId, primaryOutcome, nowMs) {
    const record = this._activeExposures.get(exposureId);
    if (!record) return;

    record.closedAt = nowMs;
    record.primaryOutcome = primaryOutcome || record.primaryOutcome || OUTCOME_TYPES.IGNORED;

    this._completedOutcomes.push(record);
    this._activeExposures.delete(exposureId);

    if (this._messageIndex) {
      this._messageIndex.delete(record.messageId);
    }

    // Enforce circular buffer
    if (this._completedOutcomes.length > this._config.maxOutcomes) {
      this._completedOutcomes.shift();
    }
  }

  // ==========================================================================
  // Measurement API
  // ==========================================================================

  /**
   * Compute outcome metrics for a session (used by intervention-learning-store).
   * @param {string} sessionId
   * @param {number} [nowMs]
   * @returns {object}
   */
  getSessionMetrics(sessionId, nowMs) {
    const records = this._completedOutcomes.filter(r => r.sessionId === sessionId);
    if (!records.length) {
      return { sessionId, total: 0, rates: {}, averageDeltaMs: null };
    }

    const total = records.length;
    const counts = {};
    for (const type of Object.values(OUTCOME_TYPES)) counts[type] = 0;
    let totalDeltaMs = 0;
    let attributed = 0;

    for (const r of records) {
      if (r.primaryOutcome && counts.hasOwnProperty(r.primaryOutcome)) {
        counts[r.primaryOutcome]++;
      }
      if (r.attributed && r.closedAt != null) {
        totalDeltaMs += (r.closedAt - r.exposedAt);
        attributed++;
      }
    }

    const rates = {};
    for (const [type, count] of Object.entries(counts)) {
      rates[type] = total > 0 ? count / total : 0;
    }

    return {
      sessionId,
      total,
      attributed,
      rates,
      averageDeltaMs: attributed > 0 ? totalDeltaMs / attributed : null,
      conversionRate: rates[OUTCOME_TYPES.CONVERSION_AFTER] || 0,
      dismissalRate: rates[OUTCOME_TYPES.DISMISSED] || 0,
      ignoreRate: rates[OUTCOME_TYPES.IGNORED] || 0,
      cartAddRate: rates[OUTCOME_TYPES.ADD_TO_CART_AFTER] || 0,
      checkoutRate: rates[OUTCOME_TYPES.CHECKOUT_AFTER] || 0,
      cartRecoveryRate: rates[OUTCOME_TYPES.CART_RECOVERY] || 0,
    };
  }

  /**
   * Get all completed outcomes for a session, formatted for the learning store.
   * @param {string} sessionId
   * @returns {Array}
   */
  getOutcomesForLearning(sessionId) {
    return this._completedOutcomes
      .filter(r => r.sessionId === sessionId)
      .map(r => ({
        decisionId: r.decisionId,
        exposureId: r.exposureId,
        messageId: r.messageId,
        family: r.family,
        subtype: r.subtype,
        context: r.context,
        productId: r.productId,
        intentStateAtExposure: r.intentStateAtExposure,
        funnelStageAtExposure: r.funnelStageAtExposure,
        hesitationScoreAtExposure: r.hesitationScoreAtExposure,
        primaryOutcome: r.primaryOutcome,
        attributed: r.attributed,
        deltaMs: r.closedAt != null ? r.closedAt - r.exposedAt : null,
        outcomes: r.outcomes.slice(),
      }));
  }

  /**
   * Check if a message is currently active for a session.
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasActiveExposure(sessionId) {
    for (const record of this._activeExposures.values()) {
      if (record.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Get active exposures for a session (for overlap/duplication checks).
   * @param {string} sessionId
   * @returns {Array}
   */
  getActiveExposures(sessionId) {
    const result = [];
    for (const record of this._activeExposures.values()) {
      if (record.sessionId === sessionId) {
        result.push({ ...record });
      }
    }
    return result;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Remove completed outcomes older than retentionMs and expire stale actives.
   * @param {number} nowMs
   */
  cleanup(nowMs) {
    _assertFiniteNumber(nowMs, 'cleanup.nowMs');
    const cutoff = nowMs - this._config.retentionMs;

    // Purge old completed outcomes
    let i = 0;
    while (i < this._completedOutcomes.length && this._completedOutcomes[i].exposedAt < cutoff) {
      i++;
    }
    if (i > 0) this._completedOutcomes.splice(0, i);

    // Expire stale active exposures past the attribution window
    const staleIds = [];
    for (const [id, record] of this._activeExposures.entries()) {
      if ((nowMs - record.exposedAt) > this._config.attributionWindowMs) {
        staleIds.push(id);
      }
    }
    for (const id of staleIds) {
      this._closeExposure(id, OUTCOME_TYPES.IGNORED, nowMs);
    }
  }

  dispose() {
    this._disposed = true;
    this._activeExposures.clear();
    this._completedOutcomes.length = 0;
    if (this._messageIndex) this._messageIndex.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type: 'InterventionOutcomeTracker',
      __version: SCHEMA_VERSION,
      seq: this._seq,
      activeExposures: Array.from(this._activeExposures.entries()).map(([k, v]) => [k, { ...v }]),
      completedOutcomes: this._completedOutcomes.map(r => ({ ...r })),
      messageIndex: this._messageIndex ? Array.from(this._messageIndex.entries()) : [],
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'InterventionOutcomeTracker') return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;

    this._activeExposures = new Map();
    if (Array.isArray(snap.activeExposures)) {
      for (const [k, v] of snap.activeExposures) {
        this._activeExposures.set(k, { ...v });
      }
    }

    this._completedOutcomes = Array.isArray(snap.completedOutcomes)
      ? snap.completedOutcomes.map(r => ({ ...r }))
      : [];

    this._messageIndex = new Map();
    if (Array.isArray(snap.messageIndex)) {
      for (const [k, v] of snap.messageIndex) {
        this._messageIndex.set(k, v);
      }
    }

    return true;
  }

  /**
   * Returns a session-level conversion snapshot suitable for ITT analysis.
   *
   * Called by statistical-validity-engine (via experiment-engine) — READ ONLY.
   * Does NOT modify any state.
   *
   * @param {string[]} sessionIds  Sessions to aggregate (e.g. all A or all B sessions)
   * @returns {{
   *   exposedCount:    number,   // sessions that had at least 1 active exposure
   *   convertedCount:  number,   // sessions with a conversion outcome
   *   revenueBySession: object,  // sessionId → total attributed revenue delta
   *   outcomesBySession: object, // sessionId → primaryOutcome
   * }}
   */
  getConversionSnapshot(sessionIds) {
    if (!Array.isArray(sessionIds)) {
      throw new TypeError('InterventionOutcomeTracker.getConversionSnapshot: sessionIds must be an array');
    }

    const idSet = new Set(sessionIds);
    let exposedCount   = 0;
    let convertedCount = 0;
    const revenueBySession  = {};
    const outcomesBySession = {};

    for (const record of this._completedOutcomes) {
      if (!idSet.has(record.sessionId)) continue;

      // Exposure: any completed record means the session was exposed
      if (!revenueBySession.hasOwnProperty(record.sessionId)) {
        exposedCount++;
        revenueBySession[record.sessionId]  = 0;
        outcomesBySession[record.sessionId] = record.primaryOutcome;
      }

      // Revenue delta
      if (
        record.attributed &&
        record.delta &&
        typeof record.delta.revenueDelta === 'number' &&
        record.delta.revenueDelta > 0
      ) {
        revenueBySession[record.sessionId] += record.delta.revenueDelta;
      }

      // Conversion: upgrade outcome if higher priority
      const existing = outcomesBySession[record.sessionId];
      if (_outcomePriority(record.primaryOutcome) > _outcomePriority(existing)) {
        outcomesBySession[record.sessionId] = record.primaryOutcome;
      }
    }

    // Count converted: sessions that reached checkout_after or conversion_after
    const CONVERSION_OUTCOMES = new Set([
      OUTCOME_TYPES.CHECKOUT_AFTER,
      OUTCOME_TYPES.CONVERSION_AFTER,
      OUTCOME_TYPES.ADD_TO_CART_AFTER,
    ]);
    for (const outcome of Object.values(outcomesBySession)) {
      if (CONVERSION_OUTCOMES.has(outcome)) convertedCount++;
    }

    return Object.freeze({
      exposedCount,
      convertedCount,
      revenueBySession: Object.freeze({ ...revenueBySession }),
      outcomesBySession: Object.freeze({ ...outcomesBySession }),
    });
  }

  getDiagnostics() {
    return {
      activeExposures: this._activeExposures.size,
      completedOutcomes: this._completedOutcomes.length,
      maxOutcomes: this._config.maxOutcomes,
      seq: this._seq,
      disposed: this._disposed,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Outcome priority for primary outcome selection (higher = more significant) */
function _outcomePriority(outcomeType) {
  const priorities = {
    [OUTCOME_TYPES.CONVERSION_AFTER]:       100,
    [OUTCOME_TYPES.CHECKOUT_AFTER]:          90,
    [OUTCOME_TYPES.ADD_TO_CART_AFTER]:       80,
    [OUTCOME_TYPES.CART_RECOVERY]:           75,
    [OUTCOME_TYPES.FUNNEL_ADVANCED]:         60,
    [OUTCOME_TYPES.INTENT_ESCALATED]:        55,
    [OUTCOME_TYPES.HESITATION_REDUCED]:      50,
    [OUTCOME_TYPES.REVISIT_AFTER]:           40,
    [OUTCOME_TYPES.HOVER_AFTER]:             35,
    [OUTCOME_TYPES.CLICKED]:                 30,
    [OUTCOME_TYPES.SHOWN]:                   10,
    [OUTCOME_TYPES.DISMISSED]:                5,
    [OUTCOME_TYPES.IGNORED]:                  1,
    [OUTCOME_TYPES.REMOVE_FROM_CART_AFTER]:   2,
  };
  return priorities[outcomeType] || 0;
}

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`InterventionOutcomeTracker: \`${label}\` must be a finite number, got ${val}`);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  InterventionOutcomeTracker,
  OUTCOME_TYPES,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
  DEFAULT_ATTRIBUTION_WINDOW_MS,
};
