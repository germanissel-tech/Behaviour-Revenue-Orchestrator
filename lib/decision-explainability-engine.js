'use strict';

/**
 * decision-explainability-engine.js
 *
 * Registers EXACTLY why an intervention was approved, rejected, delayed,
 * escalated, or suppressed. Every decision is a self-contained, serializable,
 * replay-safe record.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps come from injected `nowMs`.
 *  - NO Math.random() — fully deterministic.
 *  - Bounded memory — circular buffer capped at maxDecisions.
 *  - snapshot() / restore() — full deterministic replay.
 *  - cleanup(nowMs) — purges records older than retentionMs.
 *  - No side-effects — pure recording, no decisions made here.
 *
 * Integration:
 *  - Called by session-orchestrator._evaluateCore() at each gate.
 *  - Records are linkable to intervention-outcome-tracker via decisionId.
 *  - Readable by runtime-health-check for audit integrity.
 *
 * Authority: EXPLAIN only. Does NOT decide. Does NOT rank. Does NOT block.
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

/** Final decision categories */
const DECISION_OUTCOMES = Object.freeze({
  APPROVED:   'approved',    // All gates passed, intervention triggered
  BLOCKED:    'blocked',     // Fatigue/cooldown gate failed
  DENIED:     'denied',      // Policy gate: shouldSuppress or !shouldIntervene
  DELAYED:    'delayed',     // Policy gate: shouldDelay = true
  ESCALATED:  'escalated',   // Promoted to higher-priority family by ranking
  SUPPRESSED: 'suppressed',  // Visibility or presence check failed
  NO_CANDIDATES: 'no_candidates', // Ranking had no candidates to select from
  DRY_RUN:    'dry_run',     // evaluatePreview() — no side effects recorded
});

/** Gate names in evaluation order */
const GATES = Object.freeze([
  'presence',        // presenceEngine.isPresent()
  'context_cooldown', // _lastContextEvaluation LRU throttle
  'fatigue',         // cooldownFatigueEngine.canIntervene()
  'policy',          // evaluateInterventionPolicy()
  'candidates',      // candidateProvider returned results
  'ranking',         // message-ranking-engine selected a candidate
  'visibility',      // visibilityController.canRender()
]);

const DEFAULT_CONFIG = Object.freeze({
  maxDecisions: 2048,       // Circular buffer cap
  retentionMs: 30 * 60 * 1000, // Keep records for 30 minutes
  captureSignals: true,     // Include full signal snapshot per decision
  captureRankingScores: true, // Include per-candidate scores
  captureFatigueSnapshot: true,
  captureLifecycleSnapshot: true,
});

// ============================================================================
// DecisionExplainabilityEngine
// ============================================================================

class DecisionExplainabilityEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.maxDecisions=2048]
   * @param {number} [config.retentionMs=1800000]
   * @param {boolean} [config.captureSignals=true]
   * @param {boolean} [config.captureRankingScores=true]
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    /** @type {Array<DecisionRecord>} */
    this._records = [];
    this._seq = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API — called by session-orchestrator
  // ==========================================================================

  /**
   * Open a new decision record. Returns a builder that the orchestrator
   * fills in as it passes (or fails) each gate, then commits.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.storeId
   * @param {string} params.context
   * @param {string|null} params.productId
   * @param {number} params.nowMs  — injected clock, never Date.now()
   * @returns {DecisionBuilder}
   */
  openDecision({ sessionId, storeId, context, productId, nowMs }) {
    if (this._disposed) throw new Error('DecisionExplainabilityEngine: disposed');
    _assertFiniteNumber(nowMs, 'openDecision.nowMs');

    this._seq++;
    const decisionId = `dec_${sessionId}_${this._seq}_${nowMs}`;

    const record = {
      // Identity
      decisionId,
      seq: this._seq,
      sessionId,
      storeId: storeId || null,
      timestamp: nowMs,

      // Context at decision time
      context,
      productId: productId || null,

      // Behavioral state (filled by builder)
      intentState: null,
      intentConfidence: null,
      funnelStage: null,
      revisitCount: 0,
      hesitationSignals: [],

      // Cart context
      cartContext: null,

      // Signal snapshot (optional, controlled by config)
      signals: null,

      // Gate trace
      gatesPassed: [],
      gatesRejected: [],
      suppressionReasons: [],

      // Fatigue snapshot
      fatigueSnapshot: null,

      // Lifecycle snapshot
      lifecycleSnapshot: null,

      // Ranking output
      rankingScores: null,
      selectedFamily: null,
      selectedSubtype: null,
      selectedCandidateId: null,
      rejectedFamilies: [],

      // Final verdict
      finalDecision: null,   // one of DECISION_OUTCOMES
      reason: null,          // free-text reason for the outcome
      dryRun: false,

      // Linked to outcome tracker
      outcomeId: null,       // filled by intervention-outcome-tracker on linkage
    };

    return new DecisionBuilder(record, this._config, (committed) => {
      this._commit(committed);
    });
  }

  /**
   * Commit a completed record (called internally by DecisionBuilder.commit()).
   * @private
   */
  _commit(record) {
    if (this._disposed) return;
    this._records.push(record);
    // Enforce circular buffer cap
    if (this._records.length > this._config.maxDecisions) {
      this._records.shift();
    }
  }

  // ==========================================================================
  // Query API
  // ==========================================================================

  /**
   * Get a single decision record by decisionId.
   * @param {string} decisionId
   * @returns {object|null}
   */
  getDecision(decisionId) {
    const record = this._records.find(r => r.decisionId === decisionId);
    return record ? { ...record } : null;
  }

  /**
   * Query decisions with optional filters.
   * @param {object} [filter]
   * @param {string} [filter.sessionId]
   * @param {string} [filter.context]
   * @param {string} [filter.productId]
   * @param {string} [filter.finalDecision]  — one of DECISION_OUTCOMES
   * @param {number} [filter.fromTs]
   * @param {number} [filter.toTs]
   * @param {number} [filter.limit]
   * @returns {Array<object>}
   */
  query(filter = {}) {
    let results = this._records;

    if (filter.sessionId) {
      results = results.filter(r => r.sessionId === filter.sessionId);
    }
    if (filter.context) {
      results = results.filter(r => r.context === filter.context);
    }
    if (filter.productId) {
      results = results.filter(r => r.productId === filter.productId);
    }
    if (filter.finalDecision) {
      results = results.filter(r => r.finalDecision === filter.finalDecision);
    }
    if (typeof filter.fromTs === 'number') {
      results = results.filter(r => r.timestamp >= filter.fromTs);
    }
    if (typeof filter.toTs === 'number') {
      results = results.filter(r => r.timestamp <= filter.toTs);
    }
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      results = results.slice(-filter.limit);
    }

    return results.map(r => ({ ...r }));
  }

  /**
   * Return approval rate, block rate, suppression rate for a session.
   * @param {string} sessionId
   * @param {number} [nowMs]  — if provided, respects retentionMs window
   * @returns {object}
   */
  getSessionStats(sessionId, nowMs) {
    const records = this._records.filter(r => {
      if (r.sessionId !== sessionId) return false;
      if (typeof nowMs === 'number') {
        return (nowMs - r.timestamp) <= this._config.retentionMs;
      }
      return true;
    });

    const total = records.length;
    const counts = {};
    for (const outcome of Object.values(DECISION_OUTCOMES)) {
      counts[outcome] = 0;
    }
    for (const r of records) {
      if (r.finalDecision && counts.hasOwnProperty(r.finalDecision)) {
        counts[r.finalDecision]++;
      }
    }

    return {
      sessionId,
      total,
      approvalRate: total > 0 ? counts[DECISION_OUTCOMES.APPROVED] / total : 0,
      blockRate: total > 0 ? counts[DECISION_OUTCOMES.BLOCKED] / total : 0,
      suppressionRate: total > 0 ? counts[DECISION_OUTCOMES.SUPPRESSED] / total : 0,
      counts,
    };
  }

  /**
   * Get a human-readable explanation for a single decision.
   * @param {string} decisionId
   * @returns {string}
   */
  explain(decisionId) {
    const r = this._records.find(rec => rec.decisionId === decisionId);
    if (!r) return `Decision ${decisionId} not found.`;

    const lines = [
      `Decision ${r.decisionId}`,
      `  Session:  ${r.sessionId}`,
      `  Time:     ${r.timestamp}ms`,
      `  Context:  ${r.context} / product: ${r.productId || '—'}`,
      `  Intent:   ${r.intentState} (confidence: ${r.intentConfidence != null ? r.intentConfidence.toFixed(2) : '—'})`,
      `  Funnel:   ${r.funnelStage || '—'}`,
      `  Revisits: ${r.revisitCount}`,
      `  Outcome:  ${r.finalDecision} — ${r.reason || '—'}`,
      `  Gates passed:   [${r.gatesPassed.join(', ')}]`,
      `  Gates rejected: [${r.gatesRejected.join(', ')}]`,
    ];
    if (r.suppressionReasons.length > 0) {
      lines.push(`  Suppression reasons: [${r.suppressionReasons.join(', ')}]`);
    }
    if (r.selectedFamily) {
      lines.push(`  Selected: ${r.selectedFamily} / ${r.selectedSubtype || '—'} (id: ${r.selectedCandidateId || '—'})`);
    }
    if (r.rejectedFamilies.length > 0) {
      lines.push(`  Rejected families: [${r.rejectedFamilies.join(', ')}]`);
    }
    if (r.fatigueSnapshot) {
      lines.push(`  Fatigue score: ${r.fatigueSnapshot.fatigueScore}`);
    }
    return lines.join('\n');
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Remove records older than retentionMs.
   * @param {number} nowMs
   */
  cleanup(nowMs) {
    _assertFiniteNumber(nowMs, 'cleanup.nowMs');
    const cutoff = nowMs - this._config.retentionMs;
    // Records are in chronological order — find split point
    let i = 0;
    while (i < this._records.length && this._records[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) this._records.splice(0, i);
  }

  /**
   * Link a decision to an outcome record (called by intervention-outcome-tracker).
   * @param {string} decisionId
   * @param {string} outcomeId
   */
  linkOutcome(decisionId, outcomeId) {
    const record = this._records.find(r => r.decisionId === decisionId);
    if (record) record.outcomeId = outcomeId;
  }

  dispose() {
    this._disposed = true;
    this._records.length = 0;
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type: 'DecisionExplainabilityEngine',
      __version: SCHEMA_VERSION,
      seq: this._seq,
      records: this._records.map(r => ({ ...r })),
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'DecisionExplainabilityEngine') return false;
    if (snap.__version !== SCHEMA_VERSION) return false;
    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;
    this._records = Array.isArray(snap.records) ? snap.records.map(r => ({ ...r })) : [];
    return true;
  }

  getDiagnostics() {
    return {
      recordCount: this._records.length,
      maxDecisions: this._config.maxDecisions,
      seq: this._seq,
      disposed: this._disposed,
      oldestTimestamp: this._records.length > 0 ? this._records[0].timestamp : null,
      newestTimestamp: this._records.length > 0 ? this._records[this._records.length - 1].timestamp : null,
    };
  }
}

