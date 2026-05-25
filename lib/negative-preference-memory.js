/**
 * negative-preference-memory.js
 *
 * NEGATIVE PREFERENCE MEMORY — Tracks user rejections and skips.
 *
 * This module maintains a memory of:
 *   - Products/relationships the user has dismissed
 *   - Products the user has skipped when suggested
 *   - Patterns that should be suppressed based on behavior
 *
 * Memory Rules:
 *   - TTL of 90 days (preferences cannot persist forever)
 *   - Repeated skips suppress future interventions
 *   - Bounded memory with LRU eviction
 *
 * Integration with OPE:
 *   - Deterministic: NO Date.now(), NO Math.random()
 *   - Replay-safe: snapshot/restore
 *   - Bounded memory: LRU eviction
 *   - Returns SIGNALS only
 */

'use strict';

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
  maxDismissalEntries: 500,
  maxSkipEntries: 500,
  maxPatternEntries: 200,

  // Thresholds for suppression
  dismissCountToSuppress: 2,   // After 2 dismissals, suppress
  skipCountToSuppress: 3,      // After 3 skips, suppress
  skipPurchaseRatioThreshold: 0.2, // If purchase rate < 20% after skips, suppress

  // Cleanup interval (how often to prune expired entries)
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
// NEGATIVE PREFERENCE MEMORY
// ============================================================================

class NegativePreferenceMemory {
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
    this._dismissals = new LRUMap(this.config.maxDismissalEntries);
    this._skips = new LRUMap(this.config.maxSkipEntries);
    this._suppressedPatterns = new LRUMap(this.config.maxPatternEntries);

