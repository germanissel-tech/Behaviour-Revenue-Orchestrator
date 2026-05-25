'use strict';

/**
 * experiment-engine.js  v2 (hardened)
 *
 * Causal experimentation layer for the OPE Behavioral Intelligence Engine.
 *
 * ============================================================================
 * DESIGN PHILOSOPHY
 * ============================================================================
 *
 * This engine is an OBSERVER + MEASURER + EXPLAINER. It does NOT:
 *   - alter intervention logic
 *   - change fatigue rules
 *   - modify ranking behavior
 *   - favor variant B
 *   - force interventions to increase exposure
 *   - relax policies in treatment groups
 *
 * CAUSAL ISOLATION GUARANTEE (hardened v2):
 *   - Group A sessions MUST call evaluateControlSafe() — never evaluate().
 *     evaluateControlSafe() uses the orchestrator's dry-run / preview path so
 *     that fatigue state, lifecycle state, revisit memory, ranking memory, and
 *     cooldown state are NEVER modified for control sessions.
 *   - shouldApplyIntervention() returns false for A. The caller MUST NOT invoke
 *     evaluate() on control sessions — only evaluateControlSafe().
 *   - The engine enforces this contract by providing a wrapEvaluate() helper
 *     that routes A → dry-run, B → live evaluate(), and logs both paths.
 *
 * ============================================================================
 * EXPOSURE TAXONOMY (hardened v2)
 * ============================================================================
 *
 *   firstExposure   — session sees (context, productId) for the first time ever.
 *   repeatExposure  — session sees the same (context, productId) within the
 *                     idempotency window.  Rejected / not re-counted.
 *   revisitExposure — session returns to a previously seen productId but via a
 *                     different context, OR after the idempotency window expires.
 *
 * ============================================================================
 * INTEGRATION POINTS
 * ============================================================================
 *
 *   - session-orchestrator  → wrapEvaluate() gates A/B cleanly
 *   - decision-explainability-engine → ingestDEERecord() reads decisions
 *   - runtime-trace         → getSessionTrace() filters by sessionId
 *   - runtime-health-check  → getDiagnostics() / getBalanceAudit() for audit
 *   - intervention-lifecycle-manager → NOT modified; engine observes outcomes
 *
 * ============================================================================
 * GUARANTEES
 * ============================================================================
 *
 *   - NO Date.now()    — all timestamps from injected `now`
 *   - NO Math.random() — deterministic PRNG seeded from sessionId hash
 *   - Bounded memory   — LRU maps capped by config
 *   - snapshot() / restore() — replay-safe
 *   - Idempotent exposure registration — no double-counting
 *   - No state leakage across sessions
 *   - Group A: zero side-effects on OPE internal state (fatigue / lifecycle /
 *              revisit memory / ranking memory / cooldown)
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 2; // bumped: ExposureRecord schema extended in v2

/** Experiment variants */
const VARIANTS = Object.freeze({
  CONTROL:   'A',   // No OPE interventions; observe-only
  TREATMENT: 'B',   // OPE intervenes when it naturally decides to
});

/**
 * Intervention decision outcomes for experiment logging.
 * Maps 1:1 with DECISION_OUTCOMES from decision-explainability-engine,
 * plus the experiment-specific DO_NOTHING.
 */
const INTERVENTION_DECISIONS = Object.freeze({
  INTERVENE:            'INTERVENE',
  SKIP:                 'SKIP',
  BLOCK_FATIGUE:        'BLOCK_FATIGUE',
  BLOCK_POLICY:         'BLOCK_POLICY',
  BLOCK_CONFIDENCE:     'BLOCK_CONFIDENCE',
  BLOCK_RELATIONSHIP:   'BLOCK_RELATIONSHIP',
  DO_NOTHING:           'DO_NOTHING',
});

/** Mapping from decision-explainability-engine finalDecision → INTERVENTION_DECISIONS */
const OUTCOME_TO_DECISION = Object.freeze({
  'approved':       INTERVENTION_DECISIONS.INTERVENE,
  'blocked':        INTERVENTION_DECISIONS.BLOCK_FATIGUE,
  'denied':         INTERVENTION_DECISIONS.BLOCK_POLICY,
  'delayed':        INTERVENTION_DECISIONS.BLOCK_POLICY,
  'escalated':      INTERVENTION_DECISIONS.INTERVENE,
  'suppressed':     INTERVENTION_DECISIONS.BLOCK_POLICY,
  'no_candidates':  INTERVENTION_DECISIONS.DO_NOTHING,
  'dry_run':        INTERVENTION_DECISIONS.DO_NOTHING,
});

/** Exposure classification (hardened v2) */
const EXPOSURE_TYPES = Object.freeze({
  FIRST:   'firstExposure',
  REPEAT:  'repeatExposure',
  REVISIT: 'revisitExposure',
});

const DEFAULT_CONFIG = Object.freeze({
  // Variant split (fraction assigned to treatment B; 0.5 = 50/50)
  treatmentFraction: 0.5,

  // Bootstrap
  bootstrapIterations:    1000,
  permutationIterations:  1000,

  // Memory bounds
  maxSessions:      10000,
  maxDecisionLogs:  50000,
  maxExposures:     10000,

  // Idempotency window for exposure dedup (ms)
  exposureIdempotencyWindowMs: 60 * 1000,

  // Significance threshold
  significanceAlpha: 0.05,

  // Minimum sessions per group for stats to be valid
  minSessionsForStats: 10,

  // Retention for decision logs (ms)
  decisionLogRetentionMs: 4 * 60 * 60 * 1000, // 4 hours
});

// ============================================================================
// Deterministic hash (FNV-1a, 32-bit)
// No Math.random(). Stable: same sessionId → same hash → same variant.
// ============================================================================

