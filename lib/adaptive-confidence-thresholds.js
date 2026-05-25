'use strict';

/**
 * adaptive-confidence-thresholds.js (PHASE 3)
 *
 * ADAPTIVE CONFIDENCE THRESHOLDS — Dynamic threshold computation.
 *
 * This module replaces fixed completionConfidence thresholds with
 * dynamic thresholds based on:
 *   - Category (food=0.85, pharmacy=0.97, etc.)
 *   - Relationship type (required vs optional)
 *   - Historical reliability
 *   - Confidence variance
 *
 * Design guarantees:
 *   - NO Date.now() — all timestamps from injected nowMs
 *   - NO external APIs, no LLMs
 *   - Fully deterministic, replay-safe
 *   - Bounded memory via LRU cache
 *
 * Authority: THRESHOLD COMPUTATION only. Does NOT decide.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE = 'AdaptiveConfidenceThresholds';

// ============================================================================
// BASE THRESHOLDS BY CATEGORY
// Higher values = more conservative (fewer interventions)
// ============================================================================

const CATEGORY_BASE_THRESHOLDS = Object.freeze({
  // ALLOWED for automatic intervention (food/grocery/delivery)
  food: 0.85,
  grocery: 0.92,
  delivery: 0.88,

  // NOT allowed for automatic intervention (much higher thresholds)
  pharmacy: 0.97,
  health: 0.96,
  baby: 0.97,
  electronics: 0.95,
  fashion: 0.94,
  beauty: 0.93,
  gaming: 0.94,
  photography: 0.95,
  computing: 0.95,
  audio: 0.93,
  home: 0.92,
  pets: 0.91,

  // Fallback
  unknown: 0.95,
});

// ============================================================================
// RELATIONSHIP TYPE MODIFIERS
// Applied to base threshold
// ============================================================================

const RELATIONSHIP_TYPE_MODIFIERS = Object.freeze({
  // Required components (lower threshold = more likely to intervene)
  REQUIRED_COMPONENT: -0.03,      // e.g., camera needs SD card
  PREPARATION_COMPONENT: -0.02,  // e.g., pasta needs sauce

  // Optional components (higher threshold = less likely to intervene)
  STYLE_MATCH: 0.05,             // e.g., shirt + pants
  COMPLEMENTARY: 0.02,           // e.g., wine + cheese
  ENHANCEMENT: 0.04,             // e.g., tripod for camera

  // Forbidden (extremely high threshold - effectively blocked)
  CROSS_SELL: 0.15,              // Never assume intent
  UPSELL: 0.15,                  // Never assume intent

  // Default
  UNKNOWN: 0.05,
});

// ============================================================================
// RELIABILITY ADJUSTMENT FACTORS
// Based on historical accuracy
// ============================================================================

const RELIABILITY_BANDS = Object.freeze({
  excellent: { minReliability: 0.90, adjustment: -0.05 },
  good: { minReliability: 0.75, adjustment: -0.02 },
  neutral: { minReliability: 0.50, adjustment: 0 },
  poor: { minReliability: 0.25, adjustment: 0.05 },
  very_poor: { minReliability: 0, adjustment: 0.10 },
});

// ============================================================================
// VARIANCE ADJUSTMENT
// Higher variance = higher threshold (more uncertainty)
// ============================================================================

const VARIANCE_MULTIPLIER = 0.15; // max adjustment from variance

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = Object.freeze({
  // Minimum threshold (never go below this)
  absoluteMinThreshold: 0.70,

  // Maximum threshold (never go above this)
  absoluteMaxThreshold: 0.99,

  // Cache TTL
  cacheTtlMs: 5 * 60 * 1000, // 5 minutes

  // Max cache entries
  maxCacheEntries: 500,
});

// ============================================================================
// LRU Map for bounded cache
// ============================================================================

class LRUMap {
  constructor(cap) {
    this._cap = cap;
    this._map = new Map();
  }
  get size() { return this._map.size; }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this._cap) {
      this._map.delete(this._map.keys().next().value);
    }
  }
  has(key) { return this._map.has(key); }
  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }
}

// ============================================================================
// AdaptiveConfidenceThresholds
// ============================================================================

class AdaptiveConfidenceThresholds {
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._cache = new LRUMap(this._config.maxCacheEntries);
    this._computedCount = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API: getDynamicThreshold
  // ==========================================================================

  /**
   * Computes a dynamic confidence threshold based on multiple factors.
   *
   * @param {object} params
   * @param {string} params.category - Product category
   * @param {string} params.relationshipType - Type of relationship
   * @param {number} [params.historicalReliability] - 0-1, how reliable past predictions were
   * @param {number} [params.confidenceVariance] - 0-1, variance in confidence scores
   * @param {number} params.nowMs - Current timestamp
   * @returns {ThresholdResult}
   *
   * ThresholdResult: {
   *   threshold: number (0-1),
   *   baseThreshold: number,
   *   adjustments: object,
   *   rationale: string[],
   *   allowsAutomaticIntervention: boolean,
   * }
   */
  getDynamicThreshold(params) {
    this._assertAlive();
    const { category, relationshipType, historicalReliability, confidenceVariance, nowMs } = params;

    this._assertFiniteNumber(nowMs, 'getDynamicThreshold.nowMs');

    // Build cache key
    const cacheKey = this._buildCacheKey(params);
    const cached = this._cache.get(cacheKey);
    if (cached && (nowMs - cached.computedAt) < this._config.cacheTtlMs) {
      return cached.result;
    }

    // Step 1: Get base threshold for category
    const normalizedCategory = this._normalizeCategory(category);
    const baseThreshold = CATEGORY_BASE_THRESHOLDS[normalizedCategory] || CATEGORY_BASE_THRESHOLDS.unknown;

    // Step 2: Apply relationship type modifier
    const relationshipModifier = this._getRelationshipModifier(relationshipType);

    // Step 3: Apply reliability adjustment
    const reliabilityAdjustment = this._getReliabilityAdjustment(historicalReliability);

    // Step 4: Apply variance adjustment
    const varianceAdjustment = this._getVarianceAdjustment(confidenceVariance);

    // Compute final threshold
    let threshold = baseThreshold + relationshipModifier + reliabilityAdjustment + varianceAdjustment;

    // Clamp to bounds
    threshold = Math.max(this._config.absoluteMinThreshold, Math.min(this._config.absoluteMaxThreshold, threshold));
    threshold = Math.round(threshold * 1000) / 1000;

    // Determine if automatic intervention is allowed
    const allowsAutomaticIntervention = this._allowsAutomaticIntervention(normalizedCategory, relationshipType);

    const rationale = [];
    rationale.push(`base:${baseThreshold.toFixed(2)}`);
    if (relationshipModifier !== 0) {
      rationale.push(`relationship_modifier:${relationshipModifier >= 0 ? '+' : ''}${relationshipModifier.toFixed(2)}`);
    }
    if (reliabilityAdjustment !== 0) {
      rationale.push(`reliability_adjustment:${reliabilityAdjustment >= 0 ? '+' : ''}${reliabilityAdjustment.toFixed(2)}`);
    }
    if (varianceAdjustment !== 0) {
      rationale.push(`variance_adjustment:${varianceAdjustment >= 0 ? '+' : ''}${varianceAdjustment.toFixed(2)}`);
    }
    rationale.push(`final:${threshold.toFixed(3)}`);

    if (!allowsAutomaticIntervention) {
      rationale.push('automatic_intervention:blocked');
    }

    const result = Object.freeze({
      threshold,
      baseThreshold,
      adjustments: Object.freeze({
        relationshipModifier,
        reliabilityAdjustment,
        varianceAdjustment,
      }),
      rationale: Object.freeze(rationale),
      allowsAutomaticIntervention,
    });

    // Cache result
    this._cache.set(cacheKey, { result, computedAt: nowMs });
    this._computedCount++;

    return result;
  }

  /**
   * Get threshold for a specific category (simple lookup).
   *
   * @param {string} category
   * @returns {number}
   */
  getBaseThresholdForCategory(category) {
    const normalized = this._normalizeCategory(category);
    return CATEGORY_BASE_THRESHOLDS[normalized] || CATEGORY_BASE_THRESHOLDS.unknown;
  }

  /**
   * Check if a category allows automatic interventions.
   *
   * @param {string} category
   * @returns {boolean}
   */
  categoryAllowsAutomaticIntervention(category) {
    const normalized = this._normalizeCategory(category);
    return ['food', 'grocery', 'delivery'].includes(normalized);
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  _buildCacheKey(params) {
    const cat = params.category || 'unknown';
    const rel = params.relationshipType || 'unknown';
    const reliab = typeof params.historicalReliability === 'number'
      ? Math.round(params.historicalReliability * 10)
      : 'null';
    const variance = typeof params.confidenceVariance === 'number'
      ? Math.round(params.confidenceVariance * 10)
      : 'null';
    return `${cat}:${rel}:${reliab}:${variance}`;
  }

  _normalizeCategory(category) {
    if (!category || typeof category !== 'string') return 'unknown';

    const lower = category.toLowerCase().trim();

    // Map common variations
    const mapping = {
      'food': 'food',
      'comida': 'food',
      'alimentos': 'food',
      'grocery': 'grocery',
      'groceries': 'grocery',
      'supermercado': 'grocery',
      'delivery': 'delivery',
      'envío': 'delivery',
      'pharmacy': 'pharmacy',
      'farmacia': 'pharmacy',
      'health': 'health',
      'salud': 'health',
      'baby': 'baby',
      'bebé': 'baby',
      'electronics': 'electronics',
      'electrónica': 'electronics',
      'fashion': 'fashion',
      'moda': 'fashion',
      'beauty': 'beauty',
      'belleza': 'beauty',
      'gaming': 'gaming',
      'photography': 'photography',
      'computing': 'computing',
      'audio': 'audio',
      'home': 'home',
      'hogar': 'home',
      'pets': 'pets',
      'mascotas': 'pets',
    };

    return mapping[lower] || 'unknown';
  }

  _getRelationshipModifier(relationshipType) {
    if (!relationshipType || typeof relationshipType !== 'string') {
      return RELATIONSHIP_TYPE_MODIFIERS.UNKNOWN;
    }

    const upper = relationshipType.toUpperCase();
    return RELATIONSHIP_TYPE_MODIFIERS[upper] !== undefined
      ? RELATIONSHIP_TYPE_MODIFIERS[upper]
      : RELATIONSHIP_TYPE_MODIFIERS.UNKNOWN;
  }

  _getReliabilityAdjustment(reliability) {
    if (typeof reliability !== 'number' || !Number.isFinite(reliability)) {
      return 0; // No adjustment if no data
    }

    const clamped = Math.max(0, Math.min(1, reliability));

    for (const [, band] of Object.entries(RELIABILITY_BANDS)) {
      if (clamped >= band.minReliability) {
        return band.adjustment;
      }
    }

    return 0;
  }

  _getVarianceAdjustment(variance) {
    if (typeof variance !== 'number' || !Number.isFinite(variance)) {
      return 0; // No adjustment if no data
    }

    const clamped = Math.max(0, Math.min(1, variance));
    return clamped * VARIANCE_MULTIPLIER;
  }

  _allowsAutomaticIntervention(normalizedCategory, relationshipType) {
    // Only food/grocery/delivery categories
    if (!['food', 'grocery', 'delivery'].includes(normalizedCategory)) {
      return false;
    }

    // Only REQUIRED_COMPONENT and PREPARATION_COMPONENT relationships
    if (relationshipType) {
      const upper = relationshipType.toUpperCase();
      if (!['REQUIRED_COMPONENT', 'PREPARATION_COMPONENT'].includes(upper)) {
        return false;
      }
    }

    return true;
  }

  _assertAlive() {
    if (this._disposed) {
      throw new Error('AdaptiveConfidenceThresholds: instance has been disposed');
    }
  }

  _assertFiniteNumber(val, label) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new TypeError(`AdaptiveConfidenceThresholds: ${label} must be a finite number, got ${val}`);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // No time-based cleanup needed, LRU handles bounds
  }

  dispose() {
    this._disposed = true;
    this._cache.clear();
  }

  reset() {
    this._cache.clear();
    this._computedCount = 0;
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type: SCHEMA_TYPE,
      __version: SCHEMA_VERSION,
      computedCount: this._computedCount,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._computedCount = typeof snap.computedCount === 'number' ? snap.computedCount : 0;
    this._cache.clear();
    return true;
  }

  getDiagnostics() {
    return {
      cacheSize: this._cache.size,
      maxCacheEntries: this._config.maxCacheEntries,
      computedCount: this._computedCount,
      disposed: this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  AdaptiveConfidenceThresholds,
  CATEGORY_BASE_THRESHOLDS,
  RELATIONSHIP_TYPE_MODIFIERS,
  RELIABILITY_BANDS,
  VARIANCE_MULTIPLIER,
};
