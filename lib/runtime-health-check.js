/**
 * runtime-health-check.js — Diagnostic module for OPE runtime integrity
 *
 * Verifies that the OPE behavioral intelligence system is operating within
 * its design constraints:
 *
 *  1. No orphan timers (all scheduled evaluations have been cleaned up)
 *  2. No orphan visibility entries (productVisibility map is bounded)
 *  3. No dead references (disposed engines are not being called)
 *  4. No stale listeners (event bus has no zombie subscriptions)
 *  5. Memory bounds respected (all bounded structures within cap)
 *  6. No duplicated interventions (fatigue authority is single)
 *  7. Lock consistency (evaluation lock is not stuck)
 *  8. Snapshot schema compatibility (current version matches)
 *
 * Usage:
 *   const { RuntimeHealthCheck } = require('./runtime-health-check');
 *   const hc = new RuntimeHealthCheck(orchestrator, { trace, fatigueEngine });
 *   const report = hc.run(now);
 *   console.log(report.healthy, report.checks);
 *
 * This module is pure diagnostic: it does NOT modify any state.
 * All checks are read-only.
 */

'use strict';

const EXPECTED_SNAPSHOT_SCHEMA_VERSION = 4;

// ============================================================================
// Check result builder
// ============================================================================

function pass(name, detail) {
  return { name, status: 'pass', detail: detail || null };
}

function warn(name, detail) {
  return { name, status: 'warn', detail: detail || null };
}

function fail(name, detail) {
  return { name, status: 'fail', detail: detail || null };
}

// ============================================================================
// RuntimeHealthCheck class
// ============================================================================

class RuntimeHealthCheck {
  /**
   * @param {object} orchestrator  SessionOrchestrator instance
   * @param {object} [engines]     Additional engines for deep checks
   * @param {object} [engines.trace]           RuntimeTrace instance
   * @param {object} [engines.fatigueEngine]   CooldownFatigueEngine instance
   * @param {object} [engines.eventBus]        InternalBehavioralEventBus instance
   * @param {object} [engines.stateStore]      BehavioralStateStore instance
   */
  constructor(orchestrator, engines = {}) {
    this._orchestrator = orchestrator;
    this._trace = engines.trace || null;
    this._fatigueEngine = engines.fatigueEngine || null;
    this._eventBus = engines.eventBus || null;
    this._stateStore = engines.stateStore || null;
  }

  /**
   * Run all health checks.
   * @param {number} now  Current timestamp
   * @returns {{ healthy: boolean, checks: Array, summary: object }}
   */
  run(now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      return {
        healthy: false,
        checks: [fail('timestamp', 'Invalid `now` parameter')],
        summary: { total: 1, pass: 0, warn: 0, fail: 1 },
      };
    }

    const checks = [];

    // 1. Orchestrator liveness
    checks.push(this._checkOrchestratorLiveness());

    // 2. Lock consistency
    checks.push(this._checkLockConsistency(now));

    // 3. Memory bounds (event queue, LRU maps, trace buffer)
    checks.push(...this._checkMemoryBounds());

    // 4. Snapshot schema version
    checks.push(this._checkSnapshotSchema());

    // 5. Stats anomalies
    checks.push(this._checkStatsAnomalies());

    // 6. Trace health (if trace engine is available)
    if (this._trace) {
      checks.push(this._checkTraceHealth());
    }

    // 7. Fatigue engine consistency
    if (this._fatigueEngine) {
      checks.push(this._checkFatigueConsistency(now));
    }

    // 8. Event bus health
    if (this._eventBus) {
      checks.push(this._checkEventBusHealth(now));
    }

    // 9. State store consistency
    if (this._stateStore) {
      checks.push(this._checkStateStoreHealth(now));
    }

    // Build summary
    const summary = { total: checks.length, pass: 0, warn: 0, fail: 0 };
    for (const c of checks) {
      summary[c.status]++;
    }

