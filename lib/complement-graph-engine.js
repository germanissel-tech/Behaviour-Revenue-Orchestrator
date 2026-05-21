'use strict';

/**
 * complement-graph-engine.js
 *
 * SINGLE AUTHORITY for product relationship graph resolution.
 *
 * Responsibilities:
 *  - Maintain a deterministic, bounded graph of product relationships.
 *  - Support: complements, substitutes, bundles, optional dependencies,
 *    and anti-compatibility edges.
 *  - Expose weighted edges with confidence scores and relationship types.
 *  - Resolve complement/substitute suggestions for a given product or
 *    subcategory resolved by product-ontology-engine.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO external APIs, no LLMs.
 *  - Deterministic: graph definition is static; traversal is deterministic.
 *  - Bounded memory: edge store capped at maxEdges (LRU eviction).
 *  - snapshot() / restore() — full replay support.
 *  - cleanup() / dispose() — explicit lifecycle.
 *
 * Authority: GRAPH INTELLIGENCE only. Does NOT decide. Does NOT rank.
 *
 * Integration:
 *  - Called by intent-completion-engine and relationship-message-strategy-engine.
 *  - Consumes OntologyRecords from product-ontology-engine.
 */

'use strict';

// ============================================================================
// Relationship types
// ============================================================================

const RELATIONSHIP_TYPES = Object.freeze({
  COMPLEMENT:          'complement',          // Strongly suggested companion (camera → SD card)
  OPTIONAL_COMPLEMENT: 'optional_complement', // Nice to have but not required (camera → tripod)
  SUBSTITUTE:          'substitute',          // Alternative (HDMI cable ↔ DisplayPort cable)
  BUNDLE:              'bundle',              // Commonly sold together (console + controller + game)
  SETUP_DEPENDENCY:    'setup_dependency',    // Required to make primary work (cable for monitor)
  ANTI_COMPATIBLE:     'anti_compatible',     // Known incompatibility (wrong port, wrong standard)
  CONSUMABLE_FOR:      'consumable_for',      // Consumable that feeds into a device (capsule → machine)
  OUTFIT_LAYER:        'outfit_layer',        // Fashion layering (base → mid → outer)
  SKINCARE_STEP:       'skincare_step',       // Routine order (cleanser → serum → moisturizer → spf)
  MEAL_COMPONENT:      'meal_component',      // Meal completion (pasta → sauce → cheese)
});

// ============================================================================
// Static graph definition
//
// Each entry: { from, to, type, weight, confidence, rationale[] }
//
// `from` and `to` are OntologyEngine subcategory values.
// `weight` ∈ [0, 1]: how strongly this edge is recommended.
// `confidence` ∈ [0, 1]: how reliable the relationship is.
// Directed graph; add both directions for bidirectional relationships.
// ============================================================================