    this._lastCleanupAt = 0;
    this._version = 1;
    this._disposed = false;
  }

  // =========================================================================
  // RECORDING EVENTS
  // =========================================================================

  /**
   * Records a user dismissal of a relationship suggestion.
   *
   * @param {object} params
   * @param {string} params.relationshipId - Unique ID for the relationship
   * @param {string} params.triggerProductId - Product that triggered suggestion
   * @param {string} params.suggestedProductId - Product that was suggested
   * @param {string} params.relationshipType - Type of relationship
   * @param {string} [params.dismissReason] - Why user dismissed (if known)
   * @param {number} params.nowMs - Current timestamp
   */
  recordDismissal(params) {
    this._assertAlive();
    const { relationshipId, triggerProductId, suggestedProductId, relationshipType, dismissReason, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('NegativePreferenceMemory: nowMs must be a finite number');
    }

    const key = relationshipId || `${triggerProductId}:${suggestedProductId}`;
    const existing = this._dismissals.peek(key) || {
      triggerProductId,
      suggestedProductId,
      relationshipType,
      dismissCount: 0,
      firstDismissedAt: nowMs,
      lastDismissedAt: null,
      reasons: [],
    };

    existing.dismissCount++;
    existing.lastDismissedAt = nowMs;
    if (dismissReason && !existing.reasons.includes(dismissReason)) {
      existing.reasons.push(dismissReason);
    }

    this._dismissals.set(key, existing);
    this._maybeCleanup(nowMs);
    this._version++;

    // Auto-suppress if threshold reached
    if (existing.dismissCount >= this.config.dismissCountToSuppress) {
      this._suppressPattern(key, 'dismiss_threshold_reached', nowMs);
    }
  }

  /**
   * Records when user saw a suggestion but didn't act (skip).
   *
   * @param {object} params
   * @param {string} params.relationshipId - Unique ID for the relationship
   * @param {string} params.triggerProductId
   * @param {string} params.suggestedProductId
   * @param {number} params.nowMs
   */
  recordSkip(params) {
    this._assertAlive();
    const { relationshipId, triggerProductId, suggestedProductId, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('NegativePreferenceMemory: nowMs must be a finite number');
    }

    const key = relationshipId || `${triggerProductId}:${suggestedProductId}`;
    const existing = this._skips.peek(key) || {
      triggerProductId,
      suggestedProductId,
      skipCount: 0,
      purchaseCount: 0,
      firstSkippedAt: nowMs,
      lastSkippedAt: null,
    };

    existing.skipCount++;
    existing.lastSkippedAt = nowMs;

    this._skips.set(key, existing);
    this._maybeCleanup(nowMs);
    this._version++;

    // Auto-suppress if skip threshold reached AND purchase ratio is low
    if (existing.skipCount >= this.config.skipCountToSuppress) {
      const purchaseRatio = existing.purchaseCount / (existing.skipCount + existing.purchaseCount);
      if (purchaseRatio < this.config.skipPurchaseRatioThreshold) {
        this._suppressPattern(key, 'skip_threshold_reached', nowMs);
      }
    }
  }

  /**
   * Records when user actually purchased after seeing suggestion.
   * This is a positive signal that can counter skips.
   *
   * @param {object} params
   * @param {string} params.relationshipId
   * @param {string} params.triggerProductId
   * @param {string} params.suggestedProductId
   * @param {number} params.nowMs
   */
  recordPurchase(params) {
    this._assertAlive();
    const { relationshipId, triggerProductId, suggestedProductId, nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('NegativePreferenceMemory: nowMs must be a finite number');
    }

    const key = relationshipId || `${triggerProductId}:${suggestedProductId}`;
    const existing = this._skips.peek(key);

    if (existing) {
      existing.purchaseCount++;
      existing.lastPurchaseAt = nowMs;
      this._skips.set(key, existing);

      // Un-suppress if purchase ratio improves
      const totalInteractions = existing.skipCount + existing.purchaseCount;
      const purchaseRatio = existing.purchaseCount / totalInteractions;
      if (purchaseRatio >= this.config.skipPurchaseRatioThreshold) {
        this._unsuppressPattern(key);
      }
    }

    this._version++;
  }

  // =========================================================================
  // QUERYING
  // =========================================================================

  /**
   * Checks if a relationship should be suppressed.
   *
   * @param {string} relationshipId - Or `${triggerProductId}:${suggestedProductId}`
   * @param {number} nowMs - Current timestamp
   * @returns {{ suppressed: boolean, reason?: string, expiresAt?: number }}
   */
  shouldSuppress(relationshipId, nowMs) {
    this._assertAlive();

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('NegativePreferenceMemory: nowMs must be a finite number');
    }

    const pattern = this._suppressedPatterns.peek(relationshipId);
    if (!pattern) return { suppressed: false };

    // Check if TTL expired
    if (nowMs - pattern.suppressedAt > this.config.memoryTtlMs) {
      this._suppressedPatterns.delete(relationshipId);
      return { suppressed: false };
    }

    return {
      suppressed: true,
      reason: pattern.reason,
      suppressedAt: pattern.suppressedAt,
      expiresAt: pattern.suppressedAt + this.config.memoryTtlMs,
    };
  }

  /**
   * Gets dismissal stats for a relationship.
   *
   * @param {string} relationshipId
   * @param {number} nowMs
   * @returns {object|null}
   */
  getDismissalStats(relationshipId, nowMs) {
    this._assertAlive();

    const entry = this._dismissals.peek(relationshipId);
    if (!entry) return null;

    // Check TTL
    if (nowMs - entry.lastDismissedAt > this.config.memoryTtlMs) {
      this._dismissals.delete(relationshipId);
      return null;
    }

    return {
      dismissCount: entry.dismissCount,
      firstDismissedAt: entry.firstDismissedAt,
      lastDismissedAt: entry.lastDismissedAt,
      reasons: entry.reasons,
      reachesThreshold: entry.dismissCount >= this.config.dismissCountToSuppress,
    };
  }

  /**
   * Gets skip stats for a relationship.
   *
   * @param {string} relationshipId
   * @param {number} nowMs
   * @returns {object|null}
   */
  getSkipStats(relationshipId, nowMs) {
    this._assertAlive();

    const entry = this._skips.peek(relationshipId);
    if (!entry) return null;

    // Check TTL
    const lastActivity = Math.max(entry.lastSkippedAt || 0, entry.lastPurchaseAt || 0);
    if (nowMs - lastActivity > this.config.memoryTtlMs) {
      this._skips.delete(relationshipId);
      return null;
    }

    const totalInteractions = entry.skipCount + entry.purchaseCount;
    const purchaseRatio = totalInteractions > 0
      ? entry.purchaseCount / totalInteractions
      : 0;

    return {
      skipCount: entry.skipCount,
      purchaseCount: entry.purchaseCount,
      purchaseRatio,
      firstSkippedAt: entry.firstSkippedAt,
      lastSkippedAt: entry.lastSkippedAt,
      reachesThreshold: entry.skipCount >= this.config.skipCountToSuppress &&
        purchaseRatio < this.config.skipPurchaseRatioThreshold,
    };
  }

  // =========================================================================
  // SUPPRESSION MANAGEMENT
  // =========================================================================

  _suppressPattern(relationshipId, reason, nowMs) {
    this._suppressedPatterns.set(relationshipId, {
      reason,
      suppressedAt: nowMs,
    });
  }

  _unsuppressPattern(relationshipId) {
    this._suppressedPatterns.delete(relationshipId);
  }

  /**
   * Manually suppress a pattern (for external use).
   */
  suppressRelationship(relationshipId, reason, nowMs) {
    this._assertAlive();
    this._suppressPattern(relationshipId, reason || 'manual_suppression', nowMs);
    this._version++;
  }

  /**
   * Manually unsuppress a pattern.
   */
  unsuppressRelationship(relationshipId) {
    this._assertAlive();
    this._unsuppressPattern(relationshipId);
    this._version++;
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
   * @returns {{ dismissals: number, skips: number, patterns: number }}
   */
  cleanup(nowMs) {
    this._assertAlive();

    let removedDismissals = 0;
    let removedSkips = 0;
    let removedPatterns = 0;

    const ttl = this.config.memoryTtlMs;

    // Cleanup dismissals
    for (const [key, entry] of this._dismissals.entries()) {
      if (nowMs - entry.lastDismissedAt > ttl) {
        this._dismissals.delete(key);
        removedDismissals++;
      }
    }

    // Cleanup skips
    for (const [key, entry] of this._skips.entries()) {
      const lastActivity = Math.max(entry.lastSkippedAt || 0, entry.lastPurchaseAt || 0);
      if (nowMs - lastActivity > ttl) {
        this._skips.delete(key);
        removedSkips++;
      }
    }

    // Cleanup suppressed patterns
    for (const [key, entry] of this._suppressedPatterns.entries()) {
      if (nowMs - entry.suppressedAt > ttl) {
        this._suppressedPatterns.delete(key);
        removedPatterns++;
      }
    }

    this._lastCleanupAt = nowMs;

    return { dismissals: removedDismissals, skips: removedSkips, patterns: removedPatterns };
  }

  // =========================================================================
  // SNAPSHOT / RESTORE
  // =========================================================================

  snapshot() {
    return {
      __type: 'NegativePreferenceMemory',
      __version: 1,
      dismissals: this._dismissals.toArray(),
      skips: this._skips.toArray(),
      suppressedPatterns: this._suppressedPatterns.toArray(),
      lastCleanupAt: this._lastCleanupAt,
      version: this._version,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'NegativePreferenceMemory') return;
    if (snap.__version !== 1) return;

    this._dismissals.loadFromArray(snap.dismissals || []);
    this._skips.loadFromArray(snap.skips || []);
    this._suppressedPatterns.loadFromArray(snap.suppressedPatterns || []);
    this._lastCleanupAt = snap.lastCleanupAt || 0;
    this._version = snap.version || 1;
  }

  // =========================================================================
  // DIAGNOSTICS
  // =========================================================================

  getDiagnostics() {
    return {
      dismissalCount: this._dismissals.size,
      skipCount: this._skips.size,
      suppressedPatternCount: this._suppressedPatterns.size,
      lastCleanupAt: this._lastCleanupAt,
      version: this._version,
      config: {
        memoryTtlDays: this.config.memoryTtlDays,
        dismissCountToSuppress: this.config.dismissCountToSuppress,
        skipCountToSuppress: this.config.skipCountToSuppress,
      },
      disposed: this._disposed,
    };
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  reset() {
    this._dismissals.clear();
    this._skips.clear();
    this._suppressedPatterns.clear();
    this._lastCleanupAt = 0;
    this._version = 1;
  }

  dispose() {
    if (this._disposed) return;
    this._dismissals.clear();
    this._skips.clear();
    this._suppressedPatterns.clear();
    this._disposed = true;
  }

  _assertAlive() {
    if (this._disposed) {
      throw new Error('NegativePreferenceMemory: instance has been disposed');
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  NegativePreferenceMemory,
  DEFAULT_CONFIG,
  MS_PER_DAY,
};
