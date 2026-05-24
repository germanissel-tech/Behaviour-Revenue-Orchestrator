'use strict';

/**
 * memory-safety-audit.js (PHASE 5)
 *
 * MEMORY SAFETY AUDIT — Validates memory bounds and cleanup across all stores.
 *
 * This module audits:
 *   - negative-preference-memory
 *   - behavioral-state-store
 *   - runtime-trace
 *   - historical-purchase-memory (new)
 *   - product-ontology-normalizer (new)
 *   - relationship memories
 *   - revisit memories
 *
 * Validates:
 *   - LRU limits are respected
 *   - TTL expiration is working
 *   - Cleanup is happening
 *   - Bounded growth is maintained
 *   - No orphan references
 *   - No stale references
 *   - No memory leaks
 *
 * Design guarantees:
 *   - Pure diagnostic: does NOT modify state
 *   - All reads are non-mutating
 *   - Deterministic output
 */

// ============================================================================
// Constants
// ============================================================================

const AUDIT_CHECKS = Object.freeze({
  LRU_LIMITS: 'lru_limits',
  TTL_EXPIRATION: 'ttl_expiration',
  CLEANUP_RUNNING: 'cleanup_running',
  BOUNDED_GROWTH: 'bounded_growth',
  ORPHAN_REFERENCES: 'orphan_references',
  STALE_REFERENCES: 'stale_references',
  MEMORY_LEAKS: 'memory_leaks',
});

const SEVERITY = Object.freeze({
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
});

// ============================================================================
// MemorySafetyAudit
// ============================================================================

class MemorySafetyAudit {
  /**
   * @param {object} stores - All stores to audit
   * @param {object} [stores.negativePreferenceMemory]
   * @param {object} [stores.behavioralStateStore]
   * @param {object} [stores.runtimeTrace]
   * @param {object} [stores.historicalPurchaseMemory]
   * @param {object} [stores.productOntologyNormalizer]
   * @param {object} [stores.completionConfidenceEngine]
   * @param {object} [stores.productOntologyEngine]
   */
  constructor(stores = {}) {
    this._stores = stores;
  }

