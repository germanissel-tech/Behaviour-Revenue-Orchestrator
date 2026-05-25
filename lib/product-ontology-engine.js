'use strict';

/**
 * product-ontology-engine.js
 *
 * SINGLE AUTHORITY for product normalization and attribute resolution.
 *
 * Responsibilities:
 *  - Normalize raw product data into a canonical OntologyRecord.
 *  - Resolve category, subcategory, usage context, compatibility tags,
 *    product archetypes, and return-risk factors.
 *  - Maintain a bounded LRU cache of resolved records.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO external APIs, no scraping, no LLMs.
 *  - Fully deterministic, cacheable, replay-safe.
 *  - Bounded memory — LRU cache capped at maxRecords.
 *  - snapshot() / restore() — full replay support.
 *  - cleanup() / dispose() — explicit lifecycle.
 *  - No hidden side effects. No implicit globals.
 *
 * Authority: NORMALIZE only. Does NOT decide. Does NOT rank. Does NOT block.
 *
 * Integration:
 *  - Called by complement-graph-engine, intent-completion-engine,
 *    compatibility-intelligence-engine, return-risk-intelligence-engine.
 *  - The session-orchestrator may inject it as a dependency to the
 *    relationship-message-strategy-engine via enrichment context.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

/** Canonical product categories */
const CATEGORIES = Object.freeze({
  FOOD:          'food',
  ELECTRONICS:   'electronics',
  FASHION:       'fashion',
  BEAUTY:        'beauty',
  HOME:          'home',
  SPORTS:        'sports',
  BOOKS:         'books',
  TOYS:          'toys',
  AUTOMOTIVE:    'automotive',
  PETS:          'pets',
  HEALTH:        'health',
  GAMING:        'gaming',
  PHOTOGRAPHY:   'photography',
  AUDIO:         'audio',
  COMPUTING:     'computing',
  UNKNOWN:       'unknown',
});

/** Product archetypes — functional role of the product in a use-case */
const ARCHETYPES = Object.freeze({
  PRIMARY:         'primary',         // Main product (e.g., pasta, camera, monitor)
  COMPLEMENT:      'complement',      // Required or strongly suggested companion (sauce, SD card, cable)
  ACCESSORY:       'accessory',       // Enhances but not required (bag, stand, skin)
  CONSUMABLE:      'consumable',      // Replenishable use (ink cartridge, coffee pods)
  SETUP_COMPONENT: 'setup_component', // Part of a multi-piece required setup (RAM in a PC)
  SUBSTITUTE:      'substitute',      // Alternative to another product
  BUNDLE_ANCHOR:   'bundle_anchor',   // Product that defines a bundle (console, kit)
  UNKNOWN:         'unknown',
});

/** Usage contexts where a product applies */
const USAGE_CONTEXTS = Object.freeze({
  COOKING:         'cooking',
  GAMING:          'gaming',
  PHOTOGRAPHY:     'photography',
  FITNESS:         'fitness',
  OFFICE:          'office',
  TRAVEL:          'travel',
  HOME_DECOR:      'home_decor',
  ENTERTAINMENT:   'entertainment',
  FASHION_OUTFIT:  'fashion_outfit',
  SKINCARE_ROUTINE:'skincare_routine',
  AUDIO_SETUP:     'audio_setup',
  COMPUTING_SETUP: 'computing_setup',
  UNKNOWN:         'unknown',
});

/** Return-risk factor types */
const RETURN_RISK_FACTORS = Object.freeze({
  SIZE_DEPENDENT:      'size_dependent',      // Fit or taille uncertainty
  COMPATIBILITY_RISK:  'compatibility_risk',  // May not be compatible with existing items
  AESTHETIC_MISMATCH:  'aesthetic_mismatch',  // Color/style may not match context
  TECHNICAL_MISMATCH:  'technical_mismatch',  // Spec mismatch (e.g., wrong port standard)
  MISSING_COMPONENT:   'missing_component',   // Product is incomplete without accessory
  FRAGILE:             'fragile',             // High breakage risk in transit
  CONSUMABLE_GUESS:    'consumable_guess',    // Consumable bought without confirmed device
  SUBJECTIVE_FIT:      'subjective_fit',      // Taste/preference dependent (perfume, art)
});

