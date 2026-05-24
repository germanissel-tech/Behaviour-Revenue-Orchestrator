'use strict';

/**
 * user-memory-engine.js
 *
 * USER MEMORY ENGINE — Memoria real de usuario para OPE.
 *
 * ============================================================================
 * DISEÑO
 * ============================================================================
 *
 * Dos capas de memoria ortogonales:
 *
 *   SHORT-TERM (scope: sesión actual)
 *     - ignoredProducts        Set de productIds ignorados esta sesión
 *     - recentInteractions     Cola FIFO de los últimos N eventos relevantes
 *     - sessionPatterns        Contadores de patrones: hesitations, revisits,
 *                              dismissals, cartAdds, exits
 *
 *   LONG-TERM (scope: userId, cross-sesión, TTL configurable)
 *     - purchaseCycles         Historial de compras con timestamp e intervalo
 *     - preferences            Categorías/tipos visitados y comprados
 *     - rejections             Productos/familias rechazados ≥ N veces
 *     - frequentCategories     Ranking por visitas y compras
 *     - behaviorPatterns       Resumen estadístico cross-sesión
 *
 * Reglas de diseño:
 *   - NO Date.now() — todo timestamp viene de `nowMs` inyectado
 *   - NO Math.random() — sin aleatoriedad
 *   - NO ML, NO embeddings, NO modelos
 *   - Reglas deterministas + estadísticas simples
 *   - Bounded: LRU en todos los stores
 *   - Replay-safe: snapshot() / restore()
 *   - Authority: MEMORY only — no decide, no interviene
 *
 * ============================================================================
 * INTEGRACIÓN
 * ============================================================================
 *
 *   - session-orchestrator puede leer getUserMemory() para enriquecer señales
 *   - experiment-engine puede registrar conversiones vía recordPurchase()
 *   - signal-derivation-engine puede leer getPurchaseCyclePrediction()
 *   - NADIE escribe directamente al store: solo a través de este engine
 */

// ============================================================================
// LRU Map
// ============================================================================

class LRUMap {
  constructor(cap) {
    this._cap = Math.max(1, cap | 0);
    this._map = new Map();
  }
  get size() { return this._map.size; }
  has(k) { return this._map.has(k); }
  get(k) {
    if (!this._map.has(k)) return undefined;
    const v = this._map.get(k); this._map.delete(k); this._map.set(k, v); return v;
  }
  peek(k) { return this._map.get(k); }
  set(k, v) {
    if (this._map.has(k)) this._map.delete(k);
    this._map.set(k, v);
    while (this._map.size > this._cap) this._map.delete(this._map.keys().next().value);
  }
  delete(k) { return this._map.delete(k); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  toArray() {
    const out = [];
    for (const [k, v] of this._map) out.push({ _key: k, ...v });
    return out;
  }
  loadFromArray(arr) {
    this._map.clear();
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const { _key, ...rest } = item;
      if (_key != null) this.set(_key, rest);
    }
  }
}

// ============================================================================
// Constants & Config
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 1;

const DEFAULT_CONFIG = Object.freeze({
  // Short-term
  maxRecentInteractions:     50,
  maxIgnoredProducts:        200,

  // Long-term TTL
  longTermTtlDays:           90,

  // Long-term bounds
  maxPurchaseCycles:         100,
  maxRejectionEntries:       500,
  maxCategoryEntries:        200,
  maxUserProfiles:           5000,

  // Rejection thresholds
  rejectionCountToSuppress:  2,   // ≥2 rechazos → suprimir
  skipCountToSuppress:       3,   // ≥3 skips    → suprimir

  // Cycle prediction
  minCyclesForPrediction:    2,

  // Cleanup
  cleanupIntervalMs:         5 * 60 * 1000,
});

// ============================================================================
// UserMemoryEngine
// ============================================================================