const STATIC_EDGES = Object.freeze([

  // ── FOOD / MEAL ────────────────────────────────────────────────────────────
  { from: 'dry_pasta',       to: 'sauce',          type: RELATIONSHIP_TYPES.MEAL_COMPONENT,      weight: 0.95, confidence: 0.99, rationale: ['meal_component', 'italian_meal_structure'] },
  { from: 'dry_pasta',       to: 'grated_cheese',  type: RELATIONSHIP_TYPES.MEAL_COMPONENT,      weight: 0.85, confidence: 0.97, rationale: ['meal_component', 'topping_convention'] },
  { from: 'dry_pasta',       to: 'cooking_oil',    type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.55, confidence: 0.80, rationale: ['cooking_technique'] },
  { from: 'sauce',           to: 'dry_pasta',      type: RELATIONSHIP_TYPES.MEAL_COMPONENT,      weight: 0.90, confidence: 0.97, rationale: ['meal_component'] },
  { from: 'sauce',           to: 'grated_cheese',  type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.75, confidence: 0.93, rationale: ['topping_convention'] },
  { from: 'grated_cheese',   to: 'dry_pasta',      type: RELATIONSHIP_TYPES.MEAL_COMPONENT,      weight: 0.88, confidence: 0.96, rationale: ['meal_component'] },
  { from: 'coffee',          to: 'coffee_machine',  type: RELATIONSHIP_TYPES.CONSUMABLE_FOR,      weight: 0.95, confidence: 0.99, rationale: ['consumable_dependency'] },
  { from: 'beverage_wine',   to: 'gourmet_food',   type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.65, confidence: 0.75, rationale: ['pairing_convention'] },

  // ── ELECTRONICS / MONITOR ──────────────────────────────────────────────────
  { from: 'monitor',         to: 'display_cable',  type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.97, confidence: 0.99, rationale: ['required_for_setup', 'technical_dependency'] },
  { from: 'monitor',         to: 'monitor_stand',  type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.70, confidence: 0.90, rationale: ['ergonomics', 'workspace_setup'] },
  { from: 'monitor',         to: 'keyboard',       type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.60, confidence: 0.80, rationale: ['computing_setup_bundle'] },
  { from: 'monitor',         to: 'mouse',          type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.60, confidence: 0.80, rationale: ['computing_setup_bundle'] },
  { from: 'display_cable',   to: 'monitor',        type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.90, confidence: 0.98, rationale: ['pairs_with_monitor'] },
  { from: 'monitor_stand',   to: 'monitor',        type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.80, confidence: 0.92, rationale: ['ergonomic_setup'] },

  // ── GAMING CONSOLE ──────────────────────────────────────────────────────────
  { from: 'gaming_console',  to: 'controller',     type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.92, confidence: 0.97, rationale: ['required_to_play', 'ecosystem'] },
  { from: 'gaming_console',  to: 'game_title',     type: RELATIONSHIP_TYPES.COMPLEMENT,          weight: 0.90, confidence: 0.97, rationale: ['useless_without_game'] },
  { from: 'gaming_console',  to: 'gaming_headset', type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.65, confidence: 0.88, rationale: ['enhanced_experience'] },
  { from: 'gaming_console',  to: 'display_cable',  type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.90, confidence: 0.98, rationale: ['needs_hdmi_to_tv'] },
  { from: 'controller',      to: 'gaming_console', type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.85, confidence: 0.96, rationale: ['ecosystem_pair'] },
  { from: 'game_title',      to: 'gaming_console', type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.80, confidence: 0.95, rationale: ['needs_console_to_run'] },

  // ── PHOTOGRAPHY ─────────────────────────────────────────────────────────────
  { from: 'camera_body',     to: 'memory_card',    type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.99, confidence: 0.99, rationale: ['cant_save_without_card', 'missing_component'] },
  { from: 'camera_body',     to: 'camera_lens',    type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.90, confidence: 0.98, rationale: ['interchangeable_lens_system'] },
  { from: 'camera_body',     to: 'camera_support', type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.65, confidence: 0.88, rationale: ['stability_improvement'] },
  { from: 'memory_card',     to: 'camera_body',    type: RELATIONSHIP_TYPES.COMPLEMENT,          weight: 0.88, confidence: 0.97, rationale: ['storage_for_camera'] },
  { from: 'camera_lens',     to: 'camera_body',    type: RELATIONSHIP_TYPES.COMPLEMENT,          weight: 0.85, confidence: 0.97, rationale: ['lens_needs_body'] },

  // ── FASHION / OUTFIT ─────────────────────────────────────────────────────────
  { from: 'knitwear',        to: 'bottoms',        type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.80, confidence: 0.88, rationale: ['outfit_completion', 'upper_needs_lower'] },
  { from: 'knitwear',        to: 'shirt',          type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.70, confidence: 0.85, rationale: ['base_layer_convention'] },
  { from: 'knitwear',        to: 'footwear',       type: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT, weight: 0.55, confidence: 0.75, rationale: ['outfit_completion'] },
  { from: 'bottoms',         to: 'knitwear',       type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.75, confidence: 0.87, rationale: ['lower_needs_upper'] },
  { from: 'bottoms',         to: 'footwear',       type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.70, confidence: 0.85, rationale: ['outfit_completion'] },
  { from: 'outerwear',       to: 'knitwear',       type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.70, confidence: 0.85, rationale: ['layering_convention'] },
  { from: 'outerwear',       to: 'bottoms',        type: RELATIONSHIP_TYPES.OUTFIT_LAYER,        weight: 0.65, confidence: 0.82, rationale: ['outfit_completion'] },

  // ── BEAUTY / SKINCARE ─────────────────────────────────────────────────────
  { from: 'fragrance',       to: 'moisturizer',    type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.75, confidence: 0.88, rationale: ['layering_locks_scent', 'skin_prep'] },
  { from: 'beauty_device',   to: 'serum',          type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.90, confidence: 0.95, rationale: ['device_requires_serum', 'missing_component'] },
  { from: 'beauty_device',   to: 'cleanser',       type: RELATIONSHIP_TYPES.SETUP_DEPENDENCY,    weight: 0.88, confidence: 0.94, rationale: ['prep_before_device'] },
  { from: 'beauty_device',   to: 'moisturizer',    type: RELATIONSHIP_TYPES.COMPLEMENT,          weight: 0.80, confidence: 0.90, rationale: ['post_device_care'] },
  { from: 'serum',           to: 'moisturizer',    type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.90, confidence: 0.95, rationale: ['routine_step_order', 'seal_active'] },
  { from: 'serum',           to: 'sunscreen',      type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.85, confidence: 0.92, rationale: ['protection_after_active'] },
  { from: 'cleanser',        to: 'serum',          type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.85, confidence: 0.92, rationale: ['routine_step_order'] },
  { from: 'cleanser',        to: 'moisturizer',    type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.88, confidence: 0.94, rationale: ['post_cleanse_hydration'] },
  { from: 'moisturizer',     to: 'sunscreen',      type: RELATIONSHIP_TYPES.SKINCARE_STEP,       weight: 0.80, confidence: 0.90, rationale: ['routine_step_order'] },

  // ── AUDIO ─────────────────────────────────────────────────────────────────
  { from: 'headphones',      to: 'speaker',        type: RELATIONSHIP_TYPES.SUBSTITUTE,          weight: 0.50, confidence: 0.70, rationale: ['alternative_audio_output'] },
  { from: 'speaker',         to: 'headphones',     type: RELATIONSHIP_TYPES.SUBSTITUTE,          weight: 0.50, confidence: 0.70, rationale: ['alternative_audio_output'] },

  // ── COMPUTING ────────────────────────────────────────────────────────────
  { from: 'keyboard',        to: 'mouse',          type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.80, confidence: 0.90, rationale: ['desk_setup_bundle'] },
  { from: 'mouse',           to: 'keyboard',       type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.80, confidence: 0.90, rationale: ['desk_setup_bundle'] },
  { from: 'keyboard',        to: 'monitor',        type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.60, confidence: 0.80, rationale: ['computing_setup'] },
  { from: 'mouse',           to: 'monitor',        type: RELATIONSHIP_TYPES.BUNDLE,              weight: 0.60, confidence: 0.80, rationale: ['computing_setup'] },
]);

