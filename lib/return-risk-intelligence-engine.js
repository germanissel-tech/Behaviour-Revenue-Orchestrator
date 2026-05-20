'use strict';

/**
 * return-risk-intelligence-engine.js
 *
 * Detects return risk from incompatibilities, missing accessories,
 * risky combinations, and hesitation signals in the current session.
 *
 * Responsibilities:
 *  - Score return risk for cart contents or product combinations.
 *  - Identify risk reasons: missing component, technical mismatch,
 *    size uncertainty, subjective-fit risk, incomplete setup.
 *  - Produce prevention opportunities for downstream strategy generation.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO external APIs, no LLMs.
 *  - Fully deterministic.
 *  - Bounded memory — risk history capped at maxRiskHistory.
 *  - snapshot() / restore() — full replay support.
 *
 * Authority: RISK INTELLIGENCE only. Does NOT decide. Does NOT block. Does NOT message.
 *
 * Integration:
 *  - Consumes OntologyRecords from product-ontology-engine.
 *  - Consumes compatibility results from compatibility-intelligence-engine.
 *  - Consumes missing complements from complement-graph-engine.
 *  - Output consumed by relationship-message-strategy-engine.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE    = 'ReturnRiskIntelligenceEngine';

/** Risk factor types that can contribute to the final risk score */
const RISK_FACTOR_TYPES = Object.freeze({
  MISSING_REQUIRED_COMPONENT:  'missing_required_component',   // Camera without SD card
  INCOMPLETE_SETUP:            'incomplete_setup',              // Monitor without cable
  TECHNICAL_MISMATCH:          'technical_mismatch',           // Wrong port standard
  SIZE_UNCERTAINTY:            'size_uncertainty',             // Size-dependent product, unknown size
  AESTHETIC_MISMATCH_RISK:     'aesthetic_mismatch_risk',      // Fashion item without confirmed pairing
  SUBJECTIVE_FIT_RISK:         'subjective_fit_risk',          // Perfume, taste-based product
  CONSUMABLE_WITHOUT_DEVICE:   'consumable_without_device',    // Capsule without machine
  COMPATIBILITY_UNKNOWN:       'compatibility_unknown',        // No compatibility data available
  HESITATION_MISMATCH:         'hesitation_mismatch',          // Strong hesitation + compatibility gap
  INCOMPLETE_MEAL:             'incomplete_meal',              // Missing core meal component
  INCOMPLETE_OUTFIT:           'incomplete_outfit',            // Fashion: incomplete look
  SKINCARE_INCOMPATIBILITY:    'skincare_incompatibility',     // Wrong routine order or conflicting ingredients
});

/** Prevention opportunity types */
const PREVENTION_OPPORTUNITY_TYPES = Object.freeze({
  ADD_MISSING_COMPONENT:    'add_missing_component',   // Guide user to add critical missing item
  VERIFY_COMPATIBILITY:     'verify_compatibility',    // Prompt user to confirm size / connector
  COMPLETE_SETUP:           'complete_setup',          // Help user complete an incomplete setup
  REASSURE_AND_ANCHOR:      'reassure_and_anchor',     // Reduce subjective fear of return
  SIZE_GUIDANCE:            'size_guidance',           // Guide user to select correct size
  SKINCARE_CORRECTION:      'skincare_correction',     // Correct skincare routine order
});

/** Risk tiers */
const RISK_TIERS = Object.freeze({
  LOW:      'low',       // score < 0.30
  MODERATE: 'moderate',  // score 0.30–0.60
  HIGH:     'high',      // score > 0.60
});

// Risk factor weights: how much each factor contributes to overall risk score
const RISK_FACTOR_WEIGHTS = Object.freeze({
  [RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT]:  0.90,
  [RISK_FACTOR_TYPES.INCOMPLETE_SETUP]:            0.85,
  [RISK_FACTOR_TYPES.TECHNICAL_MISMATCH]:          0.80,
  [RISK_FACTOR_TYPES.SIZE_UNCERTAINTY]:            0.65,
  [RISK_FACTOR_TYPES.AESTHETIC_MISMATCH_RISK]:     0.55,
  [RISK_FACTOR_TYPES.SUBJECTIVE_FIT_RISK]:         0.45,
  [RISK_FACTOR_TYPES.CONSUMABLE_WITHOUT_DEVICE]:   0.70,
  [RISK_FACTOR_TYPES.COMPATIBILITY_UNKNOWN]:       0.30,
  [RISK_FACTOR_TYPES.HESITATION_MISMATCH]:         0.60,
  [RISK_FACTOR_TYPES.INCOMPLETE_MEAL]:             0.40,
  [RISK_FACTOR_TYPES.INCOMPLETE_OUTFIT]:           0.35,
  [RISK_FACTOR_TYPES.SKINCARE_INCOMPATIBILITY]:    0.75,
});