// ============================================================================
// DecisionBuilder — fluent API for orchestrator to fill in a record gate-by-gate
// ============================================================================

class DecisionBuilder {
  /**
   * @param {object} record   The mutable record being built
   * @param {object} config
   * @param {Function} onCommit  Called with the frozen record when commit() fires
   */
  constructor(record, config, onCommit) {
    this._record = record;
    this._config = config;
    this._onCommit = onCommit;
    this._committed = false;
  }

  /** Fluent: set behavioral context fields */
  withBehavioralState({ intentState, intentConfidence, funnelStage, revisitCount, hesitationSignals, cartContext } = {}) {
    this._record.intentState = intentState || null;
    this._record.intentConfidence = typeof intentConfidence === 'number' ? intentConfidence : null;
    this._record.funnelStage = funnelStage || null;
    this._record.revisitCount = typeof revisitCount === 'number' ? revisitCount : 0;
    this._record.hesitationSignals = Array.isArray(hesitationSignals) ? hesitationSignals.slice() : [];
    this._record.cartContext = cartContext || null;
    return this;
  }

  /** Fluent: attach signal snapshot */
  withSignals(signals) {
    if (this._config.captureSignals && signals && typeof signals === 'object') {
      this._record.signals = { ...signals };
    }
    return this;
  }

