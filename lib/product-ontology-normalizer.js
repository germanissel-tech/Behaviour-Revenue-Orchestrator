'use strict';

/**
 * product-ontology-normalizer.js (PHASE 1)
 *
 * ONTOLOGY NORMALIZATION HARDENING — Canonical Product Type Resolution
 *
 * This module extends product-ontology-engine with:
 *   - canonicalProductType resolution
 *   - categoryNormalization
 *   - Multilingual aliases
 *   - Confidence scoring for matches
 *
 * Design guarantees:
 *   - NO Date.now() — all timestamps from injected nowMs
 *   - NO external APIs, no LLMs
 *   - Fully deterministic, replay-safe
 *   - Bounded memory via LRU cache
 *   - snapshot() / restore() for full replay support
 *
 * Authority: NORMALIZE only. Does NOT decide.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE = 'ProductOntologyNormalizer';

// ============================================================================
// CANONICAL PRODUCT TYPES with multilingual ALIASES
// Each type has:
//   - canonicalType: the normalized product type
//   - category: parent category
//   - aliases: multilingual variations
//   - confidence_floor: minimum confidence for this type
// ============================================================================

const CANONICAL_PRODUCT_TYPES = Object.freeze({
  // ── FOOD: Pasta family ─────────────────────────────────────────────────────
  hamburger_patty: {
    canonicalType: 'hamburger_patty',
    category: 'food',
    subcategory: 'meat',
    aliases: Object.freeze([
      'burger', 'patty', 'hamburguesa', 'medallón', 'burger meat',
      'hamburger', 'patties', 'beef patty', 'carne hamburguesa',
      'medallones', 'meat patty', 'burger patties',
    ]),
    confidenceFloor: 0.75,
  },
  burger_bun: {
    canonicalType: 'burger_bun',
    category: 'food',
    subcategory: 'bakery',
    aliases: Object.freeze([
      'bun', 'burger bun', 'pan hamburguesa', 'brioche',
      'hamburger bun', 'panecillo', 'pan de hamburguesa',
      'buns', 'bread bun', 'sesame bun',
    ]),
    confidenceFloor: 0.70,
  },
  dry_pasta: {
    canonicalType: 'dry_pasta',
    category: 'food',
    subcategory: 'pasta',
    aliases: Object.freeze([
      'pasta', 'fideos', 'spaghetti', 'penne', 'rigatoni',
      'tallarines', 'macarrones', 'fettuccine', 'linguine',
      'farfalle', 'fusilli', 'tagliatelle', 'lasagna sheets',
      'noodles', 'dry noodles', 'espagueti', 'macaroni',
    ]),
    confidenceFloor: 0.80,
  },
  pasta_sauce: {
    canonicalType: 'pasta_sauce',
    category: 'food',
    subcategory: 'sauce',
    aliases: Object.freeze([
      'salsa', 'tomato sauce', 'pasta sauce', 'ragú', 'ragu',
      'pesto', 'bolognese', 'carbonara', 'marinara', 'alfredo',
      'salsa de tomate', 'salsa para pasta', 'pomodoro',
      'arrabbiata', 'sauce', 'red sauce',
    ]),
    confidenceFloor: 0.75,
  },
  grated_cheese: {
    canonicalType: 'grated_cheese',
    category: 'food',
    subcategory: 'dairy',
    aliases: Object.freeze([
      'queso rallado', 'parmesano', 'parmesan', 'grana padano',
      'pecorino', 'queso pasta', 'grated parmesan', 'romano',
      'queso parmesano', 'parmigiano', 'cheese grated',
      'shredded cheese', 'queso rayado',
    ]),
    confidenceFloor: 0.75,
  },
  french_fries: {
    canonicalType: 'french_fries',
    category: 'food',
    subcategory: 'prepared',
    aliases: Object.freeze([
      'fries', 'papas fritas', 'french fries', 'chips',
      'patatas fritas', 'papas', 'frites', 'potato fries',
      'papas congeladas', 'frozen fries', 'crispy fries',
    ]),
    confidenceFloor: 0.75,
  },
  soft_drink: {
    canonicalType: 'soft_drink',
    category: 'food',
    subcategory: 'beverage',
    aliases: Object.freeze([
      'soda', 'refresco', 'gaseosa', 'coca cola', 'pepsi',
      'sprite', 'fanta', 'soft drink', 'carbonated drink',
      'bebida', 'cola', 'pop', 'fizzy drink',
    ]),
    confidenceFloor: 0.70,
  },
  coffee: {
    canonicalType: 'coffee',
    category: 'food',
    subcategory: 'beverage',
    aliases: Object.freeze([
      'café', 'coffee', 'espresso', 'cappuccino', 'latte',
      'nespresso', 'cápsulas', 'coffee pods', 'ground coffee',
      'café molido', 'instant coffee', 'café instantáneo',
      'coffee beans', 'granos de café',
    ]),
    confidenceFloor: 0.75,
  },

  // ── ELECTRONICS ────────────────────────────────────────────────────────────
  camera_body: {
    canonicalType: 'camera_body',
    category: 'photography',
    subcategory: 'camera',
    aliases: Object.freeze([
      'cámara', 'camara', 'camera', 'dslr', 'mirrorless',
      'reflex', 'compacta', 'digital camera', 'cámara digital',
      'camera body', 'cuerpo cámara', 'body camera',
    ]),
    confidenceFloor: 0.80,
  },
  memory_card: {
    canonicalType: 'memory_card',
    category: 'photography',
    subcategory: 'storage',
    aliases: Object.freeze([
      'tarjeta sd', 'sd card', 'memoria sd', 'microsd',
      'cf card', 'xqd', 'cfexpress', 'memoria flash',
      'memory card', 'tarjeta de memoria', 'sd', 'micro sd',
      'storage card', 'flash card',
    ]),
    confidenceFloor: 0.80,
  },
  monitor: {
    canonicalType: 'monitor',
    category: 'electronics',
    subcategory: 'display',
    aliases: Object.freeze([
      'monitor', 'pantalla', 'display', 'screen',
      '4k monitor', 'gaming monitor', 'led monitor',
      'lcd monitor', 'curved monitor', 'ultrawide',
    ]),
    confidenceFloor: 0.85,
  },
  hdmi_cable: {
    canonicalType: 'hdmi_cable',
    category: 'electronics',
    subcategory: 'cable',
    aliases: Object.freeze([
      'hdmi', 'hdmi cable', 'cable hdmi', 'hdmi 2.1',
      'hdmi cord', 'cable de video', 'high speed hdmi',
    ]),
    confidenceFloor: 0.85,
  },

  // ── FASHION ────────────────────────────────────────────────────────────────
  shirt: {
    canonicalType: 'shirt',
    category: 'fashion',
    subcategory: 'tops',
    aliases: Object.freeze([
      'remera', 'camiseta', 'tshirt', 't-shirt', 'blusa',
      'camisa', 'shirt', 'polo', 'top', 'playera',
      'polera', 'franela',
    ]),
    confidenceFloor: 0.70,
  },
  pants: {
    canonicalType: 'pants',
    category: 'fashion',
    subcategory: 'bottoms',
    aliases: Object.freeze([
      'jean', 'jeans', 'pantalón', 'pantalon', 'chino',
      'trouser', 'pants', 'pantalones', 'vaqueros',
      'denim', 'slacks', 'khakis',
    ]),
    confidenceFloor: 0.70,
  },
  shoes: {
    canonicalType: 'shoes',
    category: 'fashion',
    subcategory: 'footwear',
    aliases: Object.freeze([
      'zapatillas', 'zapatilla', 'sneaker', 'zapato',
      'calzado', 'bota', 'shoe', 'shoes', 'sneakers',
      'tenis', 'deportivas', 'running shoes',
    ]),
    confidenceFloor: 0.70,
  },
});

// Build reverse lookup: alias -> canonicalType
const ALIAS_TO_CANONICAL = (() => {
  const map = new Map();
  for (const [type, data] of Object.entries(CANONICAL_PRODUCT_TYPES)) {
    for (const alias of data.aliases) {
      const normalizedAlias = alias.toLowerCase().trim();
      // If collision, prefer more specific type (longer alias wins)
      if (!map.has(normalizedAlias) || alias.length > (map.get(normalizedAlias).matchedAlias?.length || 0)) {
        map.set(normalizedAlias, { canonicalType: type, data });
      }
    }
  }
  return map;
})();

// ============================================================================
// Category normalization mapping
// ============================================================================

const CATEGORY_NORMALIZATION = Object.freeze({
  // Food variations
  'food': 'food',
  'comida': 'food',
  'alimentos': 'food',
  'delivery': 'food',

  // Grocery (separate from food)
  'grocery': 'grocery',
  'groceries': 'grocery',
  'supermercado': 'grocery',
  'abarrotes': 'grocery',

  // Electronics
  'electronics': 'electronics',
  'electrónica': 'electronics',
  'electronica': 'electronics',
  'tech': 'electronics',
  'technology': 'electronics',
  'tecnología': 'electronics',

  // Fashion
  'fashion': 'fashion',
  'moda': 'fashion',
  'ropa': 'fashion',
  'clothing': 'fashion',
  'apparel': 'fashion',
  'vestimenta': 'fashion',

  // Beauty
  'beauty': 'beauty',
  'belleza': 'beauty',
  'cosmetics': 'beauty',
  'cosméticos': 'beauty',
  'skincare': 'beauty',
  'cuidado personal': 'beauty',

  // Photography
  'photography': 'photography',
  'fotografía': 'photography',
  'photo': 'photography',
  'cameras': 'photography',
  'cámaras': 'photography',

  // Gaming
  'gaming': 'gaming',
  'videojuegos': 'gaming',
  'games': 'gaming',
  'juegos': 'gaming',

  // Computing
  'computing': 'computing',
  'computers': 'computing',
  'computación': 'computing',
  'informática': 'computing',
  'pc': 'computing',

  // Audio
  'audio': 'audio',
  'music': 'audio',
  'música': 'audio',
  'sound': 'audio',
  'sonido': 'audio',
});

const DEFAULT_CONFIG = Object.freeze({
  maxCacheSize: 2048,
  minAliasMatchLength: 3,
  partialMatchMinRatio: 0.7,
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
// ProductOntologyNormalizer
// ============================================================================

class ProductOntologyNormalizer {
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._cache = new LRUMap(this._config.maxCacheSize);
    this._normalizedCount = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API: normalizeProduct
  // ==========================================================================

  /**
   * Normalize a product into canonical form with confidence scoring.
   *
   * @param {object} rawProduct - { name, category?, description?, tags? }
   * @param {number} nowMs - injected timestamp
   * @returns {NormalizationResult}
   *
   * NormalizationResult: {
   *   canonicalType: string | null,
   *   normalizedCategory: string,
   *   confidence: number (0-1),
   *   matchedAlias: string | null,
   *   source: 'exact_alias' | 'partial_alias' | 'category_only' | 'unknown',
   *   rationale: string[],
   * }
   */
  normalizeProduct(rawProduct, nowMs) {
    this._assertAlive();
    this._assertFiniteNumber(nowMs, 'normalizeProduct.nowMs');

    if (!rawProduct || typeof rawProduct !== 'object') {
      return this._buildResult(null, 'unknown', 0, null, 'unknown', ['invalid_input']);
    }

    // Build cache key
    const cacheKey = this._buildCacheKey(rawProduct);
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    // Extract searchable text
    const searchText = this._buildSearchText(rawProduct);
    const categoryRaw = rawProduct.category || '';

    // Step 1: Try exact alias match
    const exactMatch = this._findExactAliasMatch(searchText);
    if (exactMatch) {
      const result = this._buildResult(
        exactMatch.canonicalType,
        exactMatch.data.category,
        this._computeConfidence(exactMatch, searchText, 'exact'),
        exactMatch.matchedAlias,
        'exact_alias',
        [`exact_match:${exactMatch.matchedAlias}`]
      );
      this._cacheResult(cacheKey, result);
      return result;
    }

    // Step 2: Try partial alias match
    const partialMatch = this._findPartialAliasMatch(searchText);
    if (partialMatch && partialMatch.confidence >= this._config.partialMatchMinRatio) {
      const result = this._buildResult(
        partialMatch.canonicalType,
        partialMatch.data.category,
        this._computeConfidence(partialMatch, searchText, 'partial'),
        partialMatch.matchedAlias,
        'partial_alias',
        [`partial_match:${partialMatch.matchedAlias}:${partialMatch.confidence.toFixed(2)}`]
      );
      this._cacheResult(cacheKey, result);
      return result;
    }

    // Step 3: Normalize category only
    const normalizedCategory = this._normalizeCategory(categoryRaw);
    if (normalizedCategory !== 'unknown') {
      const result = this._buildResult(
        null,
        normalizedCategory,
        0.3, // Low confidence - category only
        null,
        'category_only',
        [`category_normalized:${categoryRaw}->${normalizedCategory}`]
      );
      this._cacheResult(cacheKey, result);
      return result;
    }

    // Step 4: Unknown
    const result = this._buildResult(null, 'unknown', 0, null, 'unknown', ['no_match_found']);
    this._cacheResult(cacheKey, result);
    return result;
  }

  /**
   * Normalize category string to canonical form.
   *
   * @param {string} category
   * @returns {string} normalized category
   */
  normalizeCategory(category) {
    return this._normalizeCategory(category);
  }

  /**
   * Get canonical product type data if available.
   *
   * @param {string} canonicalType
   * @returns {object|null}
   */
  getCanonicalTypeData(canonicalType) {
    return CANONICAL_PRODUCT_TYPES[canonicalType] || null;
  }

  /**
   * Check if a category allows automatic interventions (FOOD/GROCERY/DELIVERY only).
   *
   * @param {string} category
   * @returns {boolean}
   */
  allowsAutomaticIntervention(category) {
    const normalized = this._normalizeCategory(category);
    return ['food', 'grocery'].includes(normalized); // Only food/grocery
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  _buildSearchText(rawProduct) {
    return [
      rawProduct.name || '',
      rawProduct.description || '',
      Array.isArray(rawProduct.tags) ? rawProduct.tags.join(' ') : (rawProduct.tags || ''),
    ].join(' ').toLowerCase().trim();
  }

  _buildCacheKey(rawProduct) {
    const name = (rawProduct.name || '').toLowerCase().slice(0, 100);
    const category = (rawProduct.category || '').toLowerCase();
    return `${name}::${category}`;
  }

  _findExactAliasMatch(searchText) {
    const words = searchText.split(/\s+/).filter(w => w.length >= this._config.minAliasMatchLength);

    // Try multi-word phrases first (more specific)
    for (let len = Math.min(4, words.length); len >= 1; len--) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        const match = ALIAS_TO_CANONICAL.get(phrase);
        if (match) {
          return { ...match, matchedAlias: phrase };
        }
      }
    }

    return null;
  }

  _findPartialAliasMatch(searchText) {
    let bestMatch = null;
    let bestConfidence = 0;

    for (const [alias, data] of ALIAS_TO_CANONICAL.entries()) {
      if (alias.length < this._config.minAliasMatchLength) continue;

      // Check if alias appears as substring
      if (searchText.includes(alias)) {
        const confidence = alias.length / Math.max(searchText.length, 1);
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestMatch = { ...data, matchedAlias: alias, confidence };
        }
      }
    }

    return bestMatch;
  }

  _normalizeCategory(category) {
    if (!category || typeof category !== 'string') return 'unknown';
    const normalized = category.toLowerCase().trim();
    return CATEGORY_NORMALIZATION[normalized] || 'unknown';
  }

  _computeConfidence(match, searchText, matchType) {
    const typeData = match.data;
    const floor = typeData.confidenceFloor || 0.5;

    let confidence = floor;

    if (matchType === 'exact') {
      // Exact match: boost confidence
      confidence = Math.min(1, floor + 0.15);
    } else if (matchType === 'partial') {
      // Partial match: scale by match ratio
      const ratio = (match.matchedAlias?.length || 0) / Math.max(searchText.length, 1);
      confidence = floor * (0.7 + 0.3 * ratio);
    }

    return Math.round(confidence * 1000) / 1000;
  }

  _buildResult(canonicalType, normalizedCategory, confidence, matchedAlias, source, rationale) {
    this._normalizedCount++;
    return Object.freeze({
      canonicalType,
      normalizedCategory,
      confidence,
      matchedAlias,
      source,
      rationale: Object.freeze(rationale),
    });
  }

  _cacheResult(key, result) {
    this._cache.set(key, result);
  }

  _assertAlive() {
    if (this._disposed) {
      throw new Error('ProductOntologyNormalizer: instance has been disposed');
    }
  }

  _assertFiniteNumber(val, label) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      throw new TypeError(`ProductOntologyNormalizer: ${label} must be a finite number, got ${val}`);
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // LRU-bounded, no time-based purge needed
  }

  dispose() {
    this._disposed = true;
    this._cache.clear();
  }

  reset() {
    this._cache.clear();
    this._normalizedCount = 0;
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
      normalizedCount: this._normalizedCount,
      cache: cacheEntries,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._normalizedCount = typeof snap.normalizedCount === 'number' ? snap.normalizedCount : 0;
    this._cache.clear();

    if (Array.isArray(snap.cache)) {
      for (const [k, v] of snap.cache) {
        this._cache.set(k, v);
      }
    }
    return true;
  }

  getDiagnostics() {
    return {
      cacheSize: this._cache.size,
      maxCacheSize: this._config.maxCacheSize,
      normalizedCount: this._normalizedCount,
      disposed: this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ProductOntologyNormalizer,
  CANONICAL_PRODUCT_TYPES,
  CATEGORY_NORMALIZATION,
  ALIAS_TO_CANONICAL,
};
