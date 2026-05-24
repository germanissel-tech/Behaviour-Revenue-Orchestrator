'use strict';

/**
 * observability-engine.js
 *
 * OBSERVABILITY ENGINE — Registro explicable de decisiones OPE.
 *
 * ============================================================================
 * DISEÑO
 * ============================================================================
 *
 * Registra cada decisión del sistema con contexto completo para:
 *   1. Auditoría post-hoc: explicar por qué se tomó cada decisión
 *   2. Detección de anomalías: errores, picos de latencia, patrones inesperados
 *   3. Métricas operacionales: throughput, error rate, percentiles de latencia
 *   4. Integración con experiment-engine: trace de decisiones por variante
 *
 * Estructura de un registro:
 *   {
 *     sessionId:   string,
 *     decision:    string,   // INTERVENE | SKIP | BLOCK_FATIGUE | ...
 *     confidence:  number,   // 0–1
 *     reason:      string,   // razón primaria
 *     context:     string,   // 'listing' | 'product_detail' | 'cart' | ...
 *     signals:     object,   // señales que llevaron a la decisión
 *     timestamp:   number,   // nowMs inyectado
 *   }
 *
 * Reglas:
 *   - NO Date.now() — timestamps inyectados
 *   - NO Math.random()
 *   - Bounded: ring buffers en todos los stores
 *   - Determinista: mismas entradas → mismas métricas
 *   - Replay-safe: snapshot() / restore()
 *   - Authority: OBSERVE only — no decide, no interviene, no modifica estado
 *
 * ============================================================================
 * INTEGRACIÓN
 * ============================================================================
 *
 *   - session-orchestrator llama a recordDecision() después de cada evaluate()
 *   - experiment-engine llama a recordDecision() vía ingestDEERecord()
 *   - runtime-health-check consume getMetrics() para el health check
 *   - debug panel consume getMetrics() y queryDecisions() para visualización
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

const DECISION_TYPES = Object.freeze({
  INTERVENE:          'INTERVENE',
  SKIP:               'SKIP',
  BLOCK_FATIGUE:      'BLOCK_FATIGUE',
  BLOCK_POLICY:       'BLOCK_POLICY',
  BLOCK_CONFIDENCE:   'BLOCK_CONFIDENCE',
  BLOCK_RELATIONSHIP: 'BLOCK_RELATIONSHIP',
  DO_NOTHING:         'DO_NOTHING',
  ERROR:              'ERROR',
});

const ERROR_SEVERITY = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});

const DEFAULT_CONFIG = Object.freeze({
  // Ring buffer capacities
  maxDecisionRecords:    10000,
  maxErrorRecords:       1000,
  maxPerformanceRecords: 5000,

  // Percentile computation window (last N records)
  percentileWindow: 1000,

  // Slow decision threshold (ms)
  slowDecisionThresholdMs: 100,

  // Error rate window (last N decisions)
  errorRateWindow: 500,

  // Metrics cache TTL (ms) — recompute at most every N ms
  metricsCacheTtlMs: 1000,
});

// ============================================================================
// Ring Buffer
// ============================================================================

class RingBuffer {
  constructor(cap) {
    this._cap  = Math.max(1, cap | 0);
    this._buf  = new Array(this._cap);
    this._head = 0;
    this._size = 0;
  }

  push(item) {
    this._buf[this._head % this._cap] = item;
    this._head++;
    if (this._size < this._cap) this._size++;
  }

  toArray() {
    if (this._size === 0) return [];
    const start = this._size < this._cap ? 0 : this._head % this._cap;
    const out = [];
    for (let i = 0; i < this._size; i++) {
      out.push(this._buf[(start + i) % this._cap]);
    }
    return out;
  }

  get size() { return this._size; }
  get capacity() { return this._cap; }

  clear() { this._head = 0; this._size = 0; }

  snapshot() {
    return { buf: this._buf.slice(0, this._cap), head: this._head, size: this._size, cap: this._cap };
  }

  restore(s) {
    if (!s) return;
    this._cap  = s.cap  || this._cap;
    this._buf  = Array.isArray(s.buf) ? s.buf.slice() : new Array(this._cap);
    this._head = s.head || 0;
    this._size = s.size || 0;
  }
}

// ============================================================================
// ObservabilityEngine
// ============================================================================

class ObservabilityEngine {
  /**
   * @param {object} [config]  Overrides DEFAULT_CONFIG
   */
  constructor(config = {}) {
    this._config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    // ── Decision log (ring buffer)
    this._decisions = new RingBuffer(this._config.maxDecisionRecords);

    // ── Error log (ring buffer)
    this._errors = new RingBuffer(this._config.maxErrorRecords);

    // ── Performance log (ring buffer)
    this._performance = new RingBuffer(this._config.maxPerformanceRecords);

    // ── Aggregated counters (fast path, no scan needed)
    this._counters = {
      totalDecisions:     0,
      totalErrors:        0,
      totalPerformance:   0,
      byDecision:         Object.fromEntries(Object.values(DECISION_TYPES).map(k => [k, 0])),
      bySeverity:         Object.fromEntries(Object.values(ERROR_SEVERITY).map(k => [k, 0])),
    };

    // ── Metrics cache (avoid recomputing percentiles on every call)
    this._metricsCache       = null;
    this._metricsCacheAt     = 0;

    this._seq = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // RECORDING — Decisions
  // ==========================================================================

  /**
   * Records a behavioral decision made by OPE.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.decision        One of DECISION_TYPES
   * @param {number} p.confidence      0–1
   * @param {string} p.reason          Human-readable primary reason
   * @param {string} p.context         'listing' | 'product_detail' | 'cart' | ...
   * @param {object} [p.signals]       Signal snapshot that drove the decision
   * @param {string} [p.variant]       Experiment variant ('A' | 'B' | null)
   * @param {string} [p.selectedFamily]
   * @param {number} p.nowMs
   * @returns {string} recordId
   */
  recordDecision({
    sessionId,
    decision,
    confidence,
    reason,
    context,
    signals,
    variant,
    selectedFamily,
    nowMs,
  }) {
    this._assertAlive();
    _assertString(sessionId, 'sessionId');
    _assertFinite(nowMs, 'nowMs');

    this._seq++;
    const recordId = `obs_dec_${this._seq}_${nowMs}`;

    const record = {
      recordId,
      seq:           this._seq,
      sessionId,
      decision:      decision      || DECISION_TYPES.DO_NOTHING,
      confidence:    typeof confidence === 'number' ? _clamp01(confidence) : null,
      reason:        reason        || null,
      context:       context       || null,
      signals:       signals       || null,
      variant:       variant       || null,
      selectedFamily: selectedFamily || null,
      timestamp:     nowMs,
    };

    this._decisions.push(record);
    this._counters.totalDecisions++;
    const dt = record.decision;
    if (dt in this._counters.byDecision) this._counters.byDecision[dt]++;
    else                                  this._counters.byDecision[dt] = 1;

    this._invalidateMetricsCache();
    return recordId;
  }

  // ==========================================================================
  // RECORDING — Errors
  // ==========================================================================

  /**
   * Records an operational error.
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.errorCode     Short machine-readable code
   * @param {string} p.message       Human-readable description
   * @param {string} [p.severity]    One of ERROR_SEVERITY
   * @param {string} [p.context]
   * @param {object} [p.meta]        Additional context (stack, params, etc.)
   * @param {number} p.nowMs
   * @returns {string} recordId
   */
  recordError({
    sessionId,
    errorCode,
    message,
    severity,
    context,
    meta,
    nowMs,
  }) {
    this._assertAlive();
    _assertFinite(nowMs, 'nowMs');

    this._seq++;
    const recordId = `obs_err_${this._seq}_${nowMs}`;

    const VALID_SEVERITIES = new Set(Object.values(ERROR_SEVERITY));
    const sev = (severity && VALID_SEVERITIES.has(severity))
      ? severity
      : ERROR_SEVERITY.MEDIUM;

    const record = {
      recordId,
      seq:       this._seq,
      sessionId: sessionId || null,
      errorCode: errorCode || 'UNKNOWN',
      message:   message   || null,
      severity:  sev,
      context:   context   || null,
      meta:      meta      || null,
      timestamp: nowMs,
    };

    this._errors.push(record);
    this._counters.totalErrors++;
    this._counters.bySeverity[sev] = (this._counters.bySeverity[sev] || 0) + 1;

    this._invalidateMetricsCache();
    return recordId;
  }

  // ==========================================================================
  // RECORDING — Performance
  // ==========================================================================

  /**
   * Records a performance measurement (e.g. time taken for evaluate()).
   *
   * @param {object} p
   * @param {string} p.sessionId
   * @param {string} p.operation    'evaluate' | 'rank' | 'fatigue_check' | ...
   * @param {number} p.durationMs   How long the operation took
   * @param {boolean} [p.slow]      Override slow detection
   * @param {number} p.nowMs
   * @returns {string} recordId
   */
  recordPerformance({
    sessionId,
    operation,
    durationMs,
    slow,
    nowMs,
  }) {
    this._assertAlive();
    _assertFinite(nowMs, 'nowMs');
    _assertFinite(durationMs, 'durationMs');

    this._seq++;
    const recordId = `obs_perf_${this._seq}_${nowMs}`;

    const isSlow = typeof slow === 'boolean'
      ? slow
      : durationMs >= this._config.slowDecisionThresholdMs;

    const record = {
      recordId,
      seq:        this._seq,
      sessionId:  sessionId || null,
      operation:  operation || 'unknown',
      durationMs,
      slow:       isSlow,
      timestamp:  nowMs,
    };

    this._performance.push(record);
    this._counters.totalPerformance++;

    this._invalidateMetricsCache();
    return recordId;
  }

  // ==========================================================================
  // QUERYING
  // ==========================================================================

  /**
   * Queries decision records with optional filtering.
   *
   * @param {object} [filter]
   * @param {string}   [filter.sessionId]
   * @param {string}   [filter.decision]
   * @param {string}   [filter.context]
   * @param {string}   [filter.variant]
   * @param {number}   [filter.fromMs]
   * @param {number}   [filter.toMs]
   * @param {number}   [filter.limit]
   * @returns {Array<DecisionRecord>}
   */
  queryDecisions(filter = {}) {
    this._assertAlive();
    let records = this._decisions.toArray();

    if (filter.sessionId)  records = records.filter(r => r.sessionId === filter.sessionId);
    if (filter.decision)   records = records.filter(r => r.decision  === filter.decision);
    if (filter.context)    records = records.filter(r => r.context    === filter.context);
    if (filter.variant)    records = records.filter(r => r.variant    === filter.variant);
    if (filter.fromMs != null) records = records.filter(r => r.timestamp >= filter.fromMs);
    if (filter.toMs   != null) records = records.filter(r => r.timestamp <= filter.toMs);
    if (filter.limit)      records = records.slice(-filter.limit);

    return records;
  }

  /**
   * Queries error records.
   *
   * @param {object} [filter]
   * @param {string}   [filter.sessionId]
   * @param {string}   [filter.severity]
   * @param {string}   [filter.errorCode]
   * @param {number}   [filter.fromMs]
   * @param {number}   [filter.limit]
   * @returns {Array<ErrorRecord>}
   */
  queryErrors(filter = {}) {
    this._assertAlive();
    let records = this._errors.toArray();

    if (filter.sessionId)  records = records.filter(r => r.sessionId === filter.sessionId);
    if (filter.severity)   records = records.filter(r => r.severity  === filter.severity);
    if (filter.errorCode)  records = records.filter(r => r.errorCode === filter.errorCode);
    if (filter.fromMs != null) records = records.filter(r => r.timestamp >= filter.fromMs);
    if (filter.limit)      records = records.slice(-filter.limit);

    return records;
  }

  // ==========================================================================
  // METRICS
  // ==========================================================================

  /**
   * Returns aggregated operational metrics.
   * Result is cached for metricsCacheTtlMs to avoid expensive recomputation.
   *
   * @param {number} nowMs
   * @returns {Metrics}
   */
  getMetrics(nowMs) {
    this._assertAlive();
    _assertFinite(nowMs, 'nowMs');

    if (
      this._metricsCache &&
      (nowMs - this._metricsCacheAt) < this._config.metricsCacheTtlMs
    ) {
      return this._metricsCache;
    }

    const metrics = this._computeMetrics(nowMs);
    this._metricsCache    = metrics;
    this._metricsCacheAt  = nowMs;
    return metrics;
  }

  _computeMetrics(nowMs) {
    const decisions   = this._decisions.toArray();
    const errors      = this._errors.toArray();
    const performance = this._performance.toArray();

    // ── Decision distribution
    const decisionDist = { ...this._counters.byDecision };

    // ── Intervention rate
    const totalDec = this._counters.totalDecisions;
    const intervened = this._counters.byDecision[DECISION_TYPES.INTERVENE] || 0;
    const interventionRate = totalDec > 0 ? intervened / totalDec : 0;

    // ── Error rate (last N decisions window)
    const window = this._config.errorRateWindow;
    const recentDecisions  = decisions.slice(-window);
    const recentErrors     = errors.filter(
      e => recentDecisions.length > 0 &&
           e.timestamp >= (recentDecisions[0]?.timestamp || 0)
    );
    const errorRate = recentDecisions.length > 0
      ? recentErrors.length / recentDecisions.length
      : 0;

    // ── Performance percentiles (p50, p95, p99)
    const perfWindow = performance.slice(-this._config.percentileWindow);
    const durations = perfWindow.map(p => p.durationMs).sort((a, b) => a - b);
    const p50 = _percentile(durations, 0.50);
    const p95 = _percentile(durations, 0.95);
    const p99 = _percentile(durations, 0.99);
    const slowCount = perfWindow.filter(p => p.slow).length;
    const slowRate  = perfWindow.length > 0 ? slowCount / perfWindow.length : 0;

    // ── Top reasons across all decisions (last 500)
    const recentDec500 = decisions.slice(-500);
    const reasonCounts = new Map();
    for (const d of recentDec500) {
      if (!d.reason) continue;
      reasonCounts.set(d.reason, (reasonCounts.get(d.reason) || 0) + 1);
    }
    const topReasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    // ── Context distribution
    const contextCounts = {};
    for (const d of recentDec500) {
      if (!d.context) continue;
      contextCounts[d.context] = (contextCounts[d.context] || 0) + 1;
    }

    // ── Variant breakdown
    const variantA = recentDec500.filter(d => d.variant === 'A').length;
    const variantB = recentDec500.filter(d => d.variant === 'B').length;

    return Object.freeze({
      totalDecisions:   this._counters.totalDecisions,
      totalErrors:      this._counters.totalErrors,
      interventionRate,
      errorRate,
      decisionDist,
      contextDist:      contextCounts,
      topReasons,
      performance: {
        p50, p95, p99,
        slowRate,
        sampleSize: durations.length,
      },
      errors: {
        bySeverity: { ...this._counters.bySeverity },
        recentCount: recentErrors.length,
      },
      variants: { A: variantA, B: variantB },
      computedAt: nowMs,
    });
  }

  /**
   * Returns an explanation for a specific decision record.
   *
   * @param {string} recordId
   * @returns {object|null}
   */
  explainDecision(recordId) {
    this._assertAlive();
    const records = this._decisions.toArray();
    const record  = records.find(r => r.recordId === recordId);
    if (!record) return null;

    return {
      recordId:      record.recordId,
      sessionId:     record.sessionId,
      decision:      record.decision,
      confidence:    record.confidence,
      reason:        record.reason,
      context:       record.context,
      selectedFamily: record.selectedFamily,
      variant:       record.variant,
      signals:       record.signals,
      timestamp:     record.timestamp,
      // Human-readable summary
      summary: _buildSummary(record),
    };
  }

  // ==========================================================================
  // SNAPSHOT / RESTORE
  // ==========================================================================

  snapshot() {
    this._assertAlive();
    return {
      __schemaVersion: SCHEMA_VERSION,
      decisions:       this._decisions.snapshot(),
      errors:          this._errors.snapshot(),
      performance:     this._performance.snapshot(),
      counters:        JSON.parse(JSON.stringify(this._counters)),
      seq:             this._seq,
    };
  }

  restore(snap) {
    this._assertAlive();
    if (!snap || snap.__schemaVersion !== SCHEMA_VERSION) return;
    this._decisions.restore(snap.decisions);
    this._errors.restore(snap.errors);
    this._performance.restore(snap.performance);
    if (snap.counters) {
      Object.assign(this._counters, snap.counters);
    }
    this._seq = typeof snap.seq === 'number' ? snap.seq : 0;
    this._invalidateMetricsCache();
  }

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================

  getDiagnostics() {
    this._assertAlive();
    return {
      schemaVersion:      SCHEMA_VERSION,
      decisionBufferSize: this._decisions.size,
      errorBufferSize:    this._errors.size,
      perfBufferSize:     this._performance.size,
      counters:           { ...this._counters },
      seq:                this._seq,
      config:             this._config,
    };
  }

  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================

  reset() {
    this._assertAlive();
    this._decisions.clear();
    this._errors.clear();
    this._performance.clear();
    this._counters = {
      totalDecisions:   0,
      totalErrors:      0,
      totalPerformance: 0,
      byDecision:       Object.fromEntries(Object.values(DECISION_TYPES).map(k => [k, 0])),
      bySeverity:       Object.fromEntries(Object.values(ERROR_SEVERITY).map(k => [k, 0])),
    };
    this._seq = 0;
    this._invalidateMetricsCache();
  }

  dispose() {
    if (this._disposed) return;
    this._decisions.clear();
    this._errors.clear();
    this._performance.clear();
    this._disposed = true;
  }

  _assertAlive() {
    if (this._disposed) throw new Error('ObservabilityEngine: instance has been disposed');
  }

  _invalidateMetricsCache() {
    this._metricsCache   = null;
    this._metricsCacheAt = 0;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function _clamp01(v) { return Math.min(1, Math.max(0, v)); }

function _percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function _buildSummary(record) {
  const parts = [`Decision: ${record.decision}`];
  if (record.reason)     parts.push(`Reason: ${record.reason}`);
  if (record.confidence != null) parts.push(`Confidence: ${(record.confidence * 100).toFixed(0)}%`);
  if (record.context)    parts.push(`Context: ${record.context}`);
  if (record.selectedFamily) parts.push(`Family: ${record.selectedFamily}`);
  if (record.variant)    parts.push(`Variant: ${record.variant}`);
  return parts.join(' | ');
}

function _assertString(v, label) {
  if (!v || typeof v !== 'string') throw new TypeError(`ObservabilityEngine: ${label} must be a non-empty string`);
}

function _assertFinite(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`ObservabilityEngine: ${label} must be a finite number`);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  ObservabilityEngine,
  DECISION_TYPES,
  ERROR_SEVERITY,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
};
