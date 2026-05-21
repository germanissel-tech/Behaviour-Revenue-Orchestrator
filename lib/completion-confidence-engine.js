/**
 * completion-confidence-engine.js
 *
 * COMPLETION CONFIDENCE COMPUTATION — Determines intervention confidence score.
 *
 * This engine computes a completionConfidence score (0-1) that must exceed
 * the threshold (0.85) before any automatic intervention is allowed.
 *
 * Factors considered:
 *   - relationshipStrength: How strongly the products are related
 *   - historicalPurchasePattern: How often users buy these together
 *   - productCategoryConfidence: How confident we are about the categories
 *   - previousDismissals: User's history of dismissing similar suggestions
 *   - cartContext: What's already in the cart
 *   - missingComponentLikelihood: Probability the user actually needs this
 *
 * Integration with OPE:
 *   - Deterministic: NO Date.now(), NO Math.random()
 *   - Replay-safe: snapshot/restore for session-simulator-runner
 *   - Bounded memory: LRU eviction on all stores
 *   - Returns SIGNALS only (does not make intervention decisions)
 */

'use strict';

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = Object.freeze({
  // Threshold for allowing automatic intervention
  confidenceThreshold: 0.85,

  // Weight factors for each signal
  // These are MULTIPLIED by the signal value (0-1), so max contribution = weight
  // Total positive weights = 1.0, dismissalPenalty is subtracted from total
  weights: Object.freeze({
    relationshipStrength:       0.30,  // Primary signal
    historicalPurchasePattern:  0.25,  // Strong secondary
    productCategoryConfidence:  0.15,
    cartContext:                0.15,
    missingComponentLikelihood: 0.15,
    dismissalPenalty:           0.10, // Subtractive penalty (per dismissal)
  }),

  // Dismissal decay (how much each dismissal reduces confidence)
  dismissalDecayFactor: 0.10,

  // Maximum dismissals before permanently suppressing
  maxDismissalsBeforeBlock: 3,

  // Minimum relationship strength required
  minRelationshipStrength: 0.3,

  // Minimum historical pattern required
  minHistoricalPattern: 0.2,

  // History capacity for bounded memory
  historyCapacity: 256,
});

// ============================================================================
// LRU MAP (for bounded memory)
// ============================================================================

class LRUMap {
  constructor(maxSize) {
    this._max = Math.max(1, maxSize | 0);
    this._map = new Map();
  }

  get size() { return this._map.size; }

  has(key) { return this._map.has(key); }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }

  peek(key) { return this._map.get(key); }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }

  toObject() {
    const obj = {};
    for (const [k, v] of this._map.entries()) obj[k] = v;
    return obj;
  }

  loadFromObject(obj) {
    this._map.clear();
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      this.set(k, obj[k]);
    }
  }
}

// ============================================================================
// COMPLETION CONFIDENCE ENGINE
// ============================================================================

