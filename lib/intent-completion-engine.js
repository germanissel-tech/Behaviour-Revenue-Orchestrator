'use strict';

/**
 * intent-completion-engine.js
 *
 * THE MOST IMPORTANT ENGINE in the product relationship intelligence layer.
 *
 * Responsibilities:
 *  - Detect incomplete purchase intent by analyzing viewed products,
 *    cart contents, revisits, hesitation, funnel stage, and partial
 *    abandon signals.
 *  - Produce relationship opportunities, completion opportunities,
 *    and risk opportunities for downstream strategy generation.
 *  - Does NOT show messages. Does NOT decide. Does NOT rank.
 *  - Provides behavioral enrichment to session-orchestrator.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO randomness. Fully deterministic.
 *  - Bounded memory — event history capped at maxEventHistory.
 *  - snapshot() / restore() — full replay support.
 *  - cleanup(nowMs) — purges stale entries.
 *  - dispose() — explicit teardown.
 *
 * Key detection patterns:
 *  - pasta added, no sauce → meal_completion_opportunity
 *  - camera viewed, no SD card in cart → missing_accessory_opportunity
 *  - monitor added, no cable → setup_incomplete_opportunity
 *  - sweater viewed, no bottoms → outfit_incomplete_opportunity
 *  - beauty_device added, no serum → setup_incomplete_opportunity
 *  - product revisited → high_interest_with_missing_complement
 *
 * Authority: DETECT incomplete intent only. No decisions. No messages.
 *
 * Integration:
 *  - Called by session-orchestrator (injected as enrichment layer).
 *  - Consumes OntologyRecords from product-ontology-engine.
 *  - Consumes edges from complement-graph-engine.
 *  - Output consumed by relationship-message-strategy-engine.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE    = 'IntentCompletionEngine';

/** Opportunity types this engine can produce */
const OPPORTUNITY_TYPES = Object.freeze({
  MEAL_COMPLETION:          'meal_completion',          // Food: missing core meal component
  OUTFIT_COMPLETION:        'outfit_completion',        // Fashion: missing outfit layer
  SETUP_COMPLETION:         'setup_completion',         // Tech: missing required component
  SKINCARE_ROUTINE:         'skincare_routine',         // Beauty: incomplete routine
  MISSING_ACCESSORY:        'missing_accessory',        // Optional but valuable add-on
  REVISIT_HIGH_INTEREST:    'revisit_high_interest',    // Revisited product without complement
  BUNDLE_COMPLETION:        'bundle_completion',        // Bundle anchor missing components
  CONSUMABLE_DEPENDENCY:    'consumable_dependency',    // Consumable without confirmed device
  PARTIAL_ABANDON:          'partial_abandon',          // Started adding to cart, stopped
  HESITATION_WITH_MISSING:  'hesitation_with_missing',  // Hesitating + has missing complement
});

/** Completion confidence tiers */
const CONFIDENCE_TIERS = Object.freeze({
  HIGH:   'high',    // ≥ 0.80
  MEDIUM: 'medium',  // ≥ 0.50
  LOW:    'low',     // < 0.50
});

const DEFAULT_CONFIG = Object.freeze({
  maxEventHistory:         500,   // bounded circular log of product interactions
  maxOpportunities:        50,    // max active opportunities tracked per session
  revisitThreshold:        2,     // views to count as a revisit
  hesitationDwellMs:       8000,  // dwell time considered hesitation
  partialAbandonTimeoutMs: 120000,// time after cart-add with no complement to flag partial abandon
  minComplementWeight:     0.6,   // minimum graph edge weight to trigger opportunity
  minComplementConfidence: 0.7,   // minimum graph edge confidence
});

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`IntentCompletionEngine: ${label} must be a finite number, got ${val}`);
  }
}

function _confidenceTier(score) {
  if (score >= 0.80) return CONFIDENCE_TIERS.HIGH;
  if (score >= 0.50) return CONFIDENCE_TIERS.MEDIUM;
  return CONFIDENCE_TIERS.LOW;
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
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
}

