'use strict';

/**
 * intervention-learning-store.js
 *
 * Deterministic, replay-safe learning infrastructure for the OPE system.
 * Persists what works and what doesn't — by category, intent state, funnel
 * stage, revisit depth, product archetype, hesitation pattern, and cart pattern.
 *
 * What this IS:
 *  - A statistical accumulator: success rates, ignore rates, conversion lifts.
 *  - Deterministic: same sequence of outcomes -> same statistics.
 *  - Bounded: every bucket is capped. No unbounded growth.
 *  - Replay-safe: snapshot() / restore() for full determinism.
 *
 * What this IS NOT:
 *  - ML model — no gradient descent, no neural nets, no embeddings.
 *  - Decision engine — does NOT produce rankings or approve interventions.
 *  - Heuristic engine — does NOT encode business rules.
 *
 * Integration:
 *  - Fed by intervention-outcome-tracker.getOutcomesForLearning().
 *  - Called by session-orchestrator after each session closes.
 *  - Read by message-ranking-engine for score calibration (optional, future).
 *  - Read by decision-explainability-engine for context enrichment.
 *
 * Authority: LEARN only. Observes, accumulates, surfaces insights.
 * Does NOT decide. Does NOT rank. Does NOT approve.
 *
 * Design guarantees:
 *  - NO Date.now()  — all timestamps from injected nowMs.
 *  - NO Math.random() — fully deterministic.
 *  - Bounded memory — every bucket has maxObservations cap.
 *  - snapshot() / restore() — replay-safe.
 *  - cleanup(nowMs) — purges stale observation records.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

/**
 * Bucket dimensions — every observation is indexed along these axes.
 * A bucket key is formed as: `${family}::${dimension}::${value}`.
 */
const BUCKET_DIMENSIONS = Object.freeze([
  'by_family',            // message family only
  'by_category',          // product category
  'by_intent_state',      // intent state at exposure
  'by_funnel_stage',      // funnel stage at exposure
  'by_revisit_depth',     // revisit count (0=first, 1=second, 2=three+)
  'by_hesitation_level',  // none | low | medium | high
  'by_cart_pattern',      // empty | single | multi | hesitating
]);

/** Successful outcome types (contribute to success rate) */
const SUCCESS_OUTCOMES = new Set([
  'add_to_cart_after',
  'checkout_after',
  'conversion_after',
  'funnel_advanced',
  'intent_escalated',
  'hesitation_reduced',
  'cart_recovery',
]);

/** Negative outcome types (contribute to ignore/failure rate) */
const FAILURE_OUTCOMES = new Set([
  'ignored',
  'dismissed',
  'remove_from_cart_after',
]);

const DEFAULT_CONFIG = Object.freeze({
  // Max observations per bucket before oldest are evicted
  maxObservationsPerBucket: 1000,
  // Max total buckets (prevents unbounded key explosion)
  maxBuckets: 512,
  // Min observations before a bucket's statistics are considered reliable
  minObservationsForReliability: 10,
  // Retention: how long individual observation records are kept
  retentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  // Bucket eviction: when maxBuckets is exceeded, LRU eviction
  evictionPolicy: 'lru',
});

// ============================================================================
// InterventionLearningStore
// ============================================================================

class InterventionLearningStore {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    /**
     * Bucket store: bucketKey -> BucketStats
     * @type {Map<string, BucketStats>}
     */
    this._buckets = new Map();

    /**
     * LRU access order for bucket eviction.
     * @type {Map<string, number>}  bucketKey -> lastAccessSeq
     */
    this._bucketAccessSeq = new Map();
    this._globalAccessSeq = 0;

    this._seq = 0;
    this._totalObservations = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API — ingest outcomes from intervention-outcome-tracker
  // ==========================================================================

  /**
   * Ingest a batch of outcomes from a closed session.
   * Called by session-orchestrator after each session or periodically.
   *
   * @param {Array} outcomes — from InterventionOutcomeTracker.getOutcomesForLearning()
   * @param {object} [sessionMeta]
   * @param {string} [sessionMeta.productCategory]  — e.g. 'fashion', 'tech'
   * @param {string} [sessionMeta.productArchetype] — e.g. 'high_ticket', 'impulse'
   * @param {number} nowMs
   */
  ingestOutcomes(outcomes, sessionMeta, nowMs) {
    _assertFiniteNumber(nowMs, 'ingestOutcomes.nowMs');
    if (!Array.isArray(outcomes) || outcomes.length === 0) return;
    if (this._disposed) return;

    for (const outcome of outcomes) {
      this._ingestOne(outcome, sessionMeta || {}, nowMs);
    }
  }