class CompletionConfidenceEngine {
  /**
   * @param {object} [config] - Override default configuration
   */
  constructor(config = {}) {
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    // Validate positive weights sum to 1.0 (dismissalPenalty is separate)
    const positiveWeights = 
      this.config.weights.relationshipStrength +
      this.config.weights.historicalPurchasePattern +
      this.config.weights.productCategoryConfidence +
      this.config.weights.cartContext +
      this.config.weights.missingComponentLikelihood;
    
    if (Math.abs(positiveWeights - 1.0) > 0.01) {
      throw new Error(`CompletionConfidenceEngine: positive weights must sum to 1.0 (got ${positiveWeights})`);
    }

    // Stores for computed confidences and evaluation history
    this._confidenceCache = new LRUMap(this.config.historyCapacity);
    this._evaluationHistory = [];
    this._version = 1;
    this._disposed = false;
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Computes the completion confidence for a product relationship.
   *
   * @param {object} params
   * @param {string} params.triggerProductId - Product that triggered the evaluation
   * @param {string} params.suggestedProductId - Product being suggested
   * @param {string} params.relationshipType - Type of relationship
   * @param {object} params.signals - Input signals for computation
   * @param {number} params.signals.relationshipStrength - 0-1 strength of relationship
   * @param {number} params.signals.historicalPurchasePattern - 0-1 co-purchase frequency
   * @param {number} params.signals.productCategoryConfidence - 0-1 category classification confidence
   * @param {number} params.signals.cartContextScore - 0-1 how well this fits current cart
   * @param {number} params.signals.missingComponentLikelihood - 0-1 likelihood user needs this
   * @param {number} params.dismissalCount - Number of times user dismissed similar
   * @param {number} params.nowMs - Current timestamp (for determinism)
   * @returns {{ confidence: number, meetsThreshold: boolean, breakdown: object, rationale: string[] }}
   */
  computeConfidence(params) {
    this._assertAlive();
    const { triggerProductId, suggestedProductId, signals, dismissalCount, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('CompletionConfidenceEngine: nowMs must be a finite number');
    }

    const breakdown = {};
    const rationale = [];
    const w = this.config.weights;

    // 1. Relationship strength
    const rs = this._clamp(signals?.relationshipStrength ?? 0, 0, 1);
    breakdown.relationshipStrength = rs * w.relationshipStrength;
    if (rs < this.config.minRelationshipStrength) {
      rationale.push(`relationship_strength_too_low:${rs.toFixed(2)}`);
    }

    // 2. Historical purchase pattern
    const hp = this._clamp(signals?.historicalPurchasePattern ?? 0, 0, 1);
    breakdown.historicalPurchasePattern = hp * w.historicalPurchasePattern;
    if (hp < this.config.minHistoricalPattern) {
      rationale.push(`historical_pattern_too_low:${hp.toFixed(2)}`);
    }

    // 3. Product category confidence
    const pcc = this._clamp(signals?.productCategoryConfidence ?? 0.5, 0, 1);
    breakdown.productCategoryConfidence = pcc * w.productCategoryConfidence;

    // 4. Cart context
    const cc = this._clamp(signals?.cartContextScore ?? 0.5, 0, 1);
    breakdown.cartContext = cc * w.cartContext;

    // 5. Missing component likelihood
    const mcl = this._clamp(signals?.missingComponentLikelihood ?? 0.5, 0, 1);
    breakdown.missingComponentLikelihood = mcl * w.missingComponentLikelihood;

    // 6. Dismissal penalty (subtractive)
    const dismissals = Math.max(0, dismissalCount || 0);
    const dismissalPenalty = Math.min(
      dismissals * this.config.dismissalDecayFactor,
      w.dismissalPenalty // Cap at the weight
    );
    breakdown.dismissalPenalty = -dismissalPenalty;

    if (dismissals >= this.config.maxDismissalsBeforeBlock) {
      rationale.push(`max_dismissals_reached:${dismissals}`);
    } else if (dismissals > 0) {
      rationale.push(`dismissal_penalty_applied:${dismissals}`);
    }

    // Compute total confidence
    const rawConfidence =
      breakdown.relationshipStrength +
      breakdown.historicalPurchasePattern +
      breakdown.productCategoryConfidence +
      breakdown.cartContext +
      breakdown.missingComponentLikelihood +
      breakdown.dismissalPenalty;

    const confidence = this._clamp(rawConfidence, 0, 1);
    const meetsThreshold = confidence >= this.config.confidenceThreshold;

    if (!meetsThreshold) {
      rationale.push(`confidence_below_threshold:${confidence.toFixed(3)}<${this.config.confidenceThreshold}`);
    }

    // Cache result
    const cacheKey = `${triggerProductId}:${suggestedProductId}`;
    this._confidenceCache.set(cacheKey, { confidence, timestamp: nowMs });

    // Record in history (bounded)
    this._recordEvaluation({
      triggerProductId,
      suggestedProductId,
      confidence,
      meetsThreshold,
      nowMs,
    });

    this._version++;

    return {
      confidence,
      meetsThreshold,
      breakdown,
      rationale,
      threshold: this.config.confidenceThreshold,
    };
  }

  /**
   * Quick check if a relationship has been evaluated and meets threshold.
   */
  checkCachedConfidence(triggerProductId, suggestedProductId) {
    const cacheKey = `${triggerProductId}:${suggestedProductId}`;
    const cached = this._confidenceCache.peek(cacheKey);
    if (!cached) return { found: false };
    return {
      found: true,
      confidence: cached.confidence,
      meetsThreshold: cached.confidence >= this.config.confidenceThreshold,
      cachedAt: cached.timestamp,
    };
  }

  /**
   * Invalidates cached confidence for a relationship.
   */
  invalidateCache(triggerProductId, suggestedProductId) {
    const cacheKey = `${triggerProductId}:${suggestedProductId}`;
    this._confidenceCache.delete(cacheKey);
  }

  // =========================================================================
  // SNAPSHOT / RESTORE (for deterministic replay)
  // =========================================================================

  snapshot() {
    return {
      __type: 'CompletionConfidenceEngine',
      __version: 1,
      confidenceCache: this._confidenceCache.toObject(),
      evaluationHistory: this._evaluationHistory.slice(-100), // Bounded
      version: this._version,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'CompletionConfidenceEngine') return;
    if (snap.__version !== 1) return;

    this._confidenceCache.loadFromObject(snap.confidenceCache || {});
    this._evaluationHistory = Array.isArray(snap.evaluationHistory)
      ? snap.evaluationHistory.slice()
      : [];
    this._version = snap.version || 1;
  }

  // =========================================================================
  // DIAGNOSTICS
  // =========================================================================

  getDiagnostics() {
    return {
      cacheSize: this._confidenceCache.size,
      evaluationCount: this._evaluationHistory.length,
      version: this._version,
      threshold: this.config.confidenceThreshold,
      disposed: this._disposed,
    };
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  reset() {
    this._confidenceCache.clear();
    this._evaluationHistory.length = 0;
    this._version = 1;
  }

  dispose() {
    if (this._disposed) return;
    this._confidenceCache.clear();
    this._evaluationHistory.length = 0;
    this._disposed = true;
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  _assertAlive() {
    if (this._disposed) {
      throw new Error('CompletionConfidenceEngine: instance has been disposed');
    }
  }

  _clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  _recordEvaluation(entry) {
    this._evaluationHistory.push(entry);
    // Bounded: keep last N entries
    while (this._evaluationHistory.length > this.config.historyCapacity) {
      this._evaluationHistory.shift();
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  CompletionConfidenceEngine,
  DEFAULT_CONFIG,
};