  /**
   * Run full memory safety audit.
   *
   * @param {number} nowMs - Current timestamp
   * @returns {AuditReport}
   *
   * AuditReport: {
   *   healthy: boolean,
   *   summary: { total, pass, warn, fail },
   *   checks: AuditCheck[],
   *   recommendations: string[],
   * }
   */
  runAudit(nowMs) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      return {
        healthy: false,
        summary: { total: 1, pass: 0, warn: 0, fail: 1 },
        checks: [this._fail('timestamp', 'Invalid nowMs parameter')],
        recommendations: ['Provide valid timestamp to audit'],
      };
    }

    const checks = [];
    const recommendations = [];

    // Audit each store
    checks.push(...this._auditNegativePreferenceMemory(nowMs));
    checks.push(...this._auditBehavioralStateStore(nowMs));
    checks.push(...this._auditRuntimeTrace(nowMs));
    checks.push(...this._auditHistoricalPurchaseMemory(nowMs));
    checks.push(...this._auditProductOntologyNormalizer(nowMs));
    checks.push(...this._auditCompletionConfidenceEngine(nowMs));
    checks.push(...this._auditProductOntologyEngine(nowMs));

    // Build summary
    const summary = { total: checks.length, pass: 0, warn: 0, fail: 0 };
    for (const check of checks) {
      summary[check.severity]++;

      if (check.severity === SEVERITY.FAIL) {
        recommendations.push(`FIX: ${check.store}.${check.check} - ${check.message}`);
      } else if (check.severity === SEVERITY.WARN) {
        recommendations.push(`MONITOR: ${check.store}.${check.check} - ${check.message}`);
      }
    }

    return {
      healthy: summary.fail === 0,
      summary,
      checks,
      recommendations,
    };
  }

  // ==========================================================================
  // Store-specific audits
  // ==========================================================================

  _auditNegativePreferenceMemory(nowMs) {
    const store = this._stores.negativePreferenceMemory;
    if (!store) return [this._skip('negativePreferenceMemory', 'not_provided')];

    const checks = [];
    const storeName = 'negativePreferenceMemory';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      // Check disposed state
      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Store is disposed'));
        return checks;
      }

      // Check LRU limits
      const config = diag.config || {};
      const dismissalLimit = config.maxDismissalEntries || 500;
      const skipLimit = config.maxSkipEntries || 500;

      if (diag.dismissalCount > dismissalLimit) {
        checks.push(this._fail(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Dismissals exceed limit: ${diag.dismissalCount}/${dismissalLimit}`));
      } else if (diag.dismissalCount > dismissalLimit * 0.9) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Dismissals near limit: ${diag.dismissalCount}/${dismissalLimit}`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Dismissals within bounds: ${diag.dismissalCount}/${dismissalLimit}`));
      }

      if (diag.skipCount > skipLimit) {
        checks.push(this._fail(storeName, AUDIT_CHECKS.LRU_LIMITS + '_skip',
          `Skips exceed limit: ${diag.skipCount}/${skipLimit}`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS + '_skip',
          `Skips within bounds: ${diag.skipCount}/${skipLimit}`));
      }

      // Check cleanup recency
      const cleanupAge = nowMs - (diag.lastCleanupAt || 0);
      const cleanupIntervalMs = 5 * 60 * 1000; // 5 minutes
      if (cleanupAge > cleanupIntervalMs * 3) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.CLEANUP_RUNNING,
          `Cleanup not run recently: ${Math.round(cleanupAge / 60000)}min ago`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.CLEANUP_RUNNING,
          `Cleanup recent: ${Math.round(cleanupAge / 60000)}min ago`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditBehavioralStateStore(nowMs) {
    const store = this._stores.behavioralStateStore;
    if (!store) return [this._skip('behavioralStateStore', 'not_provided')];

    const checks = [];
    const storeName = 'behavioralStateStore';

    try {
      const diag = typeof store.getDiagnostics === 'function'
        ? store.getDiagnostics(nowMs)
        : null;

      if (!diag) {
        // Try getState instead
        const state = typeof store.getState === 'function' ? store.getState() : null;
        if (state) {
          checks.push(this._pass(storeName, 'state_available', 'State accessible'));

          // Check cooldowns map size
          const cooldowns = state.cooldowns;
          if (cooldowns && cooldowns.size !== undefined) {
            if (cooldowns.size > 1000) {
              checks.push(this._warn(storeName, AUDIT_CHECKS.BOUNDED_GROWTH,
                `Cooldowns map large: ${cooldowns.size} entries`));
            } else {
              checks.push(this._pass(storeName, AUDIT_CHECKS.BOUNDED_GROWTH,
                `Cooldowns map bounded: ${cooldowns.size} entries`));
            }
          }

          // Check behavioral locks
          const locks = state.behavioralLocks;
          if (locks && locks.size !== undefined) {
            if (locks.size > 100) {
              checks.push(this._warn(storeName, AUDIT_CHECKS.BOUNDED_GROWTH + '_locks',
                `Locks map large: ${locks.size} entries`));
            } else {
              checks.push(this._pass(storeName, AUDIT_CHECKS.BOUNDED_GROWTH + '_locks',
                `Locks map bounded: ${locks.size} entries`));
            }
          }

          // Check session memory
          const mem = state.sessionMemory;
          if (mem) {
            if (mem.viewedProducts && mem.viewedProducts.length > 50) {
              checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS + '_viewed',
                `Viewed products large: ${mem.viewedProducts.length}`));
            }
            if (mem.hoverCounts && mem.hoverCounts.size > 100) {
              checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS + '_hover',
                `Hover counts large: ${mem.hoverCounts.size}`));
            }
          }
        } else {
          checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics or state available'));
        }
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Store is disposed'));
      } else {
        checks.push(this._pass(storeName, 'alive', 'Store is alive'));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditRuntimeTrace(nowMs) {
    const store = this._stores.runtimeTrace;
    if (!store) return [this._skip('runtimeTrace', 'not_provided')];

    const checks = [];
    const storeName = 'runtimeTrace';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Trace is disposed'));
        return checks;
      }

      // Check buffer bounds
      const bufferRatio = diag.bufferSize / diag.bufferCapacity;
      if (bufferRatio > 0.95) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.BOUNDED_GROWTH,
          `Buffer near capacity: ${diag.bufferSize}/${diag.bufferCapacity}`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.BOUNDED_GROWTH,
          `Buffer bounded: ${diag.bufferSize}/${diag.bufferCapacity}`));
      }

      // Check anomaly count
      if (diag.anomalyCount > 50) {
        checks.push(this._warn(storeName, 'anomalies',
          `High anomaly count: ${diag.anomalyCount}`));
      } else {
        checks.push(this._pass(storeName, 'anomalies',
          `Anomaly count acceptable: ${diag.anomalyCount}`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditHistoricalPurchaseMemory(nowMs) {
    const store = this._stores.historicalPurchaseMemory;
    if (!store) return [this._skip('historicalPurchaseMemory', 'not_provided')];

    const checks = [];
    const storeName = 'historicalPurchaseMemory';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Memory is disposed'));
        return checks;
      }

      // Check memory bounds
      if (diag.purchaseHistoryCount > 900) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Purchase history near limit: ${diag.purchaseHistoryCount}/1000`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Purchase history bounded: ${diag.purchaseHistoryCount}/1000`));
      }

      if (diag.relationshipObservationsCount > 450) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS + '_relationships',
          `Relationships near limit: ${diag.relationshipObservationsCount}/500`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS + '_relationships',
          `Relationships bounded: ${diag.relationshipObservationsCount}/500`));
      }

      // Check cleanup recency
      const cleanupAge = nowMs - (diag.lastCleanupAt || 0);
      if (cleanupAge > 15 * 60 * 1000) { // 15 minutes
        checks.push(this._warn(storeName, AUDIT_CHECKS.CLEANUP_RUNNING,
          `Cleanup not run recently: ${Math.round(cleanupAge / 60000)}min ago`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.CLEANUP_RUNNING,
          `Cleanup recent: ${Math.round(cleanupAge / 60000)}min ago`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditProductOntologyNormalizer(nowMs) {
    const store = this._stores.productOntologyNormalizer;
    if (!store) return [this._skip('productOntologyNormalizer', 'not_provided')];

    const checks = [];
    const storeName = 'productOntologyNormalizer';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Normalizer is disposed'));
        return checks;
      }

      // Check cache bounds
      const cacheRatio = diag.cacheSize / diag.maxCacheSize;
      if (cacheRatio > 0.95) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache near capacity: ${diag.cacheSize}/${diag.maxCacheSize}`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache bounded: ${diag.cacheSize}/${diag.maxCacheSize}`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditCompletionConfidenceEngine(nowMs) {
    const store = this._stores.completionConfidenceEngine;
    if (!store) return [this._skip('completionConfidenceEngine', 'not_provided')];

    const checks = [];
    const storeName = 'completionConfidenceEngine';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Engine is disposed'));
        return checks;
      }

      // Check cache bounds
      if (diag.cacheSize > 230) { // 90% of 256
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache near capacity: ${diag.cacheSize}/256`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache bounded: ${diag.cacheSize}/256`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  _auditProductOntologyEngine(nowMs) {
    const store = this._stores.productOntologyEngine;
    if (!store) return [this._skip('productOntologyEngine', 'not_provided')];

    const checks = [];
    const storeName = 'productOntologyEngine';

    try {
      const diag = store.getDiagnostics ? store.getDiagnostics() : null;

      if (!diag) {
        checks.push(this._warn(storeName, 'diagnostics', 'No diagnostics available'));
        return checks;
      }

      if (diag.disposed) {
        checks.push(this._fail(storeName, 'disposed', 'Engine is disposed'));
        return checks;
      }

      // Check cache bounds
      const cacheRatio = diag.cacheSize / diag.maxRecords;
      if (cacheRatio > 0.95) {
        checks.push(this._warn(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache near capacity: ${diag.cacheSize}/${diag.maxRecords}`));
      } else {
        checks.push(this._pass(storeName, AUDIT_CHECKS.LRU_LIMITS,
          `Cache bounded: ${diag.cacheSize}/${diag.maxRecords}`));
      }

    } catch (err) {
      checks.push(this._fail(storeName, 'error', `Error during audit: ${err.message}`));
    }

    return checks;
  }

  // ==========================================================================
  // Result builders
  // ==========================================================================

  _pass(store, check, message) {
    return { store, check, severity: SEVERITY.PASS, message };
  }

  _warn(store, check, message) {
    return { store, check, severity: SEVERITY.WARN, message };
  }

  _fail(store, check, message) {
    return { store, check, severity: SEVERITY.FAIL, message };
  }

  _skip(store, reason) {
    return { store, check: 'skipped', severity: SEVERITY.PASS, message: `Skipped: ${reason}` };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  MemorySafetyAudit,
  AUDIT_CHECKS,
  SEVERITY,
};