class UserMemoryEngine {
  /**
   * @param {object} [config]  Overrides DEFAULT_CONFIG
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._config = Object.freeze({
      ...this._config,
      longTermTtlMs: (this._config.longTermTtlDays || 90) * MS_PER_DAY,
    });

    // ── Short-term: keyed by sessionId
    // sessionId → ShortTermRecord
    this._shortTerm = new LRUMap(10000);

    // ── Long-term: keyed by userId
    // userId → LongTermRecord
    this._longTerm = new LRUMap(this._config.maxUserProfiles);

    this._lastCleanupAt = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // PUBLIC API — SHORT-TERM
  // ==========================================================================

  /**
   * Returns the short-term memory for a session (auto-initialises).
   *
   * @param {string} sessionId
   * @returns {ShortTermMemory}
   */
  getShortTermMemory(sessionId) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    return this._getOrInitShortTerm(sessionId);
  }

  /**
   * Returns the long-term memory for a user (auto-initialises).
   *
   * @param {string} userId
   * @param {number} nowMs
   * @returns {LongTermMemory}
   */
  getLongTermMemory(userId, nowMs) {
    this._assertAlive();
    _assertString(userId, 'userId');
    _assertFinite(nowMs, 'nowMs');
    return this._getOrInitLongTerm(userId, nowMs);
  }

  /**
   * Convenience: returns both layers merged for a session+user context.
   *
   * @param {string} sessionId
   * @param {string|null} userId
   * @param {number} nowMs
   * @returns {{ shortTerm: ShortTermMemory, longTerm: LongTermMemory|null }}
   */
  getUserMemory(sessionId, userId, nowMs) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');
    return {
      shortTerm: this.getShortTermMemory(sessionId),
      longTerm:  userId ? this.getLongTermMemory(userId, nowMs) : null,
    };
  }

  // ==========================================================================
  // PUBLIC API — RECORDING
  // ==========================================================================

  /**
   * Records an ignored product suggestion in this session.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.productId
   * @param {string} [p.reason]   Why it was ignored (user_dismissed, skip, etc.)
   * @param {number} p.nowMs
   */
  recordIgnoredSuggestion({ sessionId, productId, reason, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertString(productId, 'productId');
    _assertFinite(nowMs, 'nowMs');

    const st = this._getOrInitShortTerm(sessionId);
    st.ignoredProducts.add(productId);
    st.sessionPatterns.dismissals++;
    this._pushInteraction(st, {
      type: 'ignored_suggestion',
      productId,
      reason: reason || null,
      timestamp: nowMs,
    });
  }

  /**
   * Records a product view / interaction.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string|null} [p.userId]
   * @param {string} p.productId
   * @param {string} p.context       'listing' | 'product_detail' | 'cart' | ...
   * @param {string} [p.category]
   * @param {string} [p.eventType]   'view' | 'hover' | 'add_to_cart' | 'revisit'
   * @param {number} p.nowMs
   */
  recordBehavior({ sessionId, userId, productId, context, category, eventType, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    const st = this._getOrInitShortTerm(sessionId);
    const type = eventType || 'view';

    // Track session-level patterns
    if (type === 'hesitation')   st.sessionPatterns.hesitations++;
    if (type === 'revisit')      st.sessionPatterns.revisits++;
    if (type === 'add_to_cart')  st.sessionPatterns.cartAdds++;
    if (type === 'exit_intent')  st.sessionPatterns.exits++;

    this._pushInteraction(st, {
      type,
      productId: productId || null,
      context: context || null,
      category: category || null,
      timestamp: nowMs,
    });

    // Long-term: category frequency tracking
    if (userId && category) {
      const lt = this._getOrInitLongTerm(userId, nowMs);
      const catKey = category;
      const existing = lt.frequentCategories.get(catKey) || { visits: 0, purchases: 0, lastSeenAt: 0 };
      existing.visits++;
      existing.lastSeenAt = nowMs;
      lt.frequentCategories.set(catKey, existing);
      lt.behaviorPatterns.totalEvents++;
      lt.behaviorPatterns.lastActiveAt = nowMs;
    }
  }

  /**
   * Records a purchase for long-term cycle tracking.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.userId
   * @param {Array<{ productId: string, category: string, price: number }>} p.products
   * @param {number} p.revenue
   * @param {number} p.nowMs
   */
  recordPurchase({ sessionId, userId, products, revenue, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertString(userId, 'userId');
    _assertFinite(nowMs, 'nowMs');

    const st = this._getOrInitShortTerm(sessionId);
    st.sessionPatterns.cartAdds = Math.max(st.sessionPatterns.cartAdds, 1);
    this._pushInteraction(st, { type: 'purchase', revenue, timestamp: nowMs });

    // Long-term
    const lt = this._getOrInitLongTerm(userId, nowMs);
    const cycles = lt.purchaseCycles;

    // Compute interval from last purchase
    const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1] : null;
    const intervalMs = lastCycle ? nowMs - lastCycle.timestamp : null;

    const cycle = {
      timestamp: nowMs,
      intervalMs,
      revenue: typeof revenue === 'number' ? revenue : 0,
      productCount: Array.isArray(products) ? products.length : 0,
      categories: Array.isArray(products)
        ? [...new Set(products.map(p => p.category).filter(Boolean))]
        : [],
    };

    cycles.push(cycle);
    while (cycles.length > this._config.maxPurchaseCycles) cycles.shift();

    // Update category purchase counts
    if (Array.isArray(products)) {
      for (const p of products) {
        if (!p.category) continue;
        const existing = lt.frequentCategories.get(p.category) || { visits: 0, purchases: 0, lastSeenAt: 0 };
        existing.purchases++;
        existing.lastSeenAt = nowMs;
        lt.frequentCategories.set(p.category, existing);
      }
    }

    lt.behaviorPatterns.totalPurchases++;
    lt.behaviorPatterns.totalRevenue += cycle.revenue;
    lt.behaviorPatterns.lastActiveAt = nowMs;
  }

  /**
   * Records an explicit rejection (user dismissed a family/product suggestion).
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string|null} [p.userId]
   * @param {string} p.entityId     productId or messageFamily
   * @param {string} p.entityType   'product' | 'family' | 'category'
   * @param {number} p.nowMs
   */
  recordRejection({ sessionId, userId, entityId, entityType, nowMs }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertString(entityId, 'entityId');
    _assertFinite(nowMs, 'nowMs');

    const st = this._getOrInitShortTerm(sessionId);
    st.sessionPatterns.dismissals++;
    this._pushInteraction(st, { type: 'rejection', entityId, entityType: entityType || 'unknown', timestamp: nowMs });

    if (userId) {
      const lt = this._getOrInitLongTerm(userId, nowMs);
      const key = `${entityType || 'unknown'}:${entityId}`;
      const existing = lt.rejections.get(key) || { entityId, entityType, count: 0, lastRejectedAt: 0 };
      existing.count++;
      existing.lastRejectedAt = nowMs;
      lt.rejections.set(key, existing);
    }
  }

  // ==========================================================================
  // PUBLIC API — QUERYING
  // ==========================================================================

  /**
   * Returns true if a product has been ignored in this session.
   *
   * @param {string} sessionId
   * @param {string} productId
   * @returns {boolean}
   */
  isProductIgnored(sessionId, productId) {
    this._assertAlive();
    const st = this._shortTerm.peek(sessionId);
    return st ? st.ignoredProducts.has(productId) : false;
  }

  /**
   * Returns true if an entity (product/family/category) should be suppressed
   * for this user based on long-term rejection count.
   *
   * @param {string} userId
   * @param {string} entityId
   * @param {string} entityType
   * @param {number} nowMs
   * @returns {{ suppress: boolean, reason: string|null, count: number }}
   */
  shouldSuppress(userId, entityId, entityType, nowMs) {
    this._assertAlive();
    _assertString(userId, 'userId');
    _assertFinite(nowMs, 'nowMs');

    const lt = this._longTerm.peek(userId);
    if (!lt) return { suppress: false, reason: null, count: 0 };

    const key = `${entityType || 'unknown'}:${entityId}`;
    const rec = lt.rejections.peek(key);
    if (!rec) return { suppress: false, reason: null, count: 0 };

    // Check TTL
    if (nowMs - rec.lastRejectedAt > this._config.longTermTtlMs) {
      return { suppress: false, reason: 'expired', count: rec.count };
    }

    const suppress = rec.count >= this._config.rejectionCountToSuppress;
    return {
      suppress,
      reason: suppress ? `rejection_count:${rec.count}` : null,
      count: rec.count,
    };
  }

  /**
   * Returns a purchase cycle prediction for a user based on historical intervals.
   * Uses simple statistics: median interval ± MAD.
   *
   * @param {string} userId
   * @param {number} nowMs
   * @returns {PurchaseCyclePrediction|null}
   *
   * PurchaseCyclePrediction: {
   *   predictedNextMs:   number|null,
   *   medianIntervalMs:  number|null,
   *   madMs:             number|null,  (median absolute deviation)
   *   confidence:        number,       0–1
   *   cycleCount:        number,
   *   rationale:         string[],
   * }
   */
  getPurchaseCyclePrediction(userId, nowMs) {
    this._assertAlive();
    _assertString(userId, 'userId');
    _assertFinite(nowMs, 'nowMs');

    const lt = this._longTerm.peek(userId);
    if (!lt || lt.purchaseCycles.length < this._config.minCyclesForPrediction) {
      return {
        predictedNextMs:  null,
        medianIntervalMs: null,
        madMs:            null,
        confidence:       0,
        cycleCount:       lt ? lt.purchaseCycles.length : 0,
        rationale:        ['insufficient_cycles'],
      };
    }

    // Extract intervals (only non-null, within TTL)
    const intervals = lt.purchaseCycles
      .filter(c => c.intervalMs != null && (nowMs - c.timestamp) < this._config.longTermTtlMs)
      .map(c => c.intervalMs);

    if (intervals.length < this._config.minCyclesForPrediction) {
      return {
        predictedNextMs:  null,
        medianIntervalMs: null,
        madMs:            null,
        confidence:       0,
        cycleCount:       lt.purchaseCycles.length,
        rationale:        ['intervals_outside_ttl'],
      };
    }

    const sorted = intervals.slice().sort((a, b) => a - b);
    const medianInterval = _median(sorted);
    const deviations = sorted.map(v => Math.abs(v - medianInterval)).sort((a, b) => a - b);
    const mad = _median(deviations);

    const lastPurchase = lt.purchaseCycles[lt.purchaseCycles.length - 1];
    const predictedNextMs = lastPurchase.timestamp + medianInterval;

    // Confidence: more cycles + lower relative MAD = higher confidence
    const relativeVariability = medianInterval > 0 ? mad / medianInterval : 1;
    const cycleFactor  = Math.min(1, intervals.length / 5);
    const stabilityFactor = Math.max(0, 1 - relativeVariability);
    const confidence = Math.round(cycleFactor * stabilityFactor * 100) / 100;

    const rationale = [
      `cycles:${intervals.length}`,
      `median_interval_days:${(medianInterval / MS_PER_DAY).toFixed(1)}`,
      `mad_days:${(mad / MS_PER_DAY).toFixed(1)}`,
      `relative_variability:${relativeVariability.toFixed(2)}`,
    ];

    return {
      predictedNextMs,
      medianIntervalMs: medianInterval,
      madMs: mad,
      confidence,
      cycleCount: intervals.length,
      rationale,
    };
  }

  /**
   * Returns the top N frequent categories for a user, ranked by visits.
   *
   * @param {string} userId
   * @param {number} nowMs
   * @param {number} [topN=5]
   * @returns {Array<{ category, visits, purchases, lastSeenAt }>}
   */
  getFrequentCategories(userId, nowMs, topN = 5) {
    this._assertAlive();
    _assertString(userId, 'userId');
    _assertFinite(nowMs, 'nowMs');

    const lt = this._longTerm.peek(userId);
    if (!lt) return [];

    const ttl = this._config.longTermTtlMs;
    const entries = [];
    for (const [category, data] of lt.frequentCategories.entries()) {
      if (nowMs - data.lastSeenAt > ttl) continue;
      entries.push({ category, ...data });
    }

    return entries
      .sort((a, b) => b.visits - a.visits)
      .slice(0, topN);
  }

  /**
   * Returns current session patterns summary.
   *
   * @param {string} sessionId
   * @returns {SessionPatterns|null}
   */
  getSessionPatterns(sessionId) {
    this._assertAlive();
    const st = this._shortTerm.peek(sessionId);
    return st ? { ...st.sessionPatterns } : null;
  }

  /**
   * Returns the N most recent interactions for a session.
   *
   * @param {string} sessionId
   * @param {number} [limit=10]
   * @returns {Array<Interaction>}
   */
  getRecentInteractions(sessionId, limit = 10) {
    this._assertAlive();
    const st = this._shortTerm.peek(sessionId);
    if (!st) return [];
    const interactions = st.recentInteractions;
    return interactions.slice(Math.max(0, interactions.length - limit));
  }

  // ==========================================================================
  // CLEANUP
  // ==========================================================================

  /**
   * Removes expired long-term records. Call periodically.
   * @param {number} nowMs
   * @returns {{ removedProfiles: number }}
   */
  cleanup(nowMs) {
    this._assertAlive();
    _assertFinite(nowMs, 'nowMs');

    let removedProfiles = 0;
    const ttl = this._config.longTermTtlMs;

    for (const [userId, lt] of this._longTerm.entries()) {
      if (nowMs - lt.behaviorPatterns.lastActiveAt > ttl) {
        this._longTerm.delete(userId);
        removedProfiles++;
      }
    }

    this._lastCleanupAt = nowMs;
    return { removedProfiles };
  }

  // ==========================================================================
  // SNAPSHOT / RESTORE
  // ==========================================================================

  snapshot() {
    this._assertAlive();

    // Short-term: serialize ignoredProducts (Set → Array)
    const shortTermArr = [];
    for (const [k, v] of this._shortTerm.entries()) {
      shortTermArr.push({
        _key: k,
        ignoredProducts: [...v.ignoredProducts],
        recentInteractions: v.recentInteractions.slice(),
        sessionPatterns: { ...v.sessionPatterns },
      });
    }

    // Long-term: serialize LRU sub-maps
    const longTermArr = [];
    for (const [k, v] of this._longTerm.entries()) {
      longTermArr.push({
        _key: k,
        purchaseCycles: v.purchaseCycles.slice(),
        preferences:    v.preferences.toArray(),
        rejections:     v.rejections.toArray(),
        frequentCategories: v.frequentCategories.toArray(),
        behaviorPatterns: { ...v.behaviorPatterns },
      });
    }

    return {
      __schemaVersion: SCHEMA_VERSION,
      shortTerm: shortTermArr,
      longTerm:  longTermArr,
      lastCleanupAt: this._lastCleanupAt,
    };
  }

  restore(snap) {
    this._assertAlive();
    if (!snap || snap.__schemaVersion !== SCHEMA_VERSION) return;

    this._shortTerm.clear();
    for (const item of (snap.shortTerm || [])) {
      const { _key, ignoredProducts, recentInteractions, sessionPatterns } = item;
      if (!_key) continue;
      this._shortTerm.set(_key, {
        ignoredProducts:    new Set(ignoredProducts || []),
        recentInteractions: recentInteractions || [],
        sessionPatterns:    sessionPatterns || _emptyPatterns(),
      });
    }

    this._longTerm.clear();
    for (const item of (snap.longTerm || [])) {
      const { _key, purchaseCycles, preferences, rejections, frequentCategories, behaviorPatterns } = item;
      if (!_key) continue;
      const lt = _emptyLongTerm(this._config);
      lt.purchaseCycles = purchaseCycles || [];
      lt.preferences.loadFromArray(preferences || []);
      lt.rejections.loadFromArray(rejections || []);
      lt.frequentCategories.loadFromArray(frequentCategories || []);
      Object.assign(lt.behaviorPatterns, behaviorPatterns || {});
      this._longTerm.set(_key, lt);
    }

    this._lastCleanupAt = snap.lastCleanupAt || 0;
  }

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================

  getDiagnostics() {
    this._assertAlive();
    return {
      schemaVersion:    SCHEMA_VERSION,
      shortTermSessions: this._shortTerm.size,
      longTermProfiles:  this._longTerm.size,
      lastCleanupAt:     this._lastCleanupAt,
      config: {
        longTermTtlDays:          this._config.longTermTtlDays,
        rejectionCountToSuppress: this._config.rejectionCountToSuppress,
        minCyclesForPrediction:   this._config.minCyclesForPrediction,
      },
    };
  }

  dispose() {
    if (this._disposed) return;
    this._shortTerm.clear();
    this._longTerm.clear();
    this._disposed = true;
  }

  // ==========================================================================
  // PRIVATE
  // ==========================================================================

  _getOrInitShortTerm(sessionId) {
    const existing = this._shortTerm.peek(sessionId);
    if (existing) return existing;
    const st = {
      ignoredProducts:    new Set(),
      recentInteractions: [],
      sessionPatterns:    _emptyPatterns(),
    };
    this._shortTerm.set(sessionId, st);
    return st;
  }

  _getOrInitLongTerm(userId, nowMs) {
    const existing = this._longTerm.peek(userId);
    if (existing) return existing;
    const lt = _emptyLongTerm(this._config);
    lt.behaviorPatterns.lastActiveAt = nowMs;
    this._longTerm.set(userId, lt);
    return lt;
  }

  _pushInteraction(st, interaction) {
    st.recentInteractions.push(interaction);
    while (st.recentInteractions.length > this._config.maxRecentInteractions) {
      st.recentInteractions.shift();
    }
  }

  _assertAlive() {
    if (this._disposed) throw new Error('UserMemoryEngine: instance has been disposed');
  }
}

// ============================================================================
// Private helpers
// ============================================================================

function _emptyPatterns() {
  return { hesitations: 0, revisits: 0, dismissals: 0, cartAdds: 0, exits: 0 };
}

function _emptyLongTerm(config) {
  return {
    purchaseCycles:     [],
    preferences:        new LRUMap(200),
    rejections:         new LRUMap(config.maxRejectionEntries),
    frequentCategories: new LRUMap(config.maxCategoryEntries),
    behaviorPatterns: {
      totalEvents:    0,
      totalPurchases: 0,
      totalRevenue:   0,
      lastActiveAt:   0,
    },
  };
}

function _median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function _assertString(v, label) {
  if (!v || typeof v !== 'string') throw new TypeError(`UserMemoryEngine: ${label} must be a non-empty string`);
}

function _assertFinite(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`UserMemoryEngine: ${label} must be a finite number`);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  UserMemoryEngine,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  MS_PER_DAY,
};
