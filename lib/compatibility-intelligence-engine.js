'use strict';

/**
 * compatibility-intelligence-engine.js
 *
 * Contextual compatibility analysis for product pairs.
 *
 * Responsibilities:
 *  - Detect technical, aesthetic, functional, and contextual compatibility
 *    between products in a session.
 *  - Produce a compatibilityScore and structured compatibilityReasoning.
 *  - Cover: connector standards, color/style match, size constraints,
 *    skincare compatibility, outfit layering rules.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO external APIs, no LLMs.
 *  - Deterministic: all compatibility rules are static.
 *  - Bounded memory — LRU cache on pairwise results.
 *  - snapshot() / restore() — full replay support.
 *  - No side effects.
 *
 * Authority: COMPATIBILITY ANALYSIS only. Does NOT decide. Does NOT rank.
 *
 * Integration:
 *  - Called by relationship-message-strategy-engine and
 *    return-risk-intelligence-engine.
 *  - Consumes OntologyRecords from product-ontology-engine.
 *  - Complements complement-graph-engine (graph tells WHAT is related;
 *    this engine tells HOW compatible they actually are).
 */

// ============================================================================
// Compatibility dimensions
// ============================================================================

const COMPATIBILITY_DIMENSIONS = Object.freeze({
  TECHNICAL:    'technical',    // Port standards, protocols, spec requirements
  AESTHETIC:    'aesthetic',    // Color, style, visual coherence
  FUNCTIONAL:   'functional',   // Use-case alignment, feature coverage
  CONTEXTUAL:   'contextual',   // Usage environment, occasion match
  SIZE:         'size',         // Physical size / taille compatibility
  ROUTINE:      'routine',      // Step-order compatibility (skincare, cooking)
});

const COMPATIBILITY_OUTCOMES = Object.freeze({
  COMPATIBLE:       'compatible',         // No issues detected
  CONDITIONALLY_OK: 'conditionally_ok',   // OK but with caveats
  UNCERTAIN:        'uncertain',          // Cannot determine without more info
  INCOMPATIBLE:     'incompatible',       // Clear incompatibility detected
});

// ============================================================================
// Static compatibility rules
//
// Each rule: {
//   id, fromTags[], toTags[], dimension, outcome, score, reasoning[]
// }
//
// fromTags / toTags are compatibility tags from OntologyRecords.
// A rule fires when the product pair has matching tags on both sides.
// ============================================================================