// ============================================================================
// Category detection rules
// Rule: { keywords[], category, subcategory, archetype, usageContexts[], compatibilityTags[], returnRiskFactors[] }
// Rules are ordered by specificity. First match wins.
// ============================================================================

const DETECTION_RULES = Object.freeze([
  // ── FOOD ──────────────────────────────────────────────────────────────────
  {
    keywords: ['pasta', 'fideos', 'spaghetti', 'penne', 'rigatoni', 'tallarines', 'macarrones'],
    category: CATEGORIES.FOOD, subcategory: 'dry_pasta',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.COOKING],
    compatibilityTags: ['meal:italian', 'needs:sauce', 'needs:cheese'],
    returnRiskFactors: [],
  },
  {
    keywords: ['salsa', 'tomato sauce', 'pasta sauce', 'ragú', 'ragu', 'pesto', 'bolognese', 'carbonara'],
    category: CATEGORIES.FOOD, subcategory: 'sauce',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COOKING],
    compatibilityTags: ['meal:italian', 'complements:dry_pasta'],
    returnRiskFactors: [],
  },
  {
    keywords: ['queso rallado', 'parmesano', 'parmesan', 'grana padano', 'pecorino', 'queso pasta'],
    category: CATEGORIES.FOOD, subcategory: 'grated_cheese',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COOKING],
    compatibilityTags: ['meal:italian', 'complements:dry_pasta', 'complements:sauce'],
    returnRiskFactors: [],
  },
  {
    keywords: ['aceite de oliva', 'olive oil', 'oliva'],
    category: CATEGORIES.FOOD, subcategory: 'cooking_oil',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COOKING],
    compatibilityTags: ['meal:italian', 'meal:mediterranean'],
    returnRiskFactors: [],
  },
  {
    keywords: ['vino', 'wine', 'tinto', 'blanco', 'rosé', 'champagne', 'espumante'],
    category: CATEGORIES.FOOD, subcategory: 'beverage_wine',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COOKING, USAGE_CONTEXTS.ENTERTAINMENT],
    compatibilityTags: ['meal:dining', 'complements:gourmet_food'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['café', 'coffee', 'espresso', 'capuccino', 'latte', 'nespresso capsules', 'cápsulas'],
    category: CATEGORIES.FOOD, subcategory: 'coffee',
    archetype: ARCHETYPES.CONSUMABLE,
    usageContexts: [USAGE_CONTEXTS.COOKING],
    compatibilityTags: ['needs:coffee_machine'],
    returnRiskFactors: [RETURN_RISK_FACTORS.CONSUMABLE_GUESS],
  },

  // ── ELECTRONICS / DISPLAY ────────────────────────────────────────────────
  {
    keywords: ['monitor', 'pantalla', 'display', 'screen', '4k monitor', 'gaming monitor'],
    category: CATEGORIES.ELECTRONICS, subcategory: 'monitor',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.GAMING, USAGE_CONTEXTS.COMPUTING_SETUP, USAGE_CONTEXTS.OFFICE],
    compatibilityTags: ['needs:display_cable', 'needs:monitor_stand', 'output:hdmi', 'output:displayport'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.TECHNICAL_MISMATCH],
  },
  {
    keywords: ['hdmi', 'hdmi cable', 'cable hdmi', 'displayport', 'dp cable', 'vga cable', 'usb-c video'],
    category: CATEGORIES.ELECTRONICS, subcategory: 'display_cable',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.GAMING, USAGE_CONTEXTS.COMPUTING_SETUP],
    compatibilityTags: ['complements:monitor', 'complements:tv', 'output:hdmi', 'output:displayport', 'connector_type'],
    returnRiskFactors: [RETURN_RISK_FACTORS.TECHNICAL_MISMATCH],
  },
  {
    keywords: ['monitor stand', 'monitor arm', 'soporte monitor', 'brazo monitor', 'monitor mount'],
    category: CATEGORIES.ELECTRONICS, subcategory: 'monitor_stand',
    archetype: ARCHETYPES.ACCESSORY,
    usageContexts: [USAGE_CONTEXTS.COMPUTING_SETUP, USAGE_CONTEXTS.OFFICE],
    compatibilityTags: ['complements:monitor', 'size_constraint'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.SIZE_DEPENDENT],
  },

  // ── GAMING ───────────────────────────────────────────────────────────────
  {
    keywords: ['consola', 'console', 'playstation', 'ps5', 'ps4', 'xbox', 'nintendo switch', 'gaming console'],
    category: CATEGORIES.GAMING, subcategory: 'gaming_console',
    archetype: ARCHETYPES.BUNDLE_ANCHOR,
    usageContexts: [USAGE_CONTEXTS.GAMING, USAGE_CONTEXTS.ENTERTAINMENT],
    compatibilityTags: ['needs:controller', 'needs:game', 'output:hdmi', 'ecosystem:console'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },
  {
    keywords: ['control', 'controller', 'mando', 'gamepad', 'joystick'],
    category: CATEGORIES.GAMING, subcategory: 'controller',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.GAMING],
    compatibilityTags: ['complements:gaming_console', 'ecosystem:console'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },
  {
    keywords: ['juego', 'game', 'videogame', 'videojuego', 'titulo', 'dlc'],
    category: CATEGORIES.GAMING, subcategory: 'game_title',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.GAMING],
    compatibilityTags: ['complements:gaming_console', 'ecosystem:console'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['headset gamer', 'auricular gamer', 'gaming headset', 'audifonos gamer'],
    category: CATEGORIES.GAMING, subcategory: 'gaming_headset',
    archetype: ARCHETYPES.ACCESSORY,
    usageContexts: [USAGE_CONTEXTS.GAMING, USAGE_CONTEXTS.AUDIO_SETUP],
    compatibilityTags: ['complements:gaming_console', 'complements:pc_gaming', 'connector:jack35', 'connector:usb'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },

  // ── PHOTOGRAPHY ──────────────────────────────────────────────────────────
  {
    keywords: ['cámara', 'camara', 'camera', 'dslr', 'mirrorless', 'reflex', 'compacta'],
    category: CATEGORIES.PHOTOGRAPHY, subcategory: 'camera_body',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.PHOTOGRAPHY],
    compatibilityTags: ['needs:memory_card', 'needs:battery', 'needs:lens', 'mount_type'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.MISSING_COMPONENT],
  },
  {
    keywords: ['tarjeta sd', 'sd card', 'memoria sd', 'microsd', 'cf card', 'xqd', 'cfexpress', 'memoria flash'],
    category: CATEGORIES.PHOTOGRAPHY, subcategory: 'memory_card',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.PHOTOGRAPHY],
    compatibilityTags: ['complements:camera_body', 'complements:drone', 'storage_class', 'speed_class'],
    returnRiskFactors: [RETURN_RISK_FACTORS.TECHNICAL_MISMATCH, RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },
  {
    keywords: ['lente', 'lens', 'objetivo', 'teleobjetivo', '50mm', '35mm', '24-70', 'gran angular'],
    category: CATEGORIES.PHOTOGRAPHY, subcategory: 'camera_lens',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.PHOTOGRAPHY],
    compatibilityTags: ['complements:camera_body', 'mount_type'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.TECHNICAL_MISMATCH],
  },
  {
    keywords: ['tripode', 'tripod', 'monopie', 'gorilla pod', 'soporte foto'],
    category: CATEGORIES.PHOTOGRAPHY, subcategory: 'camera_support',
    archetype: ARCHETYPES.ACCESSORY,
    usageContexts: [USAGE_CONTEXTS.PHOTOGRAPHY],
    compatibilityTags: ['complements:camera_body'],
    returnRiskFactors: [],
  },

  // ── FASHION ──────────────────────────────────────────────────────────────
  {
    keywords: ['sweater', 'suéter', 'buzo', 'pullover', 'jersey', 'saco de lana'],
    category: CATEGORIES.FASHION, subcategory: 'knitwear',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.FASHION_OUTFIT],
    compatibilityTags: ['needs:bottom_layer', 'style:casual', 'style:smart_casual', 'talle_dependent'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SIZE_DEPENDENT, RETURN_RISK_FACTORS.AESTHETIC_MISMATCH],
  },
  {
    keywords: ['jean', 'jeans', 'pantalón', 'pantalon', 'chino', 'trouser', 'pants'],
    category: CATEGORIES.FASHION, subcategory: 'bottoms',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.FASHION_OUTFIT],
    compatibilityTags: ['complements:knitwear', 'complements:shirt', 'talle_dependent', 'style:casual', 'style:smart_casual'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SIZE_DEPENDENT, RETURN_RISK_FACTORS.AESTHETIC_MISMATCH],
  },
  {
    keywords: ['remera', 'camiseta', 'tshirt', 't-shirt', 'blusa', 'camisa', 'shirt'],
    category: CATEGORIES.FASHION, subcategory: 'shirt',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.FASHION_OUTFIT],
    compatibilityTags: ['complements:knitwear', 'complements:bottoms', 'layer:base'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SIZE_DEPENDENT, RETURN_RISK_FACTORS.AESTHETIC_MISMATCH],
  },
  {
    keywords: ['zapatillas', 'zapatilla', 'sneaker', 'zapato', 'calzado', 'bota', 'shoe', 'shoes'],
    category: CATEGORIES.FASHION, subcategory: 'footwear',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.FASHION_OUTFIT, USAGE_CONTEXTS.FITNESS],
    compatibilityTags: ['complements:bottoms', 'talle_dependent', 'style:footwear'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SIZE_DEPENDENT],
  },
  {
    keywords: ['campera', 'jacket', 'chaqueta', 'abrigo', 'parka', 'piloto', 'coat'],
    category: CATEGORIES.FASHION, subcategory: 'outerwear',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.FASHION_OUTFIT],
    compatibilityTags: ['complements:knitwear', 'complements:shirt', 'talle_dependent', 'layer:outer'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SIZE_DEPENDENT, RETURN_RISK_FACTORS.AESTHETIC_MISMATCH],
  },

  // ── BEAUTY / SKINCARE ─────────────────────────────────────────────────────
  {
    keywords: ['perfume', 'fragancia', 'eau de parfum', 'edp', 'edt', 'cologne', 'colonia', 'aroma'],
    category: CATEGORIES.BEAUTY, subcategory: 'fragrance',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['needs:skin_prep', 'style:fragrance', 'complementary_scent'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['crema hidratante', 'moisturizer', 'hidratante', 'body lotion', 'locion corporal'],
    category: CATEGORIES.BEAUTY, subcategory: 'moisturizer',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['complements:fragrance', 'layer:skincare_base', 'skin_type'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT, RETURN_RISK_FACTORS.AESTHETIC_MISMATCH],
  },
  {
    keywords: ['sérum', 'serum', 'vitamina c', 'hyaluronic', 'retinol', 'niacinamide'],
    category: CATEGORIES.BEAUTY, subcategory: 'serum',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['layer:skincare_active', 'skin_type', 'needs:moisturizer_after'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['protector solar', 'sunscreen', 'spf', 'fps'],
    category: CATEGORIES.BEAUTY, subcategory: 'sunscreen',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['layer:skincare_final', 'complements:serum', 'complements:moisturizer'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['limpiador facial', 'cleanser', 'espuma limpiadora', 'gel limpiador', 'tónico'],
    category: CATEGORIES.BEAUTY, subcategory: 'cleanser',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['layer:skincare_first', 'skin_type'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['máscara led', 'led mask', 'foreo', 'dispositivo facial', 'beauty device'],
    category: CATEGORIES.BEAUTY, subcategory: 'beauty_device',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.SKINCARE_ROUTINE],
    compatibilityTags: ['needs:serum', 'needs:cleanser', 'needs:moisturizer'],
    returnRiskFactors: [RETURN_RISK_FACTORS.TECHNICAL_MISMATCH, RETURN_RISK_FACTORS.MISSING_COMPONENT],
  },

  // ── AUDIO ─────────────────────────────────────────────────────────────────
  {
    keywords: ['auriculares', 'auricular', 'headphones', 'earbuds', 'airpods', 'inalámbrico wireless'],
    category: CATEGORIES.AUDIO, subcategory: 'headphones',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.AUDIO_SETUP, USAGE_CONTEXTS.ENTERTAINMENT],
    compatibilityTags: ['connector:jack35', 'connector:usb', 'connector:bluetooth', 'needs:case'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT, RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },
  {
    keywords: ['parlante', 'speaker', 'altavoz', 'bocina', 'subwoofer', 'soundbar'],
    category: CATEGORIES.AUDIO, subcategory: 'speaker',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [USAGE_CONTEXTS.AUDIO_SETUP, USAGE_CONTEXTS.ENTERTAINMENT],
    compatibilityTags: ['connector:bluetooth', 'connector:rca', 'output:audio', 'needs:amplifier_maybe'],
    returnRiskFactors: [RETURN_RISK_FACTORS.SUBJECTIVE_FIT, RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },

  // ── COMPUTING ─────────────────────────────────────────────────────────────
  {
    keywords: ['teclado', 'keyboard', 'mechanical keyboard', 'teclado mecánico'],
    category: CATEGORIES.COMPUTING, subcategory: 'keyboard',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COMPUTING_SETUP, USAGE_CONTEXTS.OFFICE],
    compatibilityTags: ['complements:monitor', 'connector:usb', 'connector:bluetooth'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK, RETURN_RISK_FACTORS.SUBJECTIVE_FIT],
  },
  {
    keywords: ['mouse', 'ratón', 'raton', 'trackpad', 'trackball'],
    category: CATEGORIES.COMPUTING, subcategory: 'mouse',
    archetype: ARCHETYPES.COMPLEMENT,
    usageContexts: [USAGE_CONTEXTS.COMPUTING_SETUP, USAGE_CONTEXTS.OFFICE, USAGE_CONTEXTS.GAMING],
    compatibilityTags: ['complements:monitor', 'complements:keyboard', 'connector:usb', 'connector:bluetooth'],
    returnRiskFactors: [RETURN_RISK_FACTORS.COMPATIBILITY_RISK],
  },

  // ── PETS ──────────────────────────────────────────────────────────────────
  {
    keywords: ['comida para perro', 'dog food', 'alimento perro', 'croquetas perro', 'pedigree'],
    category: CATEGORIES.PETS, subcategory: 'dog_food',
    archetype: ARCHETYPES.PRIMARY,
    usageContexts: [],
    compatibilityTags: ['needs:water_bowl', 'needs:food_bowl'],
    returnRiskFactors: [RETURN_RISK_FACTORS.CONSUMABLE_GUESS],
  },
]);

const DEFAULT_ONTOLOGY_RECORD = Object.freeze({
  productId: null,
  category: CATEGORIES.UNKNOWN,
  subcategory: 'unknown',
  archetype: ARCHETYPES.UNKNOWN,
  usageContexts: [],
  compatibilityTags: [],
  returnRiskFactors: [],
  attributes: {},
  confidence: 0,
  resolvedAt: null,
  resolvedFromRule: null,
});

const DEFAULT_CONFIG = Object.freeze({
  maxRecords: 2048,
  // Minimum token match count to consider a rule matched
  minMatchTokens: 1,
});

const SCHEMA_TYPE = 'ProductOntologyEngine';

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`ProductOntologyEngine: ${label} must be a finite number, got ${val}`);
  }
}