  /** Fluent: record a gate as passed */
  gatePass(gateName) {
    if (!this._record.gatesPassed.includes(gateName)) {
      this._record.gatesPassed.push(gateName);
    }
    return this;
  }

  /** Fluent: record a gate as rejected with a reason */
  gateReject(gateName, reason) {
    if (!this._record.gatesRejected.includes(gateName)) {
      this._record.gatesRejected.push(gateName);
    }
    if (reason && !this._record.suppressionReasons.includes(reason)) {
      this._record.suppressionReasons.push(reason);
    }
    return this;
  }

  /** Fluent: attach fatigue snapshot */
  withFatigueSnapshot(fatigueSnapshot) {
    if (this._config.captureFatigueSnapshot && fatigueSnapshot) {
      this._record.fatigueSnapshot = { ...fatigueSnapshot };
    }
    return this;
  }

  /** Fluent: attach lifecycle snapshot */
  withLifecycleSnapshot(lifecycleSnapshot) {
    if (this._config.captureLifecycleSnapshot && lifecycleSnapshot) {
      this._record.lifecycleSnapshot = { ...lifecycleSnapshot };
    }
    return this;
  }

  /** Fluent: attach ranking output */
  withRankingResult({ selected, rejected, scores } = {}) {
    if (selected) {
      this._record.selectedFamily = selected.family || null;
      this._record.selectedSubtype = selected.subtype || null;
      this._record.selectedCandidateId = selected.id || null;
    }
    if (Array.isArray(rejected)) {
      this._record.rejectedFamilies = rejected.map(r => (typeof r === 'string' ? r : r.family)).filter(Boolean);
    }
    if (this._config.captureRankingScores && scores && typeof scores === 'object') {
      this._record.rankingScores = { ...scores };
    }
    return this;
  }

  /** Fluent: mark as dry-run */
  asDryRun() {
    this._record.dryRun = true;
    return this;
  }

  /**
   * Commit the decision with its final outcome.
   * @param {string} finalDecision — one of DECISION_OUTCOMES
   * @param {string} [reason]
   * @returns {string} decisionId
   */
  commit(finalDecision, reason) {
    if (this._committed) return this._record.decisionId;
    this._committed = true;
    this._record.finalDecision = finalDecision;
    this._record.reason = reason || null;
    // Freeze is not applied to allow linkOutcome() to patch outcomeId
    this._onCommit(this._record);
    return this._record.decisionId;
  }

  /** Shortcut: approve and commit */
  approve(reason) {
    return this.commit(DECISION_OUTCOMES.APPROVED, reason || 'all_gates_passed');
  }

  /** Shortcut: block (fatigue/cooldown) and commit */
  block(reason) {
    this.gateReject('fatigue', reason);
    return this.commit(DECISION_OUTCOMES.BLOCKED, reason);
  }

  /** Shortcut: deny (policy) and commit */
  deny(reason) {
    this.gateReject('policy', reason);
    return this.commit(DECISION_OUTCOMES.DENIED, reason);
  }

  /** Shortcut: suppress (visibility/presence) and commit */
  suppress(reason) {
    this.gateReject('visibility', reason);
    return this.commit(DECISION_OUTCOMES.SUPPRESSED, reason);
  }

  /** Get the decisionId without committing */
  get decisionId() {
    return this._record.decisionId;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`DecisionExplainabilityEngine: \`${label}\` must be a finite number, got ${val}`);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  DecisionExplainabilityEngine,
  DecisionBuilder,
  DECISION_OUTCOMES,
  GATES,
  SCHEMA_VERSION,
  DEFAULT_CONFIG,
};