  /**
   * Ingest a single outcome record.
   * @private
   */
  _ingestOne(outcome, sessionMeta, nowMs) {
    if (!outcome || !outcome.family || !outcome.primaryOutcome) return;

    this._seq++;
    this._totalObservations++;

    const isSuccess = SUCCESS_OUTCOMES.has(outcome.primaryOutcome);
    const isFailure = FAILURE_OUTCOMES.has(outcome.primaryOutcome);
    const isConversion = outcome.primaryOutcome === 'conversion_after' || outcome.primaryOutcome === 'checkout_after';
    const isCartAdd = outcome.primaryOutcome === 'add_to_cart_after';
    const isDismissed = outcome.primaryOutcome === 'dismissed';
    const isIgnored = outcome.primaryOutcome === 'ignored';

    // Compute normalized bucket keys for each dimension
    const dimensionValues = {
      by_family:         outcome.family,
      by_category:       sessionMeta.productCategory || 'general',
      by_intent_state:   outcome.intentStateAtExposure || 'unknown',
      by_funnel_stage:   outcome.funnelStageAtExposure || 'unknown',
      by_revisit_depth:  _normalizeRevisitDepth(outcome.revisitCount),
      by_hesitation_level: _normalizeHesitationLevel(outcome.hesitationScoreAtExposure),
      by_cart_pattern:   sessionMeta.cartPattern || 'unknown',
    };

    const observation = {
      seq: this._seq,
      nowMs,
      family: outcome.family,
      subtype: outcome.subtype || null,
      primaryOutcome: outcome.primaryOutcome,
      isSuccess,
      isFailure,
      isConversion,
      isCartAdd,
      isDismissed,
      isIgnored,
      deltaMs: outcome.deltaMs || null,
    };

    // Update all bucket dimensions
    for (const [dimension, value] of Object.entries(dimensionValues)) {
      const bucketKey = `${outcome.family}::${dimension}::${value}`;
      this._updateBucket(bucketKey, observation, nowMs);
    }

    // Also update the cross-dimensional bucket: family x intent_state x funnel_stage
    // This is the highest-signal bucket for future ML feature extraction
    const crossKey = `${outcome.family}::cross::${dimensionValues.by_intent_state}::${dimensionValues.by_funnel_stage}`;
    this._updateBucket(crossKey, observation, nowMs);
  }

  /**
   * Update or create a bucket with a new observation.
   * @private
   */
  _updateBucket(bucketKey, observation, nowMs) {
    // Evict if at capacity and bucket is new
    if (!this._buckets.has(bucketKey) && this._buckets.size >= this._config.maxBuckets) {
      this._evictLRUBucket();
    }

    if (!this._buckets.has(bucketKey)) {
      this._buckets.set(bucketKey, new BucketStats(this._config.maxObservationsPerBucket));
    }

    const bucket = this._buckets.get(bucketKey);
    bucket.add(observation);

    // Update LRU access
    this._globalAccessSeq++;
    this._bucketAccessSeq.set(bucketKey, this._globalAccessSeq);
  }

  /** Evict the least-recently-used bucket */
  _evictLRUBucket() {
    let minSeq = Infinity;
    let evictKey = null;
    for (const [key, seq] of this._bucketAccessSeq.entries()) {
      if (seq < minSeq) { minSeq = seq; evictKey = key; }
    }
    if (evictKey) {
      this._buckets.delete(evictKey);
      this._bucketAccessSeq.delete(evictKey);
    }
  }

  // ==========================================================================
  // Query API
  // ==========================================================================

  /**
   * Get aggregated statistics for a specific family.
   * @param {string} family
   * @returns {object}
   */
  getFamilyStats(family) {
    const bucketKey = `${family}::by_family::${family}`;
    const bucket = this._buckets.get(bucketKey);
    if (!bucket) return this._emptyStats(family);
    return this._formatStats(family, bucket);
  }

