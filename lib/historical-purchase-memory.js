'use strict';

/**
 * historical-purchase-memory.js (PHASE 2)
 *
 * HISTORICAL PURCHASE MEMORY — Tracks relationship patterns over time.
 *
 * This module maintains memory of:
 *   - Which products users have purchased together
 *   - Relationship affinity patterns (e.g., pasta + sauce = high affinity)
 *   - Repeated absence patterns (e.g., pasta without sauce 3x = low affinity)
 *
 * Memory Rules:
 *   - TTL of 90 days (memory cannot persist forever)
 *   - Repeated patterns increase confidence
 *   - Repeated absence suppresses assumptions
 *   - Bounded memory with LRU eviction
 *
 * Integration with OPE:
 *   - Deterministic: NO Date.now(), NO Math.random()
 *   - Replay-safe: snapshot/restore
 *   - Bounded memory: LRU eviction
 *   - Returns SIGNALS only (does not make decisions)
 *
 * Authority: MEMORY only. Does NOT decide. Does NOT intervene.
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  // Memory TTL in days
  memoryTtlDays: 90,

  // Memory TTL in milliseconds (computed)
  memoryTtlMs: 90 * MS_PER_DAY,

  // Maximum entries per memory type
  maxPurchaseEntries: 1000,
  maxRelationshipEntries: 500,
  maxAffinityEntries: 500,

  // Affinity thresholds
  highAffinityThreshold: 0.75,    // >= 75% co-purchase rate
  lowAffinityThreshold: 0.25,     // <= 25% co-purchase rate

  // Minimum observations before computing affinity
  minObservationsForAffinity: 3,

  // Decay factor for older observations
  observationDecayPerDay: 0.01,   // 1% decay per day

  // Cleanup interval
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
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
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }

  toArray() {
    const arr = [];
    for (const [k, v] of this._map.entries()) {
      arr.push({ key: k, ...v });
    }
    return arr;
  }

  loadFromArray(arr) {
    this._map.clear();
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const { key, ...rest } = item;
      if (key) this.set(key, rest);
    }
  }
}

// ============================================================================
// HISTORICAL PURCHASE MEMORY
// ============================================================================

class HistoricalPurchaseMemory {
  /**
   * @param {object} [config] - Override default configuration
   */
  constructor(config = {}) {
    this.config = Object.freeze({
      ...DEFAULT_CONFIG,
      ...config,
      memoryTtlMs: (config.memoryTtlDays || DEFAULT_CONFIG.memoryTtlDays) * MS_PER_DAY,
    });

    // Memory stores
    // purchaseHistory: sessionId -> { products: [...], timestamp }
    this._purchaseHistory = new LRUMap(this.config.maxPurchaseEntries);

    // relationshipObservations: relationshipKey -> { present: number, absent: number, lastObservedAt }
    this._relationshipObservations = new LRUMap(this.config.maxRelationshipEntries);

    // affinityCache: relationshipKey -> { affinity, confidence, computedAt }
    this._affinityCache = new LRUMap(this.config.maxAffinityEntries);

    this._lastCleanupAt = 0;
    this._version = 1;
    this._disposed = false;
  }

  // =========================================================================
  // RECORDING EVENTS
  // =========================================================================

  /**
   * Records a purchase event with all products in the order.
   *
   * @param {object} params
   * @param {string} params.sessionId - Session identifier
   * @param {string} [params.userId] - User identifier (optional)
   * @param {object[]} params.products - Products purchased
   * @param {string} params.products[].productId
   * @param {string} params.products[].canonicalType
   * @param {string} params.products[].category
   * @param {object} [params.purchaseContext] - Additional context
   * @param {number} params.nowMs - Current timestamp
   */
  recordPurchase(params) {
    this._assertAlive();
    const { sessionId, userId, products, purchaseContext, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('HistoricalPurchaseMemory: nowMs must be a finite number');
    }

    if (!Array.isArray(products) || products.length === 0) {
      return; // Nothing to record
    }

    // Record the purchase
    const purchaseKey = userId ? `user:${userId}` : `session:${sessionId}`;
    const existing = this._purchaseHistory.peek(purchaseKey) || {
      purchases: [],
    };

    existing.purchases.push({
      products: products.map(p => ({
        productId: p.productId,
        canonicalType: p.canonicalType,
        category: p.category,
      })),
      timestamp: nowMs,
      context: purchaseContext || {},
    });

    // Keep bounded
    while (existing.purchases.length > 100) {
      existing.purchases.shift();
    }

    this._purchaseHistory.set(purchaseKey, existing);

    // Update relationship observations
    this._updateRelationshipObservations(products, nowMs);

    this._maybeCleanup(nowMs);
    this._version++;
  }

  /**
   * Records when a user viewed/carted a primary product but did NOT purchase
   * the expected complement.
   *
   * @param {object} params
   * @param {string} params.primaryCanonicalType
   * @param {string} params.expectedComplementType
   * @param {string} params.relationshipId
   * @param {number} params.nowMs
   */
  recordMissingComplement(params) {
    this._assertAlive();
    const { primaryCanonicalType, expectedComplementType, relationshipId, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('HistoricalPurchaseMemory: nowMs must be a finite number');
    }

    const key = relationshipId || `${primaryCanonicalType}:${expectedComplementType}`;
    const existing = this._relationshipObservations.peek(key) || {
      primaryType: primaryCanonicalType,
      complementType: expectedComplementType,
      presentCount: 0,
      absentCount: 0,
      observations: [],
    };

    existing.absentCount++;
    existing.observations.push({ type: 'absent', timestamp: nowMs });

    // Keep bounded
    while (existing.observations.length > 50) {
      existing.observations.shift();
    }

    existing.lastObservedAt = nowMs;
    this._relationshipObservations.set(key, existing);

    // Invalidate affinity cache
    this._affinityCache.delete(key);

    this._version++;
  }

  // =========================================================================
  // QUERYING
  // =========================================================================

  /**
   * Gets the historical relationship pattern between two product types.
   *
   * @param {string} primaryType
   * @param {string} complementType
   * @param {number} nowMs
   * @returns {RelationshipPattern}
   *
   * RelationshipPattern: {
   *   affinity: 'high' | 'low' | 'neutral' | 'unknown',
   *   affinityScore: number (0-1),
   *   confidence: number (0-1),
   *   presentCount: number,
   *   absentCount: number,
   *   totalObservations: number,
   *   rationale: string[],
   * }
   */
  getRelationshipPattern(primaryType, complementType, nowMs) {
    this._assertAlive();

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('HistoricalPurchaseMemory: nowMs must be a finite number');
    }

    const key = `${primaryType}:${complementType}`;

    // Check cache first
    const cached = this._affinityCache.peek(key);
    if (cached && (nowMs - cached.computedAt) < 60 * 60 * 1000) { // 1 hour cache
      return cached.pattern;
    }

    const observations = this._relationshipObservations.peek(key);
    if (!observations) {
      return this._buildPattern('unknown', 0, 0, 0, 0, 0, ['no_observations']);
    }

    // Apply time decay to observations
    const { presentWeighted, absentWeighted } = this._computeWeightedObservations(
      observations.observations,
      nowMs
    );

    const totalWeighted = presentWeighted + absentWeighted;
    const totalRaw = observations.presentCount + observations.absentCount;

    if (totalRaw < this.config.minObservationsForAffinity) {
      return this._buildPattern(
        'unknown',
        0.5,
        totalRaw / this.config.minObservationsForAffinity,
        observations.presentCount,
        observations.absentCount,
        totalRaw,
        ['insufficient_observations']
      );
    }

    // Compute affinity score
    const affinityScore = totalWeighted > 0 ? presentWeighted / totalWeighted : 0.5;

    // Determine affinity level
    let affinity = 'neutral';
    const rationale = [];

    if (affinityScore >= this.config.highAffinityThreshold) {
      affinity = 'high';
      rationale.push(`high_affinity:${affinityScore.toFixed(2)}`);
    } else if (affinityScore <= this.config.lowAffinityThreshold) {
      affinity = 'low';
      rationale.push(`low_affinity:${affinityScore.toFixed(2)}`);
    } else {
      rationale.push(`neutral_affinity:${affinityScore.toFixed(2)}`);
    }

    // Confidence based on observation count
    const confidence = Math.min(1, totalRaw / 10); // Max confidence at 10+ observations

    const pattern = this._buildPattern(
      affinity,
      affinityScore,
      confidence,
      observations.presentCount,
      observations.absentCount,
      totalRaw,
      rationale
    );

    // Cache the result
    this._affinityCache.set(key, { pattern, computedAt: nowMs });

    return pattern;
  }

  /**
   * Gets all relationship patterns for a given primary type.
   *
   * @param {string} primaryType
   * @param {number} nowMs
   * @returns {Map<string, RelationshipPattern>}
   */
  getRelationshipPatternsForType(primaryType, nowMs) {
    this._assertAlive();
    const patterns = new Map();

    for (const [key] of this._relationshipObservations.entries()) {
      if (key.startsWith(`${primaryType}:`)) {
        const complementType = key.split(':')[1];
        patterns.set(complementType, this.getRelationshipPattern(primaryType, complementType, nowMs));
      }
    }

    return patterns;
  }

  /**
   * Checks if a relationship should be suppressed due to repeated absence.
   *
   * @param {string} primaryType
   * @param {string} complementType
   * @param {number} nowMs
   * @returns {{ suppress: boolean, reason?: string }}
   */
  shouldSuppressRelationship(primaryType, complementType, nowMs) {
    const pattern = this.getRelationshipPattern(primaryType, complementType, nowMs);

    // Suppress if low affinity with at least some observations
    if (pattern.affinity === 'low' && pattern.totalObservations >= this.config.minObservationsForAffinity) {
      return {
        suppress: true,
        reason: `low_historical_affinity:${pattern.affinityScore.toFixed(2)}`,
      };
    }

    return { suppress: false };
  }

  // =========================================================================
  // INTERNAL HELPERS
  // =========================================================================

  _updateRelationshipObservations(products, nowMs) {
    const canonicalTypes = products
      .map(p => p.canonicalType)
      .filter(t => t != null);

    if (canonicalTypes.length < 2) return;

    // For each pair, record as "present"
    for (let i = 0; i < canonicalTypes.length; i++) {
      for (let j = i + 1; j < canonicalTypes.length; j++) {
        const key1 = `${canonicalTypes[i]}:${canonicalTypes[j]}`;
        const key2 = `${canonicalTypes[j]}:${canonicalTypes[i]}`;

        this._recordPresent(key1, canonicalTypes[i], canonicalTypes[j], nowMs);
        this._recordPresent(key2, canonicalTypes[j], canonicalTypes[i], nowMs);
      }
    }
  }

  _recordPresent(key, primaryType, complementType, nowMs) {
    const existing = this._relationshipObservations.peek(key) || {
      primaryType,
      complementType,
      presentCount: 0,
      absentCount: 0,
      observations: [],
    };

    existing.presentCount++;
    existing.observations.push({ type: 'present', timestamp: nowMs });

    while (existing.observations.length > 50) {
      existing.observations.shift();
    }

    existing.lastObservedAt = nowMs;
    this._relationshipObservations.set(key, existing);

    // Invalidate affinity cache
    this._affinityCache.delete(key);
  }

  _computeWeightedObservations(observations, nowMs) {
    let presentWeighted = 0;
    let absentWeighted = 0;

    for (const obs of observations) {
      const ageMs = Math.max(0, nowMs - obs.timestamp);
      const ageDays = ageMs / MS_PER_DAY;
      const decay = Math.max(0, 1 - ageDays * this.config.observationDecayPerDay);

      if (obs.type === 'present') {
        presentWeighted += decay;
      } else {
        absentWeighted += decay;
      }
    }

    return { presentWeighted, absentWeighted };
  }

  _buildPattern(affinity, affinityScore, confidence, presentCount, absentCount, totalObservations, rationale) {
    return Object.freeze({
      affinity,
      affinityScore: Math.round(affinityScore * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      presentCount,
      absentCount,
      totalObservations,
      rationale: Object.freeze(rationale),
    });
  }

  // =========================================================================
  // CLEANUP
  // =========================================================================

  _maybeCleanup(nowMs) {
    if (nowMs - this._lastCleanupAt < this.config.cleanupIntervalMs) return;
    this.cleanup(nowMs);
  }

  /**
   * Removes expired entries from all stores.
   * @param {number} nowMs
   * @returns {{ purchases: number, relationships: number, affinity: number }}
   */
  cleanup(nowMs) {
    this._assertAlive();

    let removedPurchases = 0;
    let removedRelationships = 0;
    let removedAffinity = 0;

    const ttl = this.config.memoryTtlMs;

    // Cleanup purchase history
    for (const [key, entry] of this._purchaseHistory.entries()) {
      if (entry.purchases && entry.purchases.length > 0) {
        const lastPurchase = entry.purchases[entry.purchases.length - 1];
        if (nowMs - lastPurchase.timestamp > ttl) {
          this._purchaseHistory.delete(key);
          removedPurchases++;
        }
      }
    }

    // Cleanup relationship observations
    for (const [key, entry] of this._relationshipObservations.entries()) {
      if (nowMs - entry.lastObservedAt > ttl) {
        this._relationshipObservations.delete(key);
        removedRelationships++;
      }
    }

    // Cleanup affinity cache (shorter TTL)
    for (const [key, entry] of this._affinityCache.entries()) {
      if (nowMs - entry.computedAt > 24 * 60 * 60 * 1000) { // 24 hour cache TTL
        this._affinityCache.delete(key);
        removedAffinity++;
      }
    }

    this._lastCleanupAt = nowMs;

    return {
      purchases: removedPurchases,
      relationships: removedRelationships,
      affinity: removedAffinity,
    };
  }

  // =========================================================================
  // SNAPSHOT / RESTORE
  // =========================================================================

  snapshot() {
    return {
      __type: 'HistoricalPurchaseMemory',
      __version: 1,
      purchaseHistory: this._purchaseHistory.toArray(),
      relationshipObservations: this._relationshipObservations.toArray(),
      affinityCache: this._affinityCache.toArray(),
      lastCleanupAt: this._lastCleanupAt,
      version: this._version,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'HistoricalPurchaseMemory') return;
    if (snap.__version !== 1) return;

    this._purchaseHistory.loadFromArray(snap.purchaseHistory || []);
    this._relationshipObservations.loadFromArray(snap.relationshipObservations || []);
    this._affinityCache.loadFromArray(snap.affinityCache || []);
    this._lastCleanupAt = snap.lastCleanupAt || 0;
    this._version = snap.version || 1;
  }

  // =========================================================================
  // DIAGNOSTICS
  // =========================================================================

  getDiagnostics() {
    return {
      purchaseHistoryCount: this._purchaseHistory.size,
      relationshipObservationsCount: this._relationshipObservations.size,
      affinityCacheCount: this._affinityCache.size,
      lastCleanupAt: this._lastCleanupAt,
      version: this._version,
      config: {
        memoryTtlDays: this.config.memoryTtlDays,
        minObservationsForAffinity: this.config.minObservationsForAffinity,
        highAffinityThreshold: this.config.highAffinityThreshold,
        lowAffinityThreshold: this.config.lowAffinityThreshold,
      },
      disposed: this._disposed,
    };
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  reset() {
    this._purchaseHistory.clear();
    this._relationshipObservations.clear();
    this._affinityCache.clear();
    this._lastCleanupAt = 0;
    this._version = 1;
  }

  dispose() {
    if (this._disposed) return;
    this._purchaseHistory.clear();
    this._relationshipObservations.clear();
    this._affinityCache.clear();
    this._disposed = true;
  }

  _assertAlive() {
    if (this._disposed) {
      throw new Error('HistoricalPurchaseMemory: instance has been disposed');
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  HistoricalPurchaseMemory,
  DEFAULT_CONFIG,
  MS_PER_DAY,
};