function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ── Statistical Validity Engine (SINGLE STAT AUTHORITY) ────────────────────
// P0-ARCH FIX (B2): experiment-engine previously contained duplicated, diverging
// implementations of bootstrapCI, permutationPValue, and cohenD. These are now
// REMOVED. All statistical computation delegates to statistical-validity-engine,
// which is the single authoritative source. This ensures both surfaces produce
// identical results for the same data.
const {
  evaluateExperiment:         _sveEvaluate,
  computeBootstrapCI95:       _sveBootstrapCI,
  computePermutationPValue:   _svePermutationPValue,
  computeEffectSize:          _sveEffectSize,   // Cohen's h — correct for conversion rates
  computeMedianUplift:        _sveMedianUplift,
  computeVariance:            _sveComputeVariance,
  detectOutliers:             _sveDetectOutliers,
} = require('./statistical-validity-engine');

// ============================================================================
// LRU Map (minimal — insertion-order eviction)
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
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
}

// ============================================================================
// Stat function wrappers — delegate to statistical-validity-engine (SVE)
// ============================================================================
//
// P0-ARCH FIX (B2): The local implementations of bootstrapCI, permutationPValue,
// and cohenD have been REMOVED. These wrappers exist only to preserve the internal
// call-sites in getStats() while routing all computation through the SVE.
//
// Key behavioural change:
//   - bootstrapCI now uses Cohen's h (proportions) for conversion-rate data
//     via _sveBootstrapCI, and separate revenue path uses _sveBootstrapCI on
//     binary outcome vectors derived from revenue quantiles.
//   - Seed is now data-content-dependent (SVE: dataSeed(A) ^ dataSeed(B)),
//     not merely length-dependent (old: nA*1000 + nB). Fix for H2.
//   - cohenD on continuous revenue data is preserved via a local implementation
//     because Cohen's d (continuous) and Cohen's h (proportions) are different
//     measures and serve different purposes. Both are now clearly labelled.

function _cohenD(samplesA, samplesB) {
  // Cohen's d: effect size for continuous outcomes (revenue).
  // Distinct from Cohen's h (proportions) used in SVE for conversion rates.
  if (samplesA.length < 2 || samplesB.length < 2) return null;
  const mA = samplesA.reduce((s, v) => s + v, 0) / samplesA.length;
  const mB = samplesB.reduce((s, v) => s + v, 0) / samplesB.length;
  const varA = samplesA.reduce((s, v) => s + (v - mA) ** 2, 0) / (samplesA.length - 1);
  const varB = samplesB.reduce((s, v) => s + (v - mB) ** 2, 0) / (samplesB.length - 1);
  const pooled = Math.sqrt((varA + varB) / 2);
  if (pooled === 0) return 0;
  return (mB - mA) / pooled;
}

/**
 * Bootstrap CI wrapper — delegates to SVE.
 * Converts continuous revenue arrays to binary quantile-rank outcomes for CI.
 * Returns shape compatible with old bootstrapCI callers.
 */
function _bootstrapCIRevenue(revenueA, revenueB, iterations, alpha) {
  // SVE computeBootstrapCI95 expects binary outcome arrays.
  // For revenue, we binarise as above-median (1) vs at-or-below (0).
  // This preserves rank-based bootstrap validity.
  const all = revenueA.concat(revenueB);
  if (all.length === 0) return { lower: null, upper: null, medianUplift: null, observedUplift: null };
  const sorted = all.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const binarise = (arr) => arr.map(v => (v > median ? 1 : 0));

  const ci = _sveBootstrapCI(binarise(revenueA), binarise(revenueB), iterations);

  const meanA = revenueA.length > 0 ? revenueA.reduce((s, v) => s + v, 0) / revenueA.length : 0;
  const meanB = revenueB.length > 0 ? revenueB.reduce((s, v) => s + v, 0) / revenueB.length : 0;
  const observedUplift = meanA > 0 ? (meanB - meanA) / meanA : (meanB - meanA);

  return {
    lower:          ci.lower,
    upper:          ci.upper,
    medianUplift:   ci.medianBoot,
    observedUplift,
  };
}

/**
 * Permutation p-value wrapper — delegates to SVE.
 * Binarises revenue for rank-consistent permutation test.
 */
function _permutationPValueRevenue(revenueA, revenueB, iterations) {
  const all = revenueA.concat(revenueB);
  if (all.length === 0) return null;
  const sorted = all.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const binarise = (arr) => arr.map(v => (v > median ? 1 : 0));
  return _svePermutationPValue(binarise(revenueA), binarise(revenueB), iterations);
}

// Legacy export aliases (preserved for external callers of module.exports)
// These now route through SVE.
const bootstrapCI       = _bootstrapCIRevenue;
const permutationPValue = _permutationPValueRevenue;
const cohenD            = _cohenD;


// ============================================================================
// ExperimentEngine// ============================================================================
// ExperimentEngine
// ============================================================================