  /**
   * Get statistics for a family in a specific context.
   * @param {string} family
   * @param {object} context
   * @param {string} [context.intentState]
   * @param {string} [context.funnelStage]
   * @param {string} [context.category]
   * @param {number} [context.revisitCount]
   * @param {number} [context.hesitationScore]
   * @param {string} [context.cartPattern]
   * @returns {object}
   */
  getFamilyStatsForContext(family, context = {}) {
    const results = [];

    if (context.intentState) {
      const key = `${family}::by_intent_state::${context.intentState}`;
      const b = this._buckets.get(key);
      if (b) results.push(this._formatStats(family, b, 'by_intent_state'));
    }
    if (context.funnelStage) {
      const key = `${family}::by_funnel_stage::${context.funnelStage}`;
      const b = this._buckets.get(key);
      if (b) results.push(this._formatStats(family, b, 'by_funnel_stage'));
    }
    if (context.category) {
      const key = `${family}::by_category::${context.category}`;
      const b = this._buckets.get(key);
      if (b) results.push(this._formatStats(family, b, 'by_category'));
    }
    if (typeof context.revisitCount === 'number') {
      const depth = _normalizeRevisitDepth(context.revisitCount);
      const key = `${family}::by_revisit_depth::${depth}`;
      const b = this._buckets.get(key);
      if (b) results.push(this._formatStats(family, b, 'by_revisit_depth'));
    }

    // Cross-dimensional (highest signal when available)
    if (context.intentState && context.funnelStage) {
      const key = `${family}::cross::${context.intentState}::${context.funnelStage}`;
      const b = this._buckets.get(key);
      if (b) results.push(this._formatStats(family, b, 'cross'));
    }

    if (results.length === 0) return this._emptyStats(family);

    // Merge: weight by observation count, return aggregated view
    const reliable = results.filter(r => r.reliable);
    const base = reliable.length > 0 ? reliable : results;
    return this._mergeStats(family, base);
  }