function _safeArrayPush(arr, item, cap) {
  arr.push(item);
  while (arr.length > cap) arr.shift();
}

// ============================================================================
// IntentCompletionEngine
// ============================================================================

class IntentCompletionEngine {
  /**
   * @param {object} ontologyEngine    — ProductOntologyEngine instance
   * @param {object} graphEngine       — ComplementGraphEngine instance
   * @param {object} [config]
   */
  constructor(ontologyEngine, graphEngine, config = {}) {
    if (!ontologyEngine || typeof ontologyEngine.resolve !== 'function') {
      throw new TypeError('IntentCompletionEngine: ontologyEngine required');
    }
    if (!graphEngine || typeof graphEngine.findMissingComplements !== 'function') {
      throw new TypeError('IntentCompletionEngine: graphEngine required');
    }

    this._ontologyEngine = ontologyEngine;
    this._graphEngine    = graphEngine;
    this._config         = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    /**
     * productId → { subcategory, viewCount, addedToCart, lastSeenAt, dwellMs, ontologyRecord }
     */
    this._seenProducts = new LRUMap(this._config.maxEventHistory);

    /**
     * Subcategories currently in cart.
     * @type {Set<string>}
     */
    this._cartSubcategories = new Set();

    /**
     * Subcategories of all products viewed (not necessarily in cart).
     * @type {Set<string>}
     */
    this._viewedSubcategories = new Set();

    /**
     * Active opportunities: opportunityId → opportunity object.
     * @type {LRUMap}
     */
    this._opportunities = new LRUMap(this._config.maxOpportunities);

    /** Circular event log for replay */
    this._eventLog = [];

    this._seq         = 0;
    this._disposed    = false;
  }

  // ==========================================================================
  // Core API — called by session-orchestrator enrichment layer
  // ==========================================================================

  /**
   * Ingest a product view event.
   * Updates internal state and recalculates opportunities.
   *
   * @param {object} params
   * @param {string} params.productId
   * @param {object} params.rawProduct — raw product data for ontology resolution
   * @param {number} params.dwellMs    — time spent on this product (0 if unknown)
   * @param {number} params.nowMs
   */
  ingestProductView({ productId, rawProduct, dwellMs = 0, nowMs }) {
    _assertFiniteNumber(nowMs, 'ingestProductView.nowMs');
    if (this._disposed) throw new Error('IntentCompletionEngine: disposed');

    const record = this._ontologyEngine.resolve(rawProduct || { productId }, nowMs);
    const existing = this._seenProducts.get(productId) || {
      subcategory: record.subcategory,
      viewCount: 0,
      addedToCart: false,
      lastSeenAt: nowMs,
      dwellMs: 0,
      ontologyRecord: record,
    };

    const updated = {
      ...existing,
      viewCount:       existing.viewCount + 1,
      lastSeenAt:      nowMs,
      dwellMs:         existing.dwellMs + dwellMs,
      ontologyRecord:  record,
    };

    this._seenProducts.set(productId, updated);
    this._viewedSubcategories.add(record.subcategory);

    _safeArrayPush(this._eventLog, {
      type: 'product_view', productId, subcategory: record.subcategory, nowMs,
    }, this._config.maxEventHistory);

    this._recompute(nowMs);
  }