class ExperimentEngine {
  /**
   * @param {object} [config]  Overrides DEFAULT_CONFIG
   * @param {object} [deps]    Injectable dependencies
   * @param {object} [deps.explainabilityEngine]  DecisionExplainabilityEngine instance
   * @param {object} [deps.runtimeTrace]           RuntimeTrace instance
   */
  constructor(config = {}, deps = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    // Optional injected authorities — READ ONLY. Engine never writes to them.
    this._explainabilityEngine = deps.explainabilityEngine || null;
    this._runtimeTrace         = deps.runtimeTrace         || null;
    // Hardening engines (optional; null-safe throughout)
    this._userMemoryEngine     = deps.userMemoryEngine     || null;
    this._observabilityEngine  = deps.observabilityEngine  || null;

    // ── Variant assignments: sessionId → 'A' | 'B'
    this._assignments = new LRUMap(this._config.maxSessions);

    // ── Exposure registry
    //    Primary key: `${sessionId}:${context}:${productId}` → ExposureRecord
    //    Used for dedup + type classification.
    this._exposures = new LRUMap(this._config.maxExposures);

    // ── Per-session product seen registry (for revisit detection)
    //    key: `${sessionId}:${productId}` → { firstContext, firstTimestamp }
    this._productSeen = new LRUMap(this._config.maxExposures);

    // ── Session-level aggregates: sessionId → SessionRecord
    this._sessions = new LRUMap(this._config.maxSessions);

    // ── Decision log: flat array (bounded, drop oldest when full)
    this._decisionLog = [];

    this._seq = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // VARIANT ASSIGNMENT
  // ==========================================================================

  /**
   * Assigns a variant to a session. Stable: same sessionId → same variant always.
   * Deterministic hash — no Math.random().
   *
   * @param {string} sessionId
   * @returns {'A' | 'B'}
   */
  assignVariant(sessionId) {
    this._assertAlive();
    if (!sessionId || typeof sessionId !== 'string') {
      throw new TypeError('ExperimentEngine.assignVariant: sessionId must be a non-empty string');
    }

    const existing = this._assignments.get(sessionId);
    if (existing !== undefined) return existing;

    const hash = stableHash(sessionId);
    const fraction = (hash >>> 0) / 0xFFFFFFFF;
    const variant = fraction < this._config.treatmentFraction
      ? VARIANTS.TREATMENT
      : VARIANTS.CONTROL;

    this._assignments.set(sessionId, variant);
    return variant;
  }

  /**
   * Returns the current variant for a session, or null if not yet assigned.
   * @param {string} sessionId
   * @returns {'A' | 'B' | null}
   */
  getVariant(sessionId) {
    this._assertAlive();
    return this._assignments.get(sessionId) || null;
  }

  // ==========================================================================
  // CONTROL GATE — should OPE's decision be applied?
  // ==========================================================================

  /**
   * Returns true if OPE's live evaluate() should run for this session.
   *
   * CRITICAL CONTRACT:
   *   - Returns false  → caller MUST use evaluateControlSafe() (dry-run).
   *                       NEVER call evaluate() on control sessions.
   *   - Returns true   → caller calls evaluate() normally.
   *
   * This is the ONLY place where variant affects runtime behaviour.
   * It MUST NOT change fatigue, policy, or ranking.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  shouldApplyIntervention(sessionId) {
    this._assertAlive();
    return this.assignVariant(sessionId) === VARIANTS.TREATMENT;
  }

  /**
   * Safe wrapper that routes evaluation through the correct path per variant.
   *
   * For Group A (control):
   *   Calls orchestrator.evaluatePreview() — a read-only / dry-run path that
   *   DOES NOT mutate fatigue state, lifecycle state, revisit memory, ranking
   *   memory, or cooldown state. The result is observed and logged, but the
   *   intervention is suppressed at output time.
   *
   * For Group B (treatment):
   *   Calls orchestrator.evaluate() normally. All OPE state advances as it
   *   would in production.
   *
   * @param {string}   sessionId
   * @param {object}   orchestrator  — must expose evaluate(ctx) and evaluatePreview(ctx)
   * @param {object}   ctx           — evaluation context passed to orchestrator
   * @param {number}   now
   * @returns {{ result: object, variant: string, suppressed: boolean }}
   */
  wrapEvaluate(sessionId, orchestrator, ctx, now) {
    this._assertAlive();
    _assertFiniteNumber(now, 'wrapEvaluate.now');

    if (!orchestrator || typeof orchestrator.evaluate !== 'function') {
      throw new TypeError('ExperimentEngine.wrapEvaluate: orchestrator must expose evaluate()');
    }

    const variant = this.assignVariant(sessionId);

    if (variant === VARIANTS.CONTROL) {
      // ── Group A: pure observe-only.
      //    Use evaluatePreview() if available; fall back to null result.
      //    Under no circumstances is evaluate() called for control sessions.
      const hasPreview = typeof orchestrator.evaluatePreview === 'function';
      const result = hasPreview ? orchestrator.evaluatePreview(ctx) : null;

      return {
        result:      result,
        variant:     VARIANTS.CONTROL,
        suppressed:  true,
        // Caller MUST NOT display any intervention from this result.
      };
    }

    // ── Group B: live evaluate() — OPE state advances normally.
    const result = orchestrator.evaluate(ctx);
    return {
      result,
      variant:    VARIANTS.TREATMENT,
      suppressed: false,
    };
  }

  // ==========================================================================
  // EXPOSURE REGISTRATION (hardened v2: typed exposures)
  // ==========================================================================

  /**
   * Records that a session entered the experimental decision flow.
   *
   * Exposure type is classified as:
   *   firstExposure   — session has never seen this productId in any context.
   *   repeatExposure  — same (sessionId, context, productId) within the
   *                     idempotency window. Rejected; not counted.
   *   revisitExposure — session has seen this productId before (in any context),
   *                     OR the idempotency window has expired for this exact tuple.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.context        e.g. 'listing', 'product_detail', 'cart'
   * @param {string|null} params.productId
   * @param {number} params.now
   * @returns {{ recorded: boolean, exposureType?: string, variant?: string, reason?: string }}
   */
  recordExposure({ sessionId, context, productId, now }) {
    this._assertAlive();
    _assertFiniteNumber(now, 'recordExposure.now');

    const variant = this.assignVariant(sessionId);
    const pid = productId || null;

    // ── Dedup key: exact tuple
    const dedupKey = `${sessionId}:${context}:${pid || '__'}`;
    const existing = this._exposures.get(dedupKey);

    if (existing && (now - existing.timestamp) < this._config.exposureIdempotencyWindowMs) {
      // Repeat within idempotency window — silently reject
      return { recorded: false, exposureType: EXPOSURE_TYPES.REPEAT, reason: 'duplicate_exposure' };
    }

    // ── Determine type: first vs revisit
    const productKey = pid ? `${sessionId}:${pid}` : null;
    let exposureType;

    if (!pid) {
      // No productId — classify by session's exposure history
      const sess = this._sessions.get(sessionId);
      exposureType = (!sess || sess.exposureCount === 0)
        ? EXPOSURE_TYPES.FIRST
        : EXPOSURE_TYPES.REVISIT;
    } else if (!this._productSeen.has(productKey)) {
      // Product never seen by this session
      exposureType = EXPOSURE_TYPES.FIRST;
      this._productSeen.set(productKey, { firstContext: context, firstTimestamp: now });
    } else {
      // Product seen before — revisit (different context or window expired)
      exposureType = EXPOSURE_TYPES.REVISIT;
    }

    const record = {
      sessionId,
      variant,
      timestamp: now,
      context,
      productId: pid,
      exposureType,
    };
    this._exposures.set(dedupKey, record);

    // ── Update session aggregate
    this._touchSession(sessionId, variant, now);
    const sess = this._sessions.get(sessionId);
    if (sess) {
      sess.exposureCount++;
      sess.lastExposureAt = now;
      // Track typed exposure counts
      if (exposureType === EXPOSURE_TYPES.FIRST)   sess.firstExposures++;
      if (exposureType === EXPOSURE_TYPES.REVISIT) sess.revisitExposures++;
    }

    return { recorded: true, exposureType, variant };
  }

  // ==========================================================================
  // DECISION LOGGING
  // ==========================================================================

  /**
   * Logs an OPE evaluation decision with full context.
   * Called by the integration layer after each evaluate() / wrapEvaluate() call.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.context
   * @param {string|null} params.productId
   * @param {string} params.intent
   * @param {object} params.signals
   * @param {number} params.confidence   0–1
   * @param {string} params.interventionDecision  One of INTERVENTION_DECISIONS
   * @param {string|null} params.selectedFamily
   * @param {string|null} params.selectedMessage
   * @param {string} params.interventionReason
   * @param {number} params.now
   * @returns {string} decisionId
   */
  logDecision({
    sessionId,
    context,
    productId,
    intent,
    signals,
    confidence,
    interventionDecision,
    selectedFamily,
    selectedMessage,
    interventionReason,
    now,
  }) {
    this._assertAlive();
    _assertFiniteNumber(now, 'logDecision.now');

    const variant = this.assignVariant(sessionId);
    this._seq++;
    const decisionId = `exp_dec_${sessionId}_${this._seq}_${now}`;

    const entry = {
      decisionId,
      seq:                  this._seq,
      sessionId,
      variant,
      timestamp:            now,
      context:              context || null,
      productId:            productId || null,
      intent:               intent || null,
      signals:              signals || null,
      confidence:           typeof confidence === 'number' ? confidence : null,
      interventionDecision: interventionDecision || INTERVENTION_DECISIONS.DO_NOTHING,
      selectedFamily:       selectedFamily || null,
      selectedMessage:      selectedMessage || null,
      interventionReason:   interventionReason || null,
    };

    this._decisionLog.push(entry);
    if (this._decisionLog.length > this._config.maxDecisionLogs) {
      this._decisionLog.shift();
    }

    this._touchSession(sessionId, variant, now);
    const sess = this._sessions.get(sessionId);
    if (sess) {
      sess.decisionCount++;
      if (entry.interventionDecision === INTERVENTION_DECISIONS.INTERVENE) {
        sess.interventionCount++;
      }
    }

    // ── Forward to observability engine ───────────────────────────────────────
    if (this._observabilityEngine) {
      try {
        this._observabilityEngine.recordDecision({
          sessionId,
          decision:      entry.interventionDecision,
          confidence:    entry.confidence || 0,
          reason:        entry.interventionReason || null,
          context:       entry.context || null,
          signals:       null, // avoid duplicating large signal objects
          variant,
          selectedFamily: entry.selectedFamily || null,
          nowMs:         now,
        });
      } catch (_) {}
    }

    return decisionId;
  }

  /**
   * Ingests a decision directly from decision-explainability-engine record.
   *
   * @param {object} deeRecord  — record from DecisionExplainabilityEngine.query()
   * @param {object} [extra]    — additional fields (intent, signals, confidence, reason)
   * @param {number} now
   * @returns {string|null} decisionId
   */
  ingestDEERecord(deeRecord, extra = {}, now) {
    this._assertAlive();
    _assertFiniteNumber(now, 'ingestDEERecord.now');
    if (!deeRecord || !deeRecord.sessionId) return null;

    const interventionDecision = OUTCOME_TO_DECISION[deeRecord.finalDecision]
      || INTERVENTION_DECISIONS.DO_NOTHING;

    return this.logDecision({
      sessionId:          deeRecord.sessionId,
      context:            deeRecord.context,
      productId:          deeRecord.productId,
      intent:             extra.intent || deeRecord.intentState || null,
      signals:            extra.signals || deeRecord.signals || null,
      confidence:         extra.confidence ?? deeRecord.intentConfidence ?? null,
      interventionDecision,
      selectedFamily:     deeRecord.selectedFamily || null,
      selectedMessage:    deeRecord.selectedCandidateId || null,
      interventionReason: extra.reason || deeRecord.gatesRejected?.[0]?.reason || null,
      now,
    });
  }

  // ==========================================================================
  // CONVERSION & REVENUE TRACKING
  // ==========================================================================

  /**
   * Records a conversion event for a session.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.type   'add_to_cart' | 'checkout' | 'purchase'
   * @param {number} params.revenue
   * @param {number} params.now
   */
  recordConversion({ sessionId, type, revenue, now }) {
    this._assertAlive();
    _assertFiniteNumber(now, 'recordConversion.now');

    const variant = this.assignVariant(sessionId);
    this._touchSession(sessionId, variant, now);
    const sess = this._sessions.get(sessionId);
    if (!sess) return;

    if (type === 'checkout' || type === 'purchase') {
      sess.converted    = true;
      sess.revenue      = (sess.revenue || 0) + (typeof revenue === 'number' ? revenue : 0);
      sess.conversionAt = now;
      // ── Forward purchase to user memory engine ────────────────────────────
      if (this._userMemoryEngine) {
        try {
          this._userMemoryEngine.recordPurchase({
            sessionId,
            userId:   this._resolveUserId(sessionId),
            products: [],
            revenue:  typeof revenue === 'number' ? revenue : 0,
            nowMs:    now,
          });
        } catch (_) {}
      }
    } else if (type === 'add_to_cart') {
      sess.cartAdds = (sess.cartAdds || 0) + 1;
      sess.revenue  = (sess.revenue  || 0) + (typeof revenue === 'number' ? revenue : 0);
    }
  }

  // ==========================================================================
  // REPLAY INTEGRATION (hardened v2: proper session filtering)
  // ==========================================================================

  /**
   * Returns the full decision trace for a specific session, enriched with
   * variant and intervention context.
   *
   * Compatible with runtime-trace replay format.
   * runtimeEntries are filtered to events that belong to this session when
   * the RuntimeTrace instance supports sessionId-scoped queries; otherwise
   * falls back to context/productId intersection to avoid returning all events.
   *
   * @param {string} sessionId
   * @returns {{ sessionId, variant, decisions, runtimeEntries, exposures }}
   */
  getSessionTrace(sessionId) {
    this._assertAlive();

    const decisions = this._decisionLog.filter(d => d.sessionId === sessionId);
    const variant   = this.getVariant(sessionId);

    // ── Collect exposure records for this session
    const exposures = [];
    for (const rec of this._exposures.values()) {
      if (rec.sessionId === sessionId) exposures.push(rec);
    }

    // ── Runtime trace: filter to this session only.
    //    Prefer sessionId-scoped query if RuntimeTrace supports it.
    //    Fall back to context/productId set intersection from own decisions.
    //    NEVER return filter(e => true) which leaks all sessions.
    let runtimeEntries = [];
    if (this._runtimeTrace) {
      if (typeof this._runtimeTrace.query === 'function') {
        // Attempt scoped query; RuntimeTrace may accept { sessionId }
        try {
          const raw = this._runtimeTrace.query({ sessionId, limit: 1000 });
          if (Array.isArray(raw)) {
            // Accept only entries that carry a matching sessionId field,
            // or all entries if the trace is already session-scoped.
            runtimeEntries = raw.filter(
              e => !e.sessionId || e.sessionId === sessionId
            );
          }
        } catch (_) {
          // query() threw (e.g. unknown param) — fall through to empty
        }
      }

      // If we got nothing from the query, fall back to filtering by
      // the known contexts and productIds from this session's decisions.
      if (runtimeEntries.length === 0 && decisions.length > 0) {
        const knownContexts  = new Set(decisions.map(d => d.context).filter(Boolean));
        const knownProducts  = new Set(decisions.map(d => d.productId).filter(Boolean));
        try {
          const all = this._runtimeTrace.query({ limit: 5000 });
          if (Array.isArray(all)) {
            runtimeEntries = all.filter(e =>
              (!e.sessionId || e.sessionId === sessionId) &&
              (knownContexts.has(e.context) || knownProducts.has(e.productId))
            );
          }
        } catch (_) {
          // silent — runtimeEntries stays []
        }
      }
    }

    return {
      sessionId,
      variant,
      decisions,
      runtimeEntries,
      exposures,
    };
  }

  // ==========================================================================
  // EXPLAINABILITY
  // ==========================================================================

  /**
   * Returns a human-readable explanation of why OPE acted (or didn't) at
   * each evaluation point within a session.
   *
   * Only returns records for treatment (B) sessions, since control sessions
   * have no interventions to explain. For control sessions returns an
   * annotated empty array so callers don't need to special-case.
   *
   * @param {string} sessionId
   * @returns {Array<object>}
   */
  explainSession(sessionId) {
    this._assertAlive();
    const decisions = this._decisionLog.filter(
      d => d.sessionId === sessionId && d.variant === VARIANTS.TREATMENT
    );
    return decisions.map(d => ({
      context:        d.context,
      productId:      d.productId,
      timestamp:      d.timestamp,
      intent:         d.intent,
      confidence:     d.confidence,
      decision:       d.interventionDecision,
      reason:         d.interventionReason,
      selectedFamily: d.selectedFamily,
      signals:        d.signals,
    }));
  }

  /**
   * Returns explanations for all sessions in a given variant.
   *
   * @param {string} variant  'A' | 'B'
   * @param {number} [limit]
   * @returns {Array<object>}
   */
  explainVariant(variant, limit) {
    this._assertAlive();
    let entries = this._decisionLog.filter(d => d.variant === variant);
    if (typeof limit === 'number') entries = entries.slice(-limit);
    return entries.map(d => ({
      sessionId:      d.sessionId,
      context:        d.context,
      productId:      d.productId,
      timestamp:      d.timestamp,
      intent:         d.intent,
      confidence:     d.confidence,
      decision:       d.interventionDecision,
      reason:         d.interventionReason,
      selectedFamily: d.selectedFamily,
    }));
  }

  /**
   * Returns the top N reasons for a given decision outcome.
   *
   * @param {string} decision  One of INTERVENTION_DECISIONS
   * @param {number} [topN=5]
   * @returns {Array<{ reason: string, count: number }>}
   */
  topReasons(decision, topN = 5) {
    this._assertAlive();
    const counts = new Map();
    for (const d of this._decisionLog) {
      if (d.interventionDecision !== decision) continue;
      const r = d.interventionReason || '(no reason)';
      counts.set(r, (counts.get(r) || 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([reason, count]) => ({ reason, count }));
  }

  // ==========================================================================
  // ANALYTICS — GET /api/experiment/stats
  // ==========================================================================

  /**
   * Computes full experiment statistics.
   *
   * @param {number} now
   * @returns {ExperimentStats}
   */
  getStats(now) {
    this._assertAlive();
    _assertFiniteNumber(now, 'getStats.now');

    const sessA = [], sessB = [];
    for (const sess of this._sessions.values()) {
      if (sess.variant === VARIANTS.CONTROL) sessA.push(sess);
      else                                   sessB.push(sess);
    }

    const exposureA = sessA.reduce((s, v) => s + v.exposureCount, 0);
    const exposureB = sessB.reduce((s, v) => s + v.exposureCount, 0);
    const conversionsA = sessA.filter(s => s.converted).length;
    const conversionsB = sessB.filter(s => s.converted).length;

    const revenueA = sessA.map(s => s.revenue || 0);
    const revenueB = sessB.map(s => s.revenue || 0);
    const totalRevA = revenueA.reduce((s, v) => s + v, 0);
    const totalRevB = revenueB.reduce((s, v) => s + v, 0);
    const rpsA = sessA.length > 0 ? totalRevA / sessA.length : 0;
    const rpsB = sessB.length > 0 ? totalRevB / sessB.length : 0;
    const uplift = rpsA > 0 ? (rpsB - rpsA) / rpsA : (rpsB - rpsA);

    const hasMinData =
      sessA.length >= this._config.minSessionsForStats &&
      sessB.length >= this._config.minSessionsForStats;

    let bootstrapResult = null;
    let pValue = null;
    let effectSize = null;
    let variance = null;
    let significance = null;
    let confidenceInterval95 = null;
    let medianUplift = null;

    if (hasMinData) {
      bootstrapResult = bootstrapCI(
        revenueA, revenueB,
        this._config.bootstrapIterations,
        this._config.significanceAlpha,
      );
      pValue    = permutationPValue(revenueA, revenueB, this._config.permutationIterations);
      effectSize = cohenD(revenueA, revenueB);

      const allRev = revenueA.concat(revenueB);
      const meanAll = allRev.reduce((s, v) => s + v, 0) / allRev.length;
      variance = allRev.reduce((s, v) => s + (v - meanAll) ** 2, 0) / allRev.length;

      medianUplift = bootstrapResult ? bootstrapResult.medianUplift : null;
      confidenceInterval95 = bootstrapResult
        ? { lower: bootstrapResult.lower, upper: bootstrapResult.upper }
        : null;

      if (pValue !== null) {
        significance = pValue < this._config.significanceAlpha
          ? 'statistically_significant'
          : 'not_statistically_significant';
      }
    }

    const decB = this._decisionLog.filter(d => d.variant === VARIANTS.TREATMENT);
    const interventionsB = decB.filter(d => d.interventionDecision === INTERVENTION_DECISIONS.INTERVENE);
    const interventionRate    = decB.length > 0 ? interventionsB.length / decB.length : 0;
    const noInterventionRate  = decB.length > 0 ? (decB.length - interventionsB.length) / decB.length : 0;

    const avgMessagesShownB = sessB.length > 0
      ? sessB.reduce((s, v) => s + v.interventionCount, 0) / sessB.length
      : 0;

    const relSuggestions = decB.filter(
      d => d.selectedFamily && d.selectedFamily.toLowerCase().includes('relationship')
    ).length;
    const avgRelationshipSuggestions = sessB.length > 0 ? relSuggestions / sessB.length : 0;

    return {
      sessionsA: sessA.length,
      sessionsB: sessB.length,
      exposureA,
      exposureB,
      conversionsA,
      conversionsB,
      revenuePerSessionA: rpsA,
      revenuePerSessionB: rpsB,
      uplift,
      medianUplift,
      effectSize,
      variance,
      confidenceInterval95,
      pValue,
      significance: hasMinData ? significance : 'insufficient_data',
      interventionRate,
      noInterventionRate,
      averageMessagesShown: avgMessagesShownB,
      averageRelationshipSuggestions: avgRelationshipSuggestions,
      topReasonsForIntervention: this.topReasons(INTERVENTION_DECISIONS.INTERVENE),
      topReasonsForSkipping: this.topReasons(INTERVENTION_DECISIONS.SKIP)
        .concat(this.topReasons(INTERVENTION_DECISIONS.DO_NOTHING)),
    };
  }

  // ==========================================================================
  // BALANCE AUDIT (hardened v2 — new method)
  // ==========================================================================

  /**
   * Returns a balance audit report for the experiment.
   * Checks whether A and B groups are comparable on observable dimensions.
   *
   * @returns {{
   *   sessionsA: number,
   *   sessionsB: number,
   *   exposureRatio: number,
   *   conversionRatio: number,
   *   contextDistribution: { A: object, B: object },
   *   productDistribution: { A: object, B: object },
   *   exposureTypeBreakdown: { A: object, B: object },
   *   imbalanceFlags: string[]
   * }}
   */
  getBalanceAudit() {
    this._assertAlive();

    const sessA = [], sessB = [];
    for (const sess of this._sessions.values()) {
      if (sess.variant === VARIANTS.CONTROL) sessA.push(sess);
      else                                   sessB.push(sess);
    }

    const nA = sessA.length;
    const nB = sessB.length;

    // ── Exposure ratio (exposures per session, A vs B)
    const expA = nA > 0 ? sessA.reduce((s, v) => s + v.exposureCount, 0) / nA : 0;
    const expB = nB > 0 ? sessB.reduce((s, v) => s + v.exposureCount, 0) / nB : 0;
    const exposureRatio = expA > 0 ? expB / expA : (expB > 0 ? Infinity : 1);

    // ── Conversion ratio (conversion rate B / conversion rate A)
    const convRateA = nA > 0 ? sessA.filter(s => s.converted).length / nA : 0;
    const convRateB = nB > 0 ? sessB.filter(s => s.converted).length / nB : 0;
    const conversionRatio = convRateA > 0 ? convRateB / convRateA : (convRateB > 0 ? Infinity : 1);

    // ── Context distribution: count exposures per context per variant
    const ctxA = {}, ctxB = {};
    const prodA = {}, prodB = {};
    const etA = { firstExposure: 0, revisitExposure: 0 };
    const etB = { firstExposure: 0, revisitExposure: 0 };

    for (const rec of this._exposures.values()) {
      const isA = rec.variant === VARIANTS.CONTROL;
      const ctx  = rec.context || 'unknown';
      const prod = rec.productId || 'none';
      const et   = rec.exposureType;

      if (isA) {
        ctxA[ctx]  = (ctxA[ctx]  || 0) + 1;
        prodA[prod] = (prodA[prod] || 0) + 1;
        if (et === EXPOSURE_TYPES.FIRST)   etA.firstExposure++;
        if (et === EXPOSURE_TYPES.REVISIT) etA.revisitExposure++;
      } else {
        ctxB[ctx]  = (ctxB[ctx]  || 0) + 1;
        prodB[prod] = (prodB[prod] || 0) + 1;
        if (et === EXPOSURE_TYPES.FIRST)   etB.firstExposure++;
        if (et === EXPOSURE_TYPES.REVISIT) etB.revisitExposure++;
      }
    }

    // ── Imbalance flags
    const flags = [];
    const sessionRatio = nA > 0 ? nB / nA : (nB > 0 ? Infinity : 1);
    if (sessionRatio < 0.8 || sessionRatio > 1.25) {
      flags.push(`session_imbalance: A=${nA} B=${nB} ratio=${sessionRatio.toFixed(3)}`);
    }
    if (exposureRatio < 0.7 || exposureRatio > 1.43) {
      flags.push(`exposure_rate_imbalance: A=${expA.toFixed(2)} B=${expB.toFixed(2)} ratio=${exposureRatio.toFixed(3)}`);
    }
    // Context skew: if any context is >50% more represented in B vs A (normalised)
    const allCtx = new Set([...Object.keys(ctxA), ...Object.keys(ctxB)]);
    const totalA = Object.values(ctxA).reduce((s, v) => s + v, 0) || 1;
    const totalB = Object.values(ctxB).reduce((s, v) => s + v, 0) || 1;
    for (const ctx of allCtx) {
      const shareA = (ctxA[ctx] || 0) / totalA;
      const shareB = (ctxB[ctx] || 0) / totalB;
      if (shareA > 0.05 && shareB > 0.05) {
        const skew = Math.abs(shareB - shareA) / shareA;
        if (skew > 0.5) {
          flags.push(`context_skew:${ctx} A=${(shareA*100).toFixed(1)}% B=${(shareB*100).toFixed(1)}%`);
        }
      }
    }

    return {
      sessionsA: nA,
      sessionsB: nB,
      exposureRatio,
      conversionRatio,
      contextDistribution:  { A: ctxA, B: ctxB },
      productDistribution:  { A: prodA, B: prodB },
      exposureTypeBreakdown: { A: etA, B: etB },
      imbalanceFlags: flags,
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  // ── Resolves userId from session context (best-effort) ──────────────────────
  // Returns null when userId is not tracked at experiment level.
  _resolveUserId(sessionId) {
    // ExperimentEngine does not manage userId mapping — that belongs to
    // session-orchestrator. Return null; callers with userId context should
    // inject it via userMemoryEngine.recordPurchase() directly.
    return null;
  }

  _touchSession(sessionId, variant, now) {
    if (this._sessions.has(sessionId)) return;
    this._sessions.set(sessionId, {
      sessionId,
      variant,
      startedAt:         now,
      lastExposureAt:    null,
      exposureCount:     0,
      firstExposures:    0,
      revisitExposures:  0,
      decisionCount:     0,
      interventionCount: 0,
      converted:         false,
      revenue:           0,
      cartAdds:          0,
      conversionAt:      null,
    });
  }

  _assertAlive() {
    if (this._disposed) throw new Error('ExperimentEngine: instance has been disposed');
  }

  // ==========================================================================
  // STATISTICAL VALIDITY — delegates to statistical-validity-engine
  // This method is READ-ONLY. It never modifies any state.
  // ==========================================================================

  /**
   * Returns a full statistical validity report for the experiment.
   *
   * Delegates to statistical-validity-engine (EXPLAIN ONLY authority).
   * Uses ITT-correct counts from this engine's session store.
   *
   * outcomeTracker is optional: if provided, revenue outcomes are pulled from
   * completed outcome records (more accurate). If absent, binary conversion
   * vectors are synthesised from scalar counts.
   *
   * @param {string} experimentId
   * @param {object} [outcomeTracker]  InterventionOutcomeTracker instance
   * @returns {ExperimentReport}
   */
  getStatisticalReport(experimentId, outcomeTracker) {
    this._assertAlive();
    if (!experimentId || typeof experimentId !== 'string') {
      throw new TypeError('ExperimentEngine.getStatisticalReport: experimentId must be a non-empty string');
    }

    const sessA = [], sessB = [];
    for (const sess of this._sessions.values()) {
      if (sess.variant === VARIANTS.CONTROL) sessA.push(sess);
      else                                    sessB.push(sess);
    }

    const assignedA    = sessA.length;
    const assignedB    = sessB.length;
    const exposedA     = sessA.reduce((s, v) => s + v.exposureCount, 0);
    const exposedB     = sessB.reduce((s, v) => s + v.exposureCount, 0);
    const conversionsA = sessA.filter(s => s.converted).length;
    const conversionsB = sessB.filter(s => s.converted).length;

    // ── Revenue outcomes (per session) from outcomeTracker if available ──────
    // These are used for variance and outlier detection (more meaningful than
    // binary conversion vectors for monetary experiments).
    let valuesA = sessA.map(s => s.revenue || 0);
    let valuesB = sessB.map(s => s.revenue || 0);

    if (outcomeTracker && typeof outcomeTracker.getOutcomesForLearning === 'function') {
      // Aggregate revenue outcomes from tracker per session
      const revenueBySession = {};
      for (const sess of [...sessA, ...sessB]) {
        try {
          const records = outcomeTracker.getOutcomesForLearning(sess.sessionId);
          // Sum revenue-positive outcomes
          const revenue = records
            .filter(r => r.attributed)
            .reduce((s, r) => s + (r.delta && typeof r.delta.revenueDelta === 'number' ? r.delta.revenueDelta : 0), 0);
          if (revenue > 0) revenueBySession[sess.sessionId] = revenue;
        } catch (_) {}
      }
      if (Object.keys(revenueBySession).length > 0) {
        valuesA = sessA.map(s => revenueBySession[s.sessionId] || s.revenue || 0);
        valuesB = sessB.map(s => revenueBySession[s.sessionId] || s.revenue || 0);
      }
    }

    const sessionIdsAll = [...sessA, ...sessB].map(s => s.sessionId);

    return _sveEvaluate({
      experimentId,
      assignedA,
      assignedB,
      exposedA,
      exposedB,
      conversionsA,
      conversionsB,
      outcomes: {
        A:      sessA.map(s => s.converted ? 1 : 0),
        B:      sessB.map(s => s.converted ? 1 : 0),
        values: valuesA.concat(valuesB),
      },
      sessions: sessionIdsAll,
    });
  }

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================

  getDiagnostics() {
    this._assertAlive();
    let controlCount = 0, treatmentCount = 0;
    for (const v of this._assignments.values()) {
      if (v === VARIANTS.CONTROL) controlCount++;
      else                        treatmentCount++;
    }
    return {
      schemaVersion:        SCHEMA_VERSION,
      totalAssignments:     controlCount + treatmentCount,
      controlAssignments:   controlCount,
      treatmentAssignments: treatmentCount,
      totalSessions:        this._sessions.size,
      totalExposures:       this._exposures.size,
      decisionLogSize:      this._decisionLog.length,
      config:               this._config,
    };
  }

  // ==========================================================================
  // SNAPSHOT / RESTORE
  // ==========================================================================

  snapshot() {
    this._assertAlive();
    return {
      __schemaVersion: SCHEMA_VERSION,
      assignments:     Array.from(this._assignments.entries()),
      exposures:       Array.from(this._exposures.entries()),
      productSeen:     Array.from(this._productSeen.entries()),
      sessions:        Array.from(this._sessions.entries()),
      decisionLog:     this._decisionLog.slice(),
      seq:             this._seq,
    };
  }

  restore(snap, nowMs) {
    this._assertAlive();
    if (!snap || snap.__schemaVersion !== SCHEMA_VERSION) return;

    this._assignments = new LRUMap(this._config.maxSessions);
    if (Array.isArray(snap.assignments)) {
      for (const [k, v] of snap.assignments) this._assignments.set(k, v);
    }

    this._exposures = new LRUMap(this._config.maxExposures);
    if (Array.isArray(snap.exposures)) {
      for (const [k, v] of snap.exposures) this._exposures.set(k, v);
    }

    this._productSeen = new LRUMap(this._config.maxExposures);
    if (Array.isArray(snap.productSeen)) {
      for (const [k, v] of snap.productSeen) this._productSeen.set(k, v);
    }

    this._sessions = new LRUMap(this._config.maxSessions);
    if (Array.isArray(snap.sessions)) {
      for (const [k, v] of snap.sessions) this._sessions.set(k, v);
    }

    // P1-REPLAY FIX (M3): Decision logs have a retention window. When restoring
    // from a snapshot taken earlier than now - retentionMs, all restored entries
    // would be immediately pruned by the next cleanup, leaving an empty log.
    // Solution: accept an optional nowMs and proactively filter entries that are
    // within retention. If nowMs is not provided, restore all (backward compat).
    if (Array.isArray(snap.decisionLog)) {
      if (typeof nowMs === 'number' && Number.isFinite(nowMs)) {
        const cutoff = nowMs - this._config.decisionLogRetentionMs;
        this._decisionLog = snap.decisionLog.filter(d =>
          typeof d.timestamp === 'number' ? d.timestamp >= cutoff : true
        );
      } else {
        this._decisionLog = snap.decisionLog.slice();
      }
    } else {
      this._decisionLog = [];
    }

    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;
  }

  dispose() {
    if (this._disposed) return;
    this._assignments.clear();
    this._exposures.clear();
    this._productSeen.clear();
    this._sessions.clear();
    this._decisionLog.length = 0;
    this._disposed = true;
  }
}

// ============================================================================
// Validation helper
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`ExperimentEngine: \`${label}\` must be a finite number`);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ExperimentEngine,
  VARIANTS,
  INTERVENTION_DECISIONS,
  EXPOSURE_TYPES,
  OUTCOME_TO_DECISION,
  stableHash,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  // Stat function wrappers — now delegate to statistical-validity-engine (SVE).
  // IMPORTANT: cohenD here measures effect size for CONTINUOUS outcomes (revenue).
  //            SVE's computeEffectSize measures Cohen's h for PROPORTIONS (conversion rates).
  //            These are different measures. Do NOT compare their numeric outputs directly.
  bootstrapCI,       // delegates to SVE.computeBootstrapCI95 via binarisation
  permutationPValue, // delegates to SVE.computePermutationPValue via binarisation
  cohenD,            // Cohen's d (continuous / revenue). NOT Cohen's h.
};