const DEFAULT_CONFIG = Object.freeze({
  maxRiskHistory:         256,  // bounded history of risk assessments
  hesitationDwellMs:      8000, // dwell threshold to consider hesitation
  sizeRiskMinViewCount:   2,    // min views before flagging size risk
});

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`ReturnRiskIntelligenceEngine: ${label} must be a finite number, got ${val}`);
  }
}

function _riskTier(score) {
  if (score > 0.60) return RISK_TIERS.HIGH;
  if (score > 0.30) return RISK_TIERS.MODERATE;
  return RISK_TIERS.LOW;
}

/**
 * Combine multiple risk factors into an aggregate score.
 * Uses a "max + dampened-sum" formula to avoid inflation:
 *   score = max(factors) * 0.6 + mean(remaining) * 0.4
 */
function _aggregateRiskScore(factorWeights) {
  if (factorWeights.length === 0) return 0;
  const sorted = [...factorWeights].sort((a, b) => b - a);
  const max = sorted[0];
  if (sorted.length === 1) return max;

  const remaining = sorted.slice(1);
  const mean = remaining.reduce((s, v) => s + v, 0) / remaining.length;
  return Math.min(1, max * 0.6 + mean * 0.4);
}

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
// ReturnRiskIntelligenceEngine
// ============================================================================