/**
 * Minimal LRU Map (insertion-order, same pattern as session-orchestrator).
 */
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
 * Match a product's text tokens against a detection rule.
 * Returns the number of keyword tokens found.
 */
function _matchRule(text, rule) {
  if (!text || !rule.keywords || rule.keywords.length === 0) return 0;
  let matches = 0;
  for (const kw of rule.keywords) {
    if (text.includes(kw)) matches++;
  }
  return matches;
}

/**
 * Build a normalized text string from a raw product input.
 */
function _buildSearchText(rawProduct) {
  if (!rawProduct || typeof rawProduct !== 'object') return '';
  return [
    rawProduct.name || '',
    rawProduct.category || '',
    rawProduct.subcategory || '',
    rawProduct.description || '',
    Array.isArray(rawProduct.tags) ? rawProduct.tags.join(' ') : (rawProduct.tags || ''),
  ].join(' ').toLowerCase();
}

// ============================================================================
// ProductOntologyEngine
// ============================================================================

class ProductOntologyEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.maxRecords=2048]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    /** @type {LRUMap<string, OntologyRecord>} productId -> resolved record */
    this._cache = new LRUMap(this._config.maxRecords);
    this._resolvedCount = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Resolve a product into a canonical OntologyRecord.
   * If the productId was already resolved, returns from cache (O(1)).
   *
   * @param {object} rawProduct — { productId, name, category?, subcategory?, description?, tags?, attributes? }
   * @param {number} nowMs — injected clock
   * @returns {OntologyRecord}
   */
  resolve(rawProduct, nowMs) {
    _assertFiniteNumber(nowMs, 'resolve.nowMs');
    if (this._disposed) throw new Error('ProductOntologyEngine: disposed');
    if (!rawProduct || typeof rawProduct !== 'object') {
      return { ...DEFAULT_ONTOLOGY_RECORD, resolvedAt: nowMs };
    }

    const productId = String(rawProduct.productId || rawProduct.id || '');

    // Cache hit
    if (productId && this._cache.has(productId)) {
      return this._cache.get(productId);
    }

    // Detect from rules
    const text = _buildSearchText(rawProduct);
    let bestRule = null;
    let bestMatchCount = 0;

    for (const rule of DETECTION_RULES) {
      const matchCount = _matchRule(text, rule);
      if (matchCount > bestMatchCount) {
        bestMatchCount = matchCount;
        bestRule = rule;
      }
    }

    // Build record
    const record = {
      productId: productId || null,
      category:          bestRule ? bestRule.category          : CATEGORIES.UNKNOWN,
      subcategory:       bestRule ? bestRule.subcategory        : 'unknown',
      archetype:         bestRule ? bestRule.archetype          : ARCHETYPES.UNKNOWN,
      usageContexts:     bestRule ? [...bestRule.usageContexts] : [],
      compatibilityTags: bestRule ? [...bestRule.compatibilityTags] : [],
      returnRiskFactors: bestRule ? [...bestRule.returnRiskFactors] : [],
      attributes:        rawProduct.attributes && typeof rawProduct.attributes === 'object'
        ? Object.freeze({ ...rawProduct.attributes })
        : {},
      confidence:        bestMatchCount > 0 ? Math.min(1, bestMatchCount / (bestRule.keywords.length * 0.5)) : 0,
      resolvedAt:        nowMs,
      resolvedFromRule:  bestRule ? bestRule.subcategory : null,
    };

    Object.freeze(record);

    if (productId) {
      this._cache.set(productId, record);
    }
    this._resolvedCount++;

    return record;
  }

  /**
   * Batch-resolve multiple products. Returns array of OntologyRecords
   * in the same order as input.
   *
   * @param {object[]} rawProducts
   * @param {number} nowMs
   * @returns {OntologyRecord[]}
   */
  resolveBatch(rawProducts, nowMs) {
    _assertFiniteNumber(nowMs, 'resolveBatch.nowMs');
    if (!Array.isArray(rawProducts)) return [];
    return rawProducts.map(p => this.resolve(p, nowMs));
  }

  /**
   * Invalidate a cached record (force re-resolution on next call).
   * @param {string} productId
   */
  invalidate(productId) {
    if (!productId) return;
    this._cache.delete(String(productId));
  }

  /**
   * Retrieve a cached record without resolving.
   * Returns null if not cached.
   *
   * @param {string} productId
   * @returns {OntologyRecord|null}
   */
  getCached(productId) {
    if (!productId) return null;
    return this._cache.get(String(productId)) || null;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // Nothing time-sensitive to purge; cache is LRU-bounded.
    // Provided for interface parity with other engines.
  }

  dispose() {
    this._disposed = true;
    this._cache.clear();
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    const cacheEntries = [];
    for (const [k, v] of this._cache.entries()) {
      cacheEntries.push([k, v]);
    }
    return {
      __type: SCHEMA_TYPE,
      __version: SCHEMA_VERSION,
      resolvedCount: this._resolvedCount,
      cache: cacheEntries,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._resolvedCount = typeof snap.resolvedCount === 'number' ? snap.resolvedCount : 0;
    this._cache = new LRUMap(this._config.maxRecords);

    if (Array.isArray(snap.cache)) {
      for (const [k, v] of snap.cache) {
        this._cache.set(k, v);
      }
    }
    return true;
  }

  getDiagnostics() {
    return {
      cacheSize:     this._cache.size,
      maxRecords:    this._config.maxRecords,
      resolvedCount: this._resolvedCount,
      disposed:      this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ProductOntologyEngine,
  CATEGORIES,
  ARCHETYPES,
  USAGE_CONTEXTS,
  RETURN_RISK_FACTORS,
  DETECTION_RULES,
};