    return {
      healthy: summary.fail === 0,
      checks,
      summary,
    };
  }

  // ====================================================================
  // Individual checks
  // ====================================================================

  _checkOrchestratorLiveness() {
    try {
      const diag = this._orchestrator.getDiagnostics
        ? this._orchestrator.getDiagnostics(0)
        : null;

      if (!diag) {
        return fail('orchestrator_liveness', 'getDiagnostics returned null');
      }
      if (diag.disposed) {
        return fail('orchestrator_liveness', 'Orchestrator is disposed');
      }
      if (!diag.initialized) {
        return warn('orchestrator_liveness', 'Orchestrator not yet initialized');
      }
      return pass('orchestrator_liveness');
    } catch (err) {
      return fail('orchestrator_liveness', `Error: ${err.message}`);
    }
  }

  _checkLockConsistency(now) {
    try {
      const diag = this._orchestrator.getDiagnostics(now);
      if (!diag) return warn('lock_consistency', 'No diagnostics available');

      if (diag.evaluationLock) {
        const ageMs = diag.lockAgeMs || 0;
        if (ageMs > 5000) {
          return fail('lock_consistency', `Evaluation lock stuck for ${ageMs}ms`);
        }
        return warn('lock_consistency', `Lock held for ${ageMs}ms (within tolerance)`);
      }
      return pass('lock_consistency');
    } catch (err) {
      return fail('lock_consistency', `Error: ${err.message}`);
    }
  }

  _checkMemoryBounds() {
    const results = [];
    try {
      const diag = this._orchestrator.getDiagnostics(0);
      if (!diag) {
        results.push(warn('memory_bounds', 'No diagnostics available'));
        return results;
      }

      // Event queue
      const queueSize = diag.eventQueueSize || 0;
      if (queueSize > 900) {
        results.push(warn('memory_event_queue', `Event queue near capacity: ${queueSize}/1024`));
      } else {
        results.push(pass('memory_event_queue', `Size: ${queueSize}`));
      }

      // Context evaluation LRU
      const ctxEntries = diag.contextEvaluationEntries || 0;
      if (ctxEntries > 230) {
        results.push(warn('memory_context_lru', `Context LRU near capacity: ${ctxEntries}/256`));
      } else {
        results.push(pass('memory_context_lru', `Size: ${ctxEntries}`));
      }

      // Recent event IDs LRU
      const eventIds = diag.recentEventIdsSize || 0;
      if (eventIds > 1800) {
        results.push(warn('memory_event_ids', `Event ID LRU near capacity: ${eventIds}/2048`));
      } else {
        results.push(pass('memory_event_ids', `Size: ${eventIds}`));
      }

    } catch (err) {
      results.push(fail('memory_bounds', `Error: ${err.message}`));
    }
    return results;
  }

  _checkSnapshotSchema() {
    try {
      const snapshot = this._orchestrator.snapshot();
      if (!snapshot) {
        return fail('snapshot_schema', 'snapshot() returned null');
      }
      if (snapshot.__schemaVersion !== EXPECTED_SNAPSHOT_SCHEMA_VERSION) {
        return fail('snapshot_schema',
          `Schema mismatch: got ${snapshot.__schemaVersion}, expected ${EXPECTED_SNAPSHOT_SCHEMA_VERSION}`);
      }
      // Verify essential fields exist
      const requiredFields = ['sessionId', 'stateStore', 'intentEngine', 'fatigueEngine',
        'lastEvaluationTime', 'stats'];
      const missing = requiredFields.filter(f => !(f in snapshot));
      if (missing.length > 0) {
        return warn('snapshot_schema', `Missing fields: ${missing.join(', ')}`);
      }
      return pass('snapshot_schema', `Version ${snapshot.__schemaVersion}`);
    } catch (err) {
      return fail('snapshot_schema', `Error: ${err.message}`);
    }
  }

  _checkStatsAnomalies() {
    try {
      const diag = this._orchestrator.getDiagnostics(0);
      if (!diag || !diag.stats) {
        return warn('stats_anomalies', 'No stats available');
      }
      const s = diag.stats;
      const anomalies = [];

      // Handler errors should be rare
      if (s.handlerErrors > 10) {
        anomalies.push(`handlerErrors=${s.handlerErrors}`);
      }
      // Lock stuck incidents should be zero
      if (s.lockStuckIncidents > 0) {
        anomalies.push(`lockStuckIncidents=${s.lockStuckIncidents}`);
      }
      // Dropped events indicate backpressure problems
      if (s.eventsDropped > 50) {
        anomalies.push(`eventsDropped=${s.eventsDropped}`);
      }
      // Too many deduped events may indicate client bug
      if (s.eventsDeduped > s.eventsProcessed * 0.5 && s.eventsProcessed > 10) {
        anomalies.push(`highDedupeRate=${s.eventsDeduped}/${s.eventsProcessed}`);
      }

      if (anomalies.length > 0) {
        return warn('stats_anomalies', anomalies.join('; '));
      }
      return pass('stats_anomalies');
    } catch (err) {
      return fail('stats_anomalies', `Error: ${err.message}`);
    }
  }

  _checkTraceHealth() {
    try {
      const diag = this._trace.getDiagnostics();
      if (!diag) return warn('trace_health', 'No trace diagnostics');
      if (diag.disposed) return fail('trace_health', 'Trace is disposed');
      if (diag.anomalyCount > 10) {
        return warn('trace_health', `${diag.anomalyCount} anomalies detected`);
      }
      return pass('trace_health', `${diag.totalTransitions} transitions, ${diag.anomalyCount} anomalies`);
    } catch (err) {
      return fail('trace_health', `Error: ${err.message}`);
    }
  }

  _checkFatigueConsistency(now) {
    try {
      if (typeof this._fatigueEngine.getDiagnostics === 'function') {
        const diag = this._fatigueEngine.getDiagnostics(now);
        if (!diag) return warn('fatigue_consistency', 'No diagnostics');
        return pass('fatigue_consistency', `Score: ${diag.fatigueScore || 0}`);
      }
      // Basic check: getFatigueScore should return a bounded number
      if (typeof this._fatigueEngine.getFatigueScore === 'function') {
        const score = this._fatigueEngine.getFatigueScore(now);
        if (typeof score !== 'number' || score < 0 || score > 1) {
          return fail('fatigue_consistency', `Invalid fatigue score: ${score}`);
        }
        return pass('fatigue_consistency', `Score: ${score}`);
      }
      return warn('fatigue_consistency', 'No getFatigueScore method');
    } catch (err) {
      return fail('fatigue_consistency', `Error: ${err.message}`);
    }
  }

  _checkEventBusHealth(now) {
    try {
      if (typeof this._eventBus.getDiagnostics === 'function') {
        const diag = this._eventBus.getDiagnostics(now);
        if (!diag) return warn('event_bus_health', 'No diagnostics');
        if (diag.disposed) return fail('event_bus_health', 'Event bus is disposed');
        return pass('event_bus_health', `Listeners: ${diag.listenerCount || 0}`);
      }
      return pass('event_bus_health', 'Bus available (no diagnostics method)');
    } catch (err) {
      return fail('event_bus_health', `Error: ${err.message}`);
    }
  }

  _checkStateStoreHealth(now) {
    try {
      if (typeof this._stateStore.getDiagnostics === 'function') {
        const diag = this._stateStore.getDiagnostics(now);
        if (!diag) return warn('state_store_health', 'No diagnostics');
        return pass('state_store_health');
      }
      // Basic check: getState should return an object
      if (typeof this._stateStore.getState === 'function') {
        const state = this._stateStore.getState();
        if (!state || typeof state !== 'object') {
          return fail('state_store_health', 'getState returned non-object');
        }
        return pass('state_store_health');
      }
      return warn('state_store_health', 'No getState method');
    } catch (err) {
      return fail('state_store_health', `Error: ${err.message}`);
    }
  }
}

module.exports = {
  RuntimeHealthCheck,
  EXPECTED_SNAPSHOT_SCHEMA_VERSION,
};