  /**
   * Ingest a cart-add event.
   *
   * @param {object} params
   * @param {string} params.productId
   * @param {object} params.rawProduct
   * @param {number} params.nowMs
   */
  ingestCartAdd({ productId, rawProduct, nowMs }) {
    _assertFiniteNumber(nowMs, 'ingestCartAdd.nowMs');
    if (this._disposed) throw new Error('IntentCompletionEngine: disposed');

    const record = this._ontologyEngine.resolve(rawProduct || { productId }, nowMs);
    const existing = this._seenProducts.get(productId) || {
      subcategory: record.subcategory,
      viewCount: 1,
      addedToCart: false,
      lastSeenAt: nowMs,
      dwellMs: 0,
      ontologyRecord: record,
    };

    this._seenProducts.set(productId, {
      ...existing,
      addedToCart: true,
      cartAddedAt: nowMs,
      ontologyRecord: record,
    });

    this._cartSubcategories.add(record.subcategory);
    this._viewedSubcategories.add(record.subcategory);

    _safeArrayPush(this._eventLog, {
      type: 'cart_add', productId, subcategory: record.subcategory, nowMs,
    }, this._config.maxEventHistory);

    this._recompute(nowMs);
  }

  /**
   * Ingest a cart-remove event.
   *
   * @param {object} params
   * @param {string} params.productId
   * @param {object} params.rawProduct
   * @param {number} params.nowMs
   */
  ingestCartRemove({ productId, rawProduct, nowMs }) {
    _assertFiniteNumber(nowMs, 'ingestCartRemove.nowMs');
    if (this._disposed) throw new Error('IntentCompletionEngine: disposed');

    const record = this._ontologyEngine.resolve(rawProduct || { productId }, nowMs);

    const existing = this._seenProducts.get(productId);
    if (existing) {
      this._seenProducts.set(productId, { ...existing, addedToCart: false });
    }

    // Recalculate cart and viewed subcategories from scratch
    this._cartSubcategories.clear();
    this._viewedSubcategories.clear();
    for (const [, p] of this._seenProducts.entries()) {
      if (p.addedToCart) {
        this._cartSubcategories.add(p.subcategory);
        this._viewedSubcategories.add(p.subcategory);
      } else if (!p.cartAddedAt) {
        // Viewed but never added to cart — still counts as viewed interest
        this._viewedSubcategories.add(p.subcategory);
      }
      // If cartAddedAt exists but addedToCart is false → was added then removed.
      // Do NOT put back in viewedSubcategories (it was explicitly removed).
    }

    _safeArrayPush(this._eventLog, {
      type: 'cart_remove', productId, subcategory: record.subcategory, nowMs,
    }, this._config.maxEventHistory);

    this._recompute(nowMs);
  }

  /**
   * Get current active opportunities, sorted by completionScore descending.
   * This is the primary output consumed by relationship-message-strategy-engine.
   *
   * @param {number} nowMs
   * @returns {CompletionOpportunity[]}
   */
  getOpportunities(nowMs) {
    _assertFiniteNumber(nowMs, 'getOpportunities.nowMs');
    if (this._disposed) throw new Error('IntentCompletionEngine: disposed');
    const results = [];
    for (const opp of this._opportunities.values()) {
      results.push(opp);
    }
    results.sort((a, b) => b.completionScore - a.completionScore);
    return results;
  }

  /**
   * Get the single highest-priority opportunity.
   * @param {number} nowMs
   * @returns {CompletionOpportunity|null}
   */
  getTopOpportunity(nowMs) {
    const all = this.getOpportunities(nowMs);
    return all.length > 0 ? all[0] : null;
  }

  // ==========================================================================
  // Internal: recompute opportunities
  // ==========================================================================