class ReturnRiskIntelligenceEngine {
  /**
   * @param {object} ontologyEngine           — ProductOntologyEngine instance
   * @param {object} graphEngine              — ComplementGraphEngine instance
   * @param {object} compatibilityEngine      — CompatibilityIntelligenceEngine instance
   * @param {object} [config]
   */
  constructor(ontologyEngine, graphEngine, compatibilityEngine, config = {}) {
    if (!ontologyEngine || typeof ontologyEngine.resolve !== 'function') {
      throw new TypeError('ReturnRiskIntelligenceEngine: ontologyEngine required');
    }
    if (!graphEngine || typeof graphEngine.findMissingComplements !== 'function') {
      throw new TypeError('ReturnRiskIntelligenceEngine: graphEngine required');
    }
    if (!compatibilityEngine || typeof compatibilityEngine.evaluate !== 'function') {
      throw new TypeError('ReturnRiskIntelligenceEngine: compatibilityEngine required');
    }

    this._ontology      = ontologyEngine;
    this._graph         = graphEngine;
    this._compatibility = compatibilityEngine;
    this._config        = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    /** productId → risk assessment */
    this._riskHistory = new LRUMap(this._config.maxRiskHistory);

    this._disposed = false;
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Assess return risk for a set of products (e.g., current cart + viewed products).
   *
   * @param {object} params
   * @param {object[]} params.cartProducts       — products in cart (with rawProduct data)
   * @param {object[]} params.viewedProducts     — products viewed (with viewCount, dwellMs)
   * @param {number}   params.nowMs
   * @returns {RiskAssessment}
   */
  assess({ cartProducts = [], viewedProducts = [], nowMs }) {
    _assertFiniteNumber(nowMs, 'assess.nowMs');
    if (this._disposed) throw new Error('ReturnRiskIntelligenceEngine: disposed');

    const factors = [];
    const preventionOpportunities = [];

    // Resolve ontology for all products
    const cartRecords    = cartProducts.map(p => ({
      raw: p,
      record: this._ontology.resolve(p, nowMs),
    }));
    const viewedRecords  = viewedProducts.map(p => ({
      raw: p,
      record: this._ontology.resolve(p, nowMs),
    }));

    const allRecords  = [...cartRecords, ...viewedRecords];
    const cartSubcats = new Set(cartRecords.map(r => r.record.subcategory));
    const allSubcats  = new Set(allRecords.map(r => r.record.subcategory));

    // ── 1. Missing required components (from graph) ──────────────────────────
    const missingEdges = this._graph.findMissingComplements(
      Array.from(allSubcats),
      {
        types: ['setup_dependency', 'meal_component'],
        minWeight: 0.70,
        minConfidence: 0.80,
      }
    );

    for (const missing of missingEdges) {
      // Only flag if the triggering product is in cart
      if (!cartSubcats.has(missing.triggeredBySubcategory)) continue;

      factors.push({
        type:        RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT,
        weight:      RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT] * missing.weight,
        rationale:   ['cart_product_needs_complement', missing.triggeredBySubcategory, missing.missingSubcategory],
        missingSubcategory: missing.missingSubcategory,
        fromSubcategory:    missing.triggeredBySubcategory,
      });

      preventionOpportunities.push({
        type:                PREVENTION_OPPORTUNITY_TYPES.ADD_MISSING_COMPONENT,
        missingSubcategory:  missing.missingSubcategory,
        fromSubcategory:     missing.triggeredBySubcategory,
        priority:            missing.weight,
        rationale:           missing.rationale,
      });
    }

    // ── 2. Incomplete setup (optional complement missing from cart) ──────────
    const optionalMissing = this._graph.findMissingComplements(
      Array.from(cartSubcats),
      {
        types: ['complement', 'outfit_layer', 'skincare_step'],
        minWeight: 0.65,
        minConfidence: 0.75,
      }
    );

    for (const missing of optionalMissing) {
      factors.push({
        type:     RISK_FACTOR_TYPES.INCOMPLETE_SETUP,
        weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.INCOMPLETE_SETUP] * missing.weight * 0.7,
        rationale: ['optional_complement_missing', missing.triggeredBySubcategory, missing.missingSubcategory],
        missingSubcategory: missing.missingSubcategory,
        fromSubcategory:    missing.triggeredBySubcategory,
      });

      preventionOpportunities.push({
        type:               PREVENTION_OPPORTUNITY_TYPES.COMPLETE_SETUP,
        missingSubcategory: missing.missingSubcategory,
        fromSubcategory:    missing.triggeredBySubcategory,
        priority:           missing.weight * 0.7,
        rationale:          missing.rationale,
      });
    }

    // ── 3. Return-risk flags from OntologyRecord itself ──────────────────────
    for (const { record, raw } of cartRecords) {
      const { RETURN_RISK_FACTORS } = require('./product-ontology-engine');

      for (const riskFlag of (record.returnRiskFactors || [])) {
        switch (riskFlag) {
          case RETURN_RISK_FACTORS.SIZE_DEPENDENT:
            // Only flag if user has viewed multiple times (suggests uncertainty)
            if ((raw.viewCount || 1) >= this._config.sizeRiskMinViewCount) {
              factors.push({
                type:     RISK_FACTOR_TYPES.SIZE_UNCERTAINTY,
                weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.SIZE_UNCERTAINTY],
                rationale: ['size_dependent_product', 'multiple_views_suggest_uncertainty'],
              });
              preventionOpportunities.push({
                type:     PREVENTION_OPPORTUNITY_TYPES.SIZE_GUIDANCE,
                priority: 0.70,
                rationale: ['size_guide_reduces_returns'],
              });
            }
            break;

          case RETURN_RISK_FACTORS.TECHNICAL_MISMATCH:
            factors.push({
              type:     RISK_FACTOR_TYPES.TECHNICAL_MISMATCH,
              weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.TECHNICAL_MISMATCH],
              rationale: ['technical_mismatch_flag', record.subcategory],
            });
            preventionOpportunities.push({
              type:     PREVENTION_OPPORTUNITY_TYPES.VERIFY_COMPATIBILITY,
              priority: 0.80,
              rationale: ['verify_technical_specs'],
            });
            break;

          case RETURN_RISK_FACTORS.SUBJECTIVE_FIT:
            factors.push({
              type:     RISK_FACTOR_TYPES.SUBJECTIVE_FIT_RISK,
              weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.SUBJECTIVE_FIT_RISK],
              rationale: ['subjective_product_type', record.subcategory],
            });
            preventionOpportunities.push({
              type:     PREVENTION_OPPORTUNITY_TYPES.REASSURE_AND_ANCHOR,
              priority: 0.55,
              rationale: ['return_policy_reassurance_reduces_hesitation'],
            });
            break;