  /**
   * Get all family stats sorted by success rate.
   * @returns {Array<object>}
   */
  getAllFamilyStats() {
    const families = new Set();
    for (const key of this._buckets.keys()) {
      const family = key.split('::')[0];
      families.add(family);
    }

    return Array.from(families)
      .map(f => this.getFamilyStats(f))
      .sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * Get top-performing families for a given context.
   * Returns families ordered by their contextual success rate.
   * Used optionally by message-ranking-engine for score calibration.
   *
   * @param {object} context — same shape as getFamilyStatsForContext
   * @param {string[]} [candidateFamilies] — filter to these families
   * @returns {Array<{ family: string, successRate: number, reliable: boolean }>}
   */
  rankFamiliesForContext(context = {}, candidateFamilies) {
    const families = candidateFamilies || Array.from(new Set(
      Array.from(this._buckets.keys()).map(k => k.split('::')[0])
    ));

    return families
      .map(family => {
        const stats = this.getFamilyStatsForContext(family, context);
        return { family, successRate: stats.successRate, reliable: stats.reliable, observations: stats.total };
      })
      .sort((a, b) => {
        // Reliable stats first, then by success rate
        if (a.reliable && !b.reliable) return -1;
        if (!a.reliable && b.reliable) return 1;
        return b.successRate - a.successRate;
      });
  }

  // ==========================================================================
  // Stats formatting
  // ==========================================================================

  _emptyStats(family, dimension) {
    return {
      family,
      dimension: dimension || 'by_family',
      total: 0,
      successRate: 0,
      ignoreRate: 0,
      dismissalRate: 0,
      conversionRate: 0,
      cartAddRate: 0,
      averageDeltaMs: null,
      reliable: false,
    };
  }

  _formatStats(family, bucket, dimension) {
    const agg = bucket.aggregate();
    const total = agg.total;
    if (total === 0) return this._emptyStats(family, dimension);

    return {
      family,
      dimension: dimension || 'by_family',
      total,
      successRate:    total > 0 ? agg.successes / total : 0,
      ignoreRate:     total > 0 ? agg.ignores / total : 0,
      dismissalRate:  total > 0 ? agg.dismissals / total : 0,
      conversionRate: total > 0 ? agg.conversions / total : 0,
      cartAddRate:    total > 0 ? agg.cartAdds / total : 0,
      averageDeltaMs: agg.totalDeltaMs > 0 && agg.deltaCounted > 0
        ? agg.totalDeltaMs / agg.deltaCounted
        : null,
      reliable: total >= this._config.minObservationsForReliability,
    };
  }

  _mergeStats(family, statsArray) {
    if (!statsArray.length) return this._emptyStats(family);
    if (statsArray.length === 1) return statsArray[0];

    const totalObs = statsArray.reduce((s, r) => s + r.total, 0);
    if (totalObs === 0) return this._emptyStats(family);

    // Weighted average by observation count
    const w = (field) => statsArray.reduce((s, r) => s + r[field] * r.total, 0) / totalObs;

    return {
      family,
      dimension: 'merged',
      total: totalObs,
      successRate:    w('successRate'),
      ignoreRate:     w('ignoreRate'),
      dismissalRate:  w('dismissalRate'),
      conversionRate: w('conversionRate'),
      cartAddRate:    w('cartAddRate'),
      averageDeltaMs: statsArray.some(r => r.averageDeltaMs != null)
        ? statsArray.filter(r => r.averageDeltaMs != null).reduce((s, r) => s + r.averageDeltaMs * r.total, 0) / totalObs
        : null,
      reliable: totalObs >= this._config.minObservationsForReliability,
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Purge observation records older than retentionMs.
   * @param {number} nowMs
   */
  cleanup(nowMs) {
    _assertFiniteNumber(nowMs, 'cleanup.nowMs');
    const cutoff = nowMs - this._config.retentionMs;
    for (const [key, bucket] of this._buckets.entries()) {
      bucket.purgeOlderThan(cutoff);
      if (bucket.total === 0) {
        this._buckets.delete(key);
        this._bucketAccessSeq.delete(key);
      }
    }
  }

  dispose() {
    this._disposed = true;
    this._buckets.clear();
    this._bucketAccessSeq.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    const buckets = [];
    for (const [key, bucket] of this._buckets.entries()) {
      buckets.push([key, bucket.snapshot()]);
    }
    return {
      __type: 'InterventionLearningStore',
      __version: SCHEMA_VERSION,
      seq: this._seq,
      totalObservations: this._totalObservations,
      globalAccessSeq: this._globalAccessSeq,
      buckets,
      bucketAccessSeq: Array.from(this._bucketAccessSeq.entries()),
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'InterventionLearningStore') return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;
    this._totalObservations = typeof snap.totalObservations === 'number' ? snap.totalObservations : 0;
    this._globalAccessSeq = typeof snap.globalAccessSeq === 'number' ? snap.globalAccessSeq : 0;

    this._buckets = new Map();
    if (Array.isArray(snap.buckets)) {
      for (const [key, bucketSnap] of snap.buckets) {
        const bucket = new BucketStats(this._config.maxObservationsPerBucket);
        bucket.restore(bucketSnap);
        this._buckets.set(key, bucket);
      }
    }

    this._bucketAccessSeq = new Map();
    if (Array.isArray(snap.bucketAccessSeq)) {
      for (const [k, v] of snap.bucketAccessSeq) {
        this._bucketAccessSeq.set(k, v);
      }
    }

    return true;
  }

  getDiagnostics() {
    return {
      bucketCount: this._buckets.size,
      maxBuckets: this._config.maxBuckets,
      totalObservations: this._totalObservations,
      seq: this._seq,
      disposed: this._disposed,
    };
  }
}

// ============================================================================
// BucketStats — internal per-bucket accumulator
// ============================================================================

class BucketStats {
  constructor(maxObservations) {
    this._max = maxObservations;
    /** @type {Array<object>} — sliding window of raw observations */
    this._observations = [];
  }

  get total() { return this._observations.length; }

  add(observation) {
    this._observations.push(observation);
    if (this._observations.length > this._max) {
      this._observations.shift(); // evict oldest
    }
  }

  purgeOlderThan(cutoffNowMs) {
    let i = 0;
    while (i < this._observations.length && this._observations[i].nowMs < cutoffNowMs) {
      i++;
    }
    if (i > 0) this._observations.splice(0, i);
  }

  /**
   * Compute aggregate statistics over the current window.
   * @returns {{ total, successes, ignores, dismissals, conversions, cartAdds, totalDeltaMs, deltaCounted }}
   */
  aggregate() {
    let successes = 0, ignores = 0, dismissals = 0, conversions = 0, cartAdds = 0;
    let totalDeltaMs = 0, deltaCounted = 0;

    for (const obs of this._observations) {
      if (obs.isSuccess)    successes++;
      if (obs.isIgnored)    ignores++;
      if (obs.isDismissed)  dismissals++;
      if (obs.isConversion) conversions++;
      if (obs.isCartAdd)    cartAdds++;
      if (typeof obs.deltaMs === 'number' && obs.deltaMs >= 0) {
        totalDeltaMs += obs.deltaMs;
        deltaCounted++;
      }
    }

    return { total: this._observations.length, successes, ignores, dismissals, conversions, cartAdds, totalDeltaMs, deltaCounted };
  }

  snapshot() {
    return { max: this._max, observations: this._observations.slice() };
  }

  restore(snap) {
    if (!snap) return;
    this._max = typeof snap.max === 'number' ? snap.max : this._max;
    this._observations = Array.isArray(snap.observations) ? snap.observations.slice() : [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function _normalizeRevisitDepth(revisitCount) {
  if (typeof revisitCount !== 'number' || revisitCount <= 0) return 'first';
  if (revisitCount === 1) return 'second';
  return 'deep';
}

function _normalizeHesitationLevel(hesitationScore) {
  if (typeof hesitationScore !== 'number') return 'unknown';
  if (hesitationScore <= 0)   return 'none';
  if (hesitationScore < 0.3)  return 'low';
  if (hesitationScore < 0.6)  return 'medium';
  return 'high';
}

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`InterventionLearningStore: \`${label}\` must be a finite number, got ${val}`);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  InterventionLearningStore,
  BucketStats,
  BUCKET_DIMENSIONS,
  SUCCESS_OUTCOMES,
  FAILURE_OUTCOMES,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
};