  _recompute(nowMs) {
    this._opportunities.clear();

    // Gather viewed and cart subcategories
    const viewedSubs     = Array.from(this._viewedSubcategories);
    const cartSubs       = Array.from(this._cartSubcategories);
    const allPresentSubs = Array.from(new Set([...viewedSubs, ...cartSubs]));

    if (allPresentSubs.length === 0) return;

    // --- 1. Find missing complements from graph ---
    const missing = this._graphEngine.findMissingComplements(allPresentSubs, {
      minWeight:      this._config.minComplementWeight,
      minConfidence:  this._config.minComplementConfidence,
    });

    for (const m of missing) {
      // Skip if this missing subcategory is already in cart (present enough)
      if (this._cartSubcategories.has(m.missingSubcategory)) continue;

      // Compute opportunity score
      let completionScore = m.weight * m.confidence;

      // Boost if the triggering product is in cart (stronger purchase commitment)
      const triggerInCart = this._cartSubcategories.has(m.triggeredBySubcategory);
      if (triggerInCart) completionScore = Math.min(1, completionScore * 1.25);

      // Boost for revisit (strong interest signal)
      const revisitBoost = this._getRevisitBoost(m.triggeredBySubcategory);
      completionScore = Math.min(1, completionScore * (1 + revisitBoost * 0.15));

      // Determine opportunity type
      const opportunityType = this._classifyOpportunityType(m.relationshipType, m.triggeredBySubcategory);

      const opportunityId = `opp_${m.triggeredBySubcategory}_${m.missingSubcategory}`;

      const opp = {
        opportunityId,
        opportunityType,
        missingSubcategory:         m.missingSubcategory,
        triggeredBySubcategory:     m.triggeredBySubcategory,
        relationshipType:           m.relationshipType,
        completionScore:            Math.round(completionScore * 1000) / 1000,
        confidenceTier:             _confidenceTier(completionScore),
        inCartContext:              triggerInCart,
        revisitContext:             revisitBoost > 0,
        rationale:                  [
          ...m.rationale,
          triggerInCart  ? 'trigger_in_cart'    : null,
          revisitBoost > 0 ? 'product_revisited' : null,
          this._isHesitating(m.triggeredBySubcategory) ? 'hesitation_detected' : null,
        ].filter(Boolean),
        detectedAt: nowMs,
      };

      this._opportunities.set(opportunityId, opp);
    }

    // --- 2. Detect partial-abandon pattern ---
    // Products added to cart some time ago, with no complement added since
    for (const [productId, p] of this._seenProducts.entries()) {
      if (!p.addedToCart || !p.cartAddedAt) continue;
      const elapsed = nowMs - p.cartAddedAt;
      if (elapsed < this._config.partialAbandonTimeoutMs) continue;

      const edges = this._graphEngine.getEdgesFrom(p.subcategory, {
        types: ['complement', 'setup_dependency', 'meal_component'],
        minWeight: 0.70,
      });

      const hasRequiredMissing = edges.some(e => !this._cartSubcategories.has(e.to));
      if (hasRequiredMissing) {
        const oppId = `opp_abandon_${productId}`;
        if (!this._opportunities.has(oppId)) {
          this._opportunities.set(oppId, {
            opportunityId:              oppId,
            opportunityType:            OPPORTUNITY_TYPES.PARTIAL_ABANDON,
            missingSubcategory:         edges[0] ? edges[0].to : null,
            triggeredBySubcategory:     p.subcategory,
            relationshipType:           edges[0] ? edges[0].type : null,
            completionScore:            0.65,
            confidenceTier:             CONFIDENCE_TIERS.MEDIUM,
            inCartContext:              true,
            revisitContext:             false,
            rationale:                  ['partial_abandon', `elapsed_${Math.round(elapsed / 1000)}s`],
            detectedAt:                 nowMs,
          });
        }
      }
    }
  }

  /**
   * Classify what kind of opportunity this missing complement represents.
   */
  _classifyOpportunityType(relationshipType, triggeredBySubcategory) {
    const { RELATIONSHIP_TYPES } = require('./complement-graph-engine');

    switch (relationshipType) {
      case RELATIONSHIP_TYPES.MEAL_COMPONENT:      return OPPORTUNITY_TYPES.MEAL_COMPLETION;
      case RELATIONSHIP_TYPES.OUTFIT_LAYER:        return OPPORTUNITY_TYPES.OUTFIT_COMPLETION;
      case RELATIONSHIP_TYPES.SKINCARE_STEP:       return OPPORTUNITY_TYPES.SKINCARE_ROUTINE;
      case RELATIONSHIP_TYPES.SETUP_DEPENDENCY:    return OPPORTUNITY_TYPES.SETUP_COMPLETION;
      case RELATIONSHIP_TYPES.CONSUMABLE_FOR:      return OPPORTUNITY_TYPES.CONSUMABLE_DEPENDENCY;
      case RELATIONSHIP_TYPES.BUNDLE:              return OPPORTUNITY_TYPES.BUNDLE_COMPLETION;
      case RELATIONSHIP_TYPES.COMPLEMENT:          return OPPORTUNITY_TYPES.MISSING_ACCESSORY;
      case RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT: return OPPORTUNITY_TYPES.MISSING_ACCESSORY;
      default:                                     return OPPORTUNITY_TYPES.MISSING_ACCESSORY;
    }
  }