          case RETURN_RISK_FACTORS.MISSING_COMPONENT:
            factors.push({
              type:     RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT,
              weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT],
              rationale: ['product_flags_missing_component', record.subcategory],
            });
            break;

          case RETURN_RISK_FACTORS.CONSUMABLE_GUESS:
            factors.push({
              type:     RISK_FACTOR_TYPES.CONSUMABLE_WITHOUT_DEVICE,
              weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.CONSUMABLE_WITHOUT_DEVICE],
              rationale: ['consumable_without_confirmed_device', record.subcategory],
            });
            break;
        }
      }
    }

    // ── 4. Compatibility issues between cart pairs ────────────────────────────
    if (cartRecords.length >= 2) {
      const compatIssues = this._compatibility.evaluateSet(
        cartRecords.map(r => r.record),
        nowMs
      );

      const { COMPATIBILITY_OUTCOMES } = require('./compatibility-intelligence-engine');

      for (const issue of compatIssues) {
        if (issue.outcome === COMPATIBILITY_OUTCOMES.INCOMPATIBLE) {
          factors.push({
            type:     RISK_FACTOR_TYPES.TECHNICAL_MISMATCH,
            weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.TECHNICAL_MISMATCH],
            rationale: ['compatibility_engine_incompatible', issue.subcategoryA, issue.subcategoryB,
                        ...issue.compatibilityReasoning],
          });
        } else if (issue.outcome === COMPATIBILITY_OUTCOMES.UNCERTAIN) {
          factors.push({
            type:     RISK_FACTOR_TYPES.COMPATIBILITY_UNKNOWN,
            weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.COMPATIBILITY_UNKNOWN],
            rationale: ['compatibility_uncertain', issue.subcategoryA, issue.subcategoryB],
          });
        }
      }
    }

    // ── 5. Hesitation + missing complement (combined risk) ───────────────────
    for (const { raw, record } of viewedProducts.map(p => ({
      raw: p,
      record: this._ontology.resolve(p, nowMs),
    }))) {
      const isHesitating = (raw.dwellMs || 0) >= this._config.hesitationDwellMs && !raw.addedToCart;
      if (!isHesitating) continue;

      const missingForThis = this._graph.findMissingComplements(
        [record.subcategory],
        { types: ['complement', 'setup_dependency'], minWeight: 0.65 }
      );

      if (missingForThis.length > 0) {
        factors.push({
          type:     RISK_FACTOR_TYPES.HESITATION_MISMATCH,
          weight:   RISK_FACTOR_WEIGHTS[RISK_FACTOR_TYPES.HESITATION_MISMATCH],
          rationale: ['hesitation_detected', 'missing_complement_may_explain', record.subcategory],
        });
      }
    }

    // ── Aggregate ──────────────────────────────────────────────────────────
    const factorWeights = factors.map(f => f.weight);
    const riskScore     = _aggregateRiskScore(factorWeights);

    const assessment = {
      riskScore:    Math.round(riskScore * 1000) / 1000,
      riskTier:     _riskTier(riskScore),
      factors:      factors.slice(0, 20),  // bounded output
      preventionOpportunities: preventionOpportunities
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 10),
      rationale:    [
        `risk_tier:${_riskTier(riskScore)}`,
        `factors_count:${factors.length}`,
        `cart_products:${cartProducts.length}`,
      ],
      assessedAt:   nowMs,
    };

    return Object.freeze(assessment);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // LRU-bounded; no time-based purge.
  }

  dispose() {
    this._disposed = true;
    this._riskHistory.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type:    SCHEMA_TYPE,
      __version: SCHEMA_VERSION,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;
    return true;
  }

  getDiagnostics() {
    return {
      riskHistorySize: this._riskHistory.size,
      disposed:        this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ReturnRiskIntelligenceEngine,
  RISK_FACTOR_TYPES,
  PREVENTION_OPPORTUNITY_TYPES,
  RISK_TIERS,
  RISK_FACTOR_WEIGHTS,
};