const COMPATIBILITY_RULES = Object.freeze([

  // ── TECHNICAL: Display connectors ─────────────────────────────────────────
  {
    id:       'hdmi_monitor_ok',
    fromTags: ['output:hdmi'],
    toTags:   ['output:hdmi'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.95,
    reasoning: ['hdmi_to_hdmi_native', 'no_adapter_needed'],
  },
  {
    id:       'displayport_ok',
    fromTags: ['output:displayport'],
    toTags:   ['output:displayport'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.95,
    reasoning: ['displayport_native', 'no_adapter_needed'],
  },
  {
    id:       'hdmi_to_dp_conditional',
    fromTags: ['output:hdmi'],
    toTags:   ['output:displayport'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.CONDITIONALLY_OK,
    score:    0.60,
    reasoning: ['requires_active_adapter', 'signal_conversion_needed'],
  },

  // ── TECHNICAL: Audio connectors ───────────────────────────────────────────
  {
    id:       'bluetooth_audio_ok',
    fromTags: ['connector:bluetooth'],
    toTags:   ['connector:bluetooth'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.92,
    reasoning: ['bluetooth_universal', 'no_cable_needed'],
  },
  {
    id:       'jack35_audio_ok',
    fromTags: ['connector:jack35'],
    toTags:   ['connector:jack35'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.90,
    reasoning: ['jack35_universal'],
  },
  {
    id:       'usb_audio_ok',
    fromTags: ['connector:usb'],
    toTags:   ['connector:usb'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.85,
    reasoning: ['usb_audio_class_compliant'],
  },

  // ── TECHNICAL: Gaming ecosystem ───────────────────────────────────────────
  {
    id:       'console_ecosystem_ok',
    fromTags: ['ecosystem:console'],
    toTags:   ['ecosystem:console'],
    dimension: COMPATIBILITY_DIMENSIONS.TECHNICAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.88,
    reasoning: ['same_ecosystem'],
  },

  // ── FUNCTIONAL: Skincare routine order ───────────────────────────────────
  {
    id:       'skincare_first_to_active',
    directional: true,
    fromTags: ['layer:skincare_first'],
    toTags:   ['layer:skincare_active'],
    dimension: COMPATIBILITY_DIMENSIONS.ROUTINE,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.94,
    reasoning: ['correct_routine_order', 'cleanser_before_serum'],
  },
  {
    id:       'skincare_active_to_base',
    directional: true,
    fromTags: ['layer:skincare_active'],
    toTags:   ['layer:skincare_base'],
    dimension: COMPATIBILITY_DIMENSIONS.ROUTINE,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.93,
    reasoning: ['correct_routine_order', 'serum_before_moisturizer'],
  },
  {
    id:       'skincare_base_to_final',
    directional: true,
    fromTags: ['layer:skincare_base'],
    toTags:   ['layer:skincare_final'],
    dimension: COMPATIBILITY_DIMENSIONS.ROUTINE,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.92,
    reasoning: ['correct_routine_order', 'moisturizer_before_spf'],
  },
  {
    id:       'skincare_wrong_order_risk',
    directional: true,
    fromTags: ['layer:skincare_active'],
    toTags:   ['layer:skincare_first'],
    dimension: COMPATIBILITY_DIMENSIONS.ROUTINE,
    outcome:  COMPATIBILITY_OUTCOMES.INCOMPATIBLE,
    score:    0.30,
    reasoning: ['wrong_routine_order', 'active_before_cleanser_ineffective'],
  },

  // ── AESTHETIC: Fashion layers ─────────────────────────────────────────────
  {
    id:       'fashion_base_to_outer',
    fromTags: ['layer:base'],
    toTags:   ['layer:outer'],
    dimension: COMPATIBILITY_DIMENSIONS.AESTHETIC,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.85,
    reasoning: ['layering_convention', 'base_under_outer'],
  },
  {
    id:       'fashion_casual_match',
    fromTags: ['style:casual'],
    toTags:   ['style:casual'],
    dimension: COMPATIBILITY_DIMENSIONS.AESTHETIC,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.88,
    reasoning: ['consistent_style_casual'],
  },
  {
    id:       'fashion_smart_casual_match',
    fromTags: ['style:smart_casual'],
    toTags:   ['style:smart_casual'],
    dimension: COMPATIBILITY_DIMENSIONS.AESTHETIC,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.86,
    reasoning: ['consistent_style_smart_casual'],
  },

  // ── CONTEXTUAL: Meal structure ────────────────────────────────────────────
  {
    id:       'meal_italian_ok',
    fromTags: ['meal:italian'],
    toTags:   ['meal:italian'],
    dimension: COMPATIBILITY_DIMENSIONS.CONTEXTUAL,
    outcome:  COMPATIBILITY_OUTCOMES.COMPATIBLE,
    score:    0.95,
    reasoning: ['same_cuisine_context', 'italian_meal_pairing'],
  },

  // ── SIZE: Generic size dependency ─────────────────────────────────────────
  {
    id:       'size_dependent_uncertain',
    fromTags: ['talle_dependent'],
    toTags:   ['talle_dependent'],
    dimension: COMPATIBILITY_DIMENSIONS.SIZE,
    outcome:  COMPATIBILITY_OUTCOMES.UNCERTAIN,
    score:    0.55,
    reasoning: ['size_info_required', 'cannot_verify_without_user_size'],
  },
  {
    id:       'size_constraint_check',
    fromTags: ['size_constraint'],
    toTags:   ['size_constraint'],
    dimension: COMPATIBILITY_DIMENSIONS.SIZE,
    outcome:  COMPATIBILITY_OUTCOMES.UNCERTAIN,
    score:    0.55,
    reasoning: ['physical_size_unverified', 'check_dimensions'],
  },
]);

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE    = 'CompatibilityIntelligenceEngine';

const DEFAULT_CONFIG = Object.freeze({
  maxPairCache: 1024,  // max cached pair results (LRU)
});

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`CompatibilityIntelligenceEngine: ${label} must be a finite number, got ${val}`);
  }
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

/**
 * Does the ontology record have all the requested tags?
 * Supports partial matching: returns true if ANY tag from `needTags` is present.
 */
function _hasAnyTag(ontologyRecord, needTags) {
  if (!ontologyRecord || !Array.isArray(ontologyRecord.compatibilityTags)) return false;
  const tagSet = new Set(ontologyRecord.compatibilityTags);
  return needTags.some(t => tagSet.has(t));
}

// ============================================================================
// CompatibilityIntelligenceEngine
// ============================================================================

class CompatibilityIntelligenceEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.maxPairCache=1024]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._pairCache = new LRUMap(this._config.maxPairCache);
    this._disposed = false;
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Evaluate compatibility between two OntologyRecords.
   *
   * @param {OntologyRecord} recordA
   * @param {OntologyRecord} recordB
   * @param {number} nowMs
   * @returns {CompatibilityResult}
   */
  evaluate(recordA, recordB, nowMs) {
    _assertFiniteNumber(nowMs, 'evaluate.nowMs');
    if (this._disposed) throw new Error('CompatibilityIntelligenceEngine: disposed');

    const pairKey = `${recordA.subcategory}:${recordB.subcategory}`;
    const cached = this._pairCache.get(pairKey);
    if (cached) return cached;

    const firedRules = [];
    let totalScore  = 0;
    let totalWeight = 0;
    const reasoning = new Set();

    for (const rule of COMPATIBILITY_RULES) {
      const aHasFrom = _hasAnyTag(recordA, rule.fromTags);
      const bHasTo   = _hasAnyTag(recordB, rule.toTags);
      const aHasTo   = _hasAnyTag(recordA, rule.toTags);
      const bHasFrom = _hasAnyTag(recordB, rule.fromTags);

      // Directional rules only fire A→B. Non-directional rules are bidirectional.
      const forwardMatch  = aHasFrom && bHasTo;
      const reverseMatch  = !rule.directional && (aHasTo && bHasFrom);
      if (forwardMatch || reverseMatch) {
        firedRules.push(rule);
        // Weight: incompatibility rules carry more weight (penalty)
        const ruleWeight = rule.outcome === COMPATIBILITY_OUTCOMES.INCOMPATIBLE ? 2.0 : 1.0;
        totalScore  += rule.score * ruleWeight;
        totalWeight += ruleWeight;
        rule.reasoning.forEach(r => reasoning.add(r));
      }
    }

    let compatibilityScore;
    let outcome;

    if (firedRules.length === 0) {
      // No rules matched — unknown compatibility
      compatibilityScore = 0.5;
      outcome = COMPATIBILITY_OUTCOMES.UNCERTAIN;
      reasoning.add('no_rules_matched');
    } else {
      compatibilityScore = Math.round((totalScore / totalWeight) * 1000) / 1000;

      // Determine outcome from score + fired rule outcomes
      const hasIncompatible = firedRules.some(r => r.outcome === COMPATIBILITY_OUTCOMES.INCOMPATIBLE);
      if (hasIncompatible || compatibilityScore < 0.40) {
        outcome = COMPATIBILITY_OUTCOMES.INCOMPATIBLE;
      } else if (compatibilityScore >= 0.80) {
        outcome = COMPATIBILITY_OUTCOMES.COMPATIBLE;
      } else if (compatibilityScore >= 0.55) {
        outcome = COMPATIBILITY_OUTCOMES.CONDITIONALLY_OK;
      } else {
        outcome = COMPATIBILITY_OUTCOMES.UNCERTAIN;
      }
    }

    const dimensions = [...new Set(firedRules.map(r => r.dimension))];

    const result = Object.freeze({
      pairKey,
      subcategoryA:        recordA.subcategory,
      subcategoryB:        recordB.subcategory,
      compatibilityScore,
      outcome,
      dimensions,
      compatibilityReasoning: Array.from(reasoning),
      firedRuleCount:      firedRules.length,
      evaluatedAt:         nowMs,
    });

    this._pairCache.set(pairKey, result);
    return result;
  }

  /**
   * Evaluate compatibility for all pairs in a set of OntologyRecords.
   * Returns only pairs with non-COMPATIBLE outcome or score < 0.75.
   *
   * @param {OntologyRecord[]} records
   * @param {number} nowMs
   * @returns {CompatibilityResult[]}
   */
  evaluateSet(records, nowMs) {
    _assertFiniteNumber(nowMs, 'evaluateSet.nowMs');
    if (!Array.isArray(records) || records.length < 2) return [];

    const issues = [];
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const result = this.evaluate(records[i], records[j], nowMs);
        if (result.outcome !== COMPATIBILITY_OUTCOMES.COMPATIBLE || result.compatibilityScore < 0.75) {
          issues.push(result);
        }
      }
    }

    issues.sort((a, b) => a.compatibilityScore - b.compatibilityScore);
    return issues;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // Pair cache is LRU-bounded; no time-based purge needed.
  }

  dispose() {
    this._disposed = true;
    this._pairCache.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    const cache = [];
    for (const [k, v] of this._pairCache.entries()) {
      cache.push([k, v]);
    }
    return {
      __type:    SCHEMA_TYPE,
      __version: SCHEMA_VERSION,
      cache,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._pairCache = new LRUMap(this._config.maxPairCache);
    if (Array.isArray(snap.cache)) {
      for (const [k, v] of snap.cache) this._pairCache.set(k, v);
    }
    return true;
  }

  getDiagnostics() {
    return {
      pairCacheSize: this._pairCache.size,
      maxPairCache:  this._config.maxPairCache,
      ruleCount:     COMPATIBILITY_RULES.length,
      disposed:      this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  CompatibilityIntelligenceEngine,
  COMPATIBILITY_DIMENSIONS,
  COMPATIBILITY_OUTCOMES,
  COMPATIBILITY_RULES,
};