  /**
   * How many times has this subcategory been revisited beyond the first view?
   * Returns a value in [0, 1] where 1 = many revisits.
   */
  _getRevisitBoost(subcategory) {
    let maxRevisits = 0;
    for (const p of this._seenProducts.values()) {
      if (p.subcategory === subcategory && p.viewCount > 1) {
        maxRevisits = Math.max(maxRevisits, p.viewCount - 1);
      }
    }
    return Math.min(1, maxRevisits / this._config.revisitThreshold);
  }

  /**
   * Is the user showing hesitation signals for products of this subcategory?
   * (High dwell time without add-to-cart)
   */
  _isHesitating(subcategory) {
    for (const p of this._seenProducts.values()) {
      if (p.subcategory !== subcategory) continue;
      if (p.addedToCart) continue;
      if (p.dwellMs >= this._config.hesitationDwellMs) return true;
    }
    return false;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup(nowMs) {
    _assertFiniteNumber(nowMs, 'cleanup.nowMs');
    // Purge opportunities older than 30 minutes
    const cutoff = nowMs - 30 * 60 * 1000;
    for (const [k, opp] of this._opportunities.entries()) {
      if (opp.detectedAt < cutoff) this._opportunities.delete(k);
    }
  }

  dispose() {
    this._disposed = true;
    this._seenProducts.clear();
    this._cartSubcategories.clear();
    this._viewedSubcategories.clear();
    this._opportunities.clear();
    this._eventLog = [];
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type:   SCHEMA_TYPE,
      __version: SCHEMA_VERSION,
      seq:      this._seq,
      seenProducts:         Array.from(this._seenProducts.entries()),
      cartSubcategories:    Array.from(this._cartSubcategories),
      viewedSubcategories:  Array.from(this._viewedSubcategories),
      opportunities:        Array.from(this._opportunities.entries()),
      eventLog:             [...this._eventLog],
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;

    this._seenProducts = new LRUMap(this._config.maxEventHistory);
    if (Array.isArray(snap.seenProducts)) {
      for (const [k, v] of snap.seenProducts) this._seenProducts.set(k, v);
    }

    this._cartSubcategories   = new Set(Array.isArray(snap.cartSubcategories)  ? snap.cartSubcategories  : []);
    this._viewedSubcategories = new Set(Array.isArray(snap.viewedSubcategories) ? snap.viewedSubcategories : []);

    this._opportunities = new LRUMap(this._config.maxOpportunities);
    if (Array.isArray(snap.opportunities)) {
      for (const [k, v] of snap.opportunities) this._opportunities.set(k, v);
    }

    this._eventLog = Array.isArray(snap.eventLog) ? [...snap.eventLog] : [];
    return true;
  }

  getDiagnostics() {
    return {
      seenProductCount:       this._seenProducts.size,
      cartSubcategoryCount:   this._cartSubcategories.size,
      viewedSubcategoryCount: this._viewedSubcategories.size,
      activeOpportunities:    this._opportunities.size,
      eventLogLength:         this._eventLog.length,
      disposed:               this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  IntentCompletionEngine,
  OPPORTUNITY_TYPES,
  CONFIDENCE_TIERS,
};