// Index static edges by `from` subcategory for O(1) lookup
const STATIC_EDGE_INDEX = (() => {
  const idx = new Map();
  for (const edge of STATIC_EDGES) {
    if (!idx.has(edge.from)) idx.set(edge.from, []);
    idx.get(edge.from).push(edge);
  }
  return idx;
})();

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE    = 'ComplementGraphEngine';

const DEFAULT_CONFIG = Object.freeze({
  maxDynamicEdges: 4096,  // cap on user-registered dynamic edges
  maxTraversalDepth: 3,   // max hops in findMissingComplements
  maxResultsPerQuery: 20, // cap on returned edges per query
});

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`ComplementGraphEngine: ${label} must be a finite number, got ${val}`);
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

// ============================================================================
// ComplementGraphEngine
// ============================================================================

class ComplementGraphEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.maxDynamicEdges=4096]
   * @param {number} [config.maxTraversalDepth=3]
   * @param {number} [config.maxResultsPerQuery=20]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    /**
     * Dynamic edges registered at runtime (product-specific overrides or additions).
     * Key: `${from}:${to}` → edge object.
     */
    this._dynamicEdges = new LRUMap(this._config.maxDynamicEdges);

    this._disposed = false;
  }

  // ==========================================================================
  // Core query API
  // ==========================================================================

  /**
   * Get all outgoing edges from a subcategory node.
   * Merges static graph with any dynamic overrides.
   *
   * @param {string} fromSubcategory — OntologyRecord.subcategory
   * @param {object} [options]
   * @param {string[]} [options.types] — filter by relationship type(s)
   * @param {number}   [options.minWeight=0] — filter by minimum weight
   * @param {number}   [options.minConfidence=0] — filter by minimum confidence
   * @returns {RelationshipEdge[]}
   */
  getEdgesFrom(fromSubcategory, options = {}) {
    if (this._disposed) throw new Error('ComplementGraphEngine: disposed');
    if (!fromSubcategory || typeof fromSubcategory !== 'string') return [];

    const {
      types = null,
      minWeight = 0,
      minConfidence = 0,
    } = options;

    const staticEdges = STATIC_EDGE_INDEX.get(fromSubcategory) || [];

    // Collect dynamic overrides
    const dynamicEdges = [];
    for (const [key, edge] of this._dynamicEdges.entries()) {
      if (edge.from === fromSubcategory) dynamicEdges.push(edge);
    }

    // Merge: dynamic overrides take precedence
    const dynamicKeys = new Set(dynamicEdges.map(e => `${e.from}:${e.to}`));
    const merged = [
      ...dynamicEdges,
      ...staticEdges.filter(e => !dynamicKeys.has(`${e.from}:${e.to}`)),
    ];

    // Apply filters
    let results = merged;
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      results = results.filter(e => typeSet.has(e.type));
    }
    if (minWeight > 0) results = results.filter(e => e.weight >= minWeight);
    if (minConfidence > 0) results = results.filter(e => e.confidence >= minConfidence);

    // Sort by weight desc
    results.sort((a, b) => b.weight - a.weight);

    return results.slice(0, this._config.maxResultsPerQuery);
  }

  /**
   * Given a set of cart/viewed subcategories, find which complements are
   * missing (not yet in the set).
   *
   * @param {string[]} presentSubcategories — subcategories already seen/in-cart
   * @param {object}   [options]
   * @param {string[]} [options.types] — relationship types to consider
   * @param {number}   [options.minWeight=0.5]
   * @param {number}   [options.minConfidence=0.7]
   * @returns {MissingComplementResult[]}
   */
  findMissingComplements(presentSubcategories, options = {}) {
    if (this._disposed) throw new Error('ComplementGraphEngine: disposed');
    if (!Array.isArray(presentSubcategories) || presentSubcategories.length === 0) return [];

    const {
      types = [
        RELATIONSHIP_TYPES.COMPLEMENT,
        RELATIONSHIP_TYPES.MEAL_COMPONENT,
        RELATIONSHIP_TYPES.SETUP_DEPENDENCY,
        RELATIONSHIP_TYPES.OUTFIT_LAYER,
        RELATIONSHIP_TYPES.SKINCARE_STEP,
      ],
      minWeight = 0.5,
      minConfidence = 0.7,
    } = options;

    const presentSet = new Set(presentSubcategories);
    const missingMap = new Map(); // subcategory → best edge

    for (const fromSub of presentSubcategories) {
      const edges = this.getEdgesFrom(fromSub, { types, minWeight, minConfidence });
      for (const edge of edges) {
        if (!presentSet.has(edge.to)) {
          // Keep the highest-weight edge that suggests this missing subcategory
          const existing = missingMap.get(edge.to);
          if (!existing || edge.weight > existing.edge.weight) {
            missingMap.set(edge.to, { edge, triggeredBy: fromSub });
          }
        }
      }
    }

    // Build result array, sorted by weight desc
    const results = [];
    for (const [missingSubcategory, { edge, triggeredBy }] of missingMap.entries()) {
      results.push({
        missingSubcategory,
        relationshipType: edge.type,
        weight:           edge.weight,
        confidence:       edge.confidence,
        triggeredBySubcategory: triggeredBy,
        rationale:        edge.rationale || [],
      });
    }

    results.sort((a, b) => b.weight - a.weight);
    return results;
  }

  /**
   * Check whether two subcategories have an anti-compatibility edge
   * in either direction.
   *
   * @param {string} subcategoryA
   * @param {string} subcategoryB
   * @returns {{ antiCompatible: boolean, reason: string|null }}
   */
  checkAntiCompatibility(subcategoryA, subcategoryB) {
    if (!subcategoryA || !subcategoryB) return { antiCompatible: false, reason: null };

    const edgesA = this.getEdgesFrom(subcategoryA, { types: [RELATIONSHIP_TYPES.ANTI_COMPATIBLE] });
    const edgesB = this.getEdgesFrom(subcategoryB, { types: [RELATIONSHIP_TYPES.ANTI_COMPATIBLE] });

    const conflictAB = edgesA.find(e => e.to === subcategoryB);
    const conflictBA = edgesB.find(e => e.to === subcategoryA);

    const conflict = conflictAB || conflictBA;
    if (conflict) {
      return {
        antiCompatible: true,
        reason: (conflict.rationale || []).join(', ') || 'anti_compatible_edge',
      };
    }
    return { antiCompatible: false, reason: null };
  }

  // ==========================================================================
  // Dynamic edge registration
  // ==========================================================================

  /**
   * Register a dynamic edge override (e.g., from product-catalog-specific data).
   * Dynamic edges take precedence over static graph edges.
   *
   * @param {object} edge — { from, to, type, weight, confidence, rationale[] }
   * @param {number} nowMs
   */
  registerEdge(edge, nowMs) {
    _assertFiniteNumber(nowMs, 'registerEdge.nowMs');
    if (!edge || typeof edge !== 'object') throw new TypeError('ComplementGraphEngine.registerEdge: edge must be an object');
    if (!edge.from || !edge.to || !edge.type) throw new TypeError('ComplementGraphEngine.registerEdge: edge requires from, to, type');

    const key = `${edge.from}:${edge.to}`;
    const validated = {
      from:       String(edge.from),
      to:         String(edge.to),
      type:       String(edge.type),
      weight:     typeof edge.weight === 'number' ? Math.max(0, Math.min(1, edge.weight)) : 0.5,
      confidence: typeof edge.confidence === 'number' ? Math.max(0, Math.min(1, edge.confidence)) : 0.5,
      rationale:  Array.isArray(edge.rationale) ? [...edge.rationale] : [],
      registeredAt: nowMs,
      dynamic:    true,
    };

    this._dynamicEdges.set(key, validated);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // Dynamic edges are LRU-bounded; no time-based purge needed unless we add TTL.
  }

  dispose() {
    this._disposed = true;
    this._dynamicEdges.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    const dynamicEdges = [];
    for (const [k, v] of this._dynamicEdges.entries()) {
      dynamicEdges.push([k, v]);
    }
    return {
      __type:       SCHEMA_TYPE,
      __version:    SCHEMA_VERSION,
      dynamicEdges,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._dynamicEdges = new LRUMap(this._config.maxDynamicEdges);
    if (Array.isArray(snap.dynamicEdges)) {
      for (const [k, v] of snap.dynamicEdges) {
        this._dynamicEdges.set(k, v);
      }
    }
    return true;
  }

  getDiagnostics() {
    return {
      staticEdgeCount:   STATIC_EDGES.length,
      dynamicEdgeCount:  this._dynamicEdges.size,
      maxDynamicEdges:   this._config.maxDynamicEdges,
      disposed:          this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ComplementGraphEngine,
  RELATIONSHIP_TYPES,
  STATIC_EDGES,
};
