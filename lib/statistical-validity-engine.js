'use strict';

/**
 * statistical-validity-engine.js
 *
 * STATISTICAL VALIDITY ENGINE — Observe and evaluate experiments.
 *
 * ============================================================================
 * AUTHORITY: EXPLAIN ONLY
 * ============================================================================
 *
 * This engine NEVER:
 *   - decides
 *   - ranks
 *   - intervenes
 *   - mutates experiment logic
 *   - modifies session state
 *   - writes to any store
 *
 * It ONLY reads raw experiment data and produces statistical summaries.
 *
 * ============================================================================
 * METHODOLOGY
 * ============================================================================
 *
 * ITT (Intent-to-Treat):
 *   Compares ALL users assigned to B vs ALL users assigned to A.
 *   Never uses only exposed, clicked, or converted users.
 *   conversionRate = conversions / assignedUsers  (not exposedUsers)
 *
 *   This is the gold standard for causal inference. It avoids selection
 *   bias from conditioning on post-assignment events (exposure, click).
 *
 * Bootstrap 95% CI:
 *   Parametric-free. 1000 resamples minimum.
 *   Uses seeded PRNG (mulberry32) for determinism.
 *   CI is over ITT uplift, not raw means.
 *
 * Permutation test:
 *   Non-parametric. 1000 permutations minimum.
 *   Same seeded PRNG. Tests H0: assignment label has no effect on outcome.
 *
 * Cohen's h:
 *   Appropriate effect size for proportions (conversion rates).
 *   h = 2*arcsin(sqrt(p1)) - 2*arcsin(sqrt(p2))
 *   |h| < 0.2 → small, 0.2–0.5 → medium, > 0.5 → large
 *
 * Outlier detection:
 *   IQR method: outside 1.5*IQR from Q1/Q3
 *   Z-score method: |z| > 3.0
 *   Both applied; union of affected sessions returned.
 *
 * ============================================================================
 * SIGNIFICANCE RULE (strict)
 * ============================================================================
 *
 *   significance = true ONLY IF:
 *     pValue < 0.05
 *     AND ci95.lower > 0
 *     AND sampleQuality !== 'low'
 *
 * ============================================================================
 * GUARANTEES
 * ============================================================================
 *
 *   - NO Date.now() — engine is stateless; no timestamps needed
 *   - NO Math.random() — deterministic PRNG seeded from data
 *   - NO mutation of inputs
 *   - Idempotent: same inputs → same outputs always
 *   - Pure functions: all methods are referentially transparent
 *   - No external dependencies
 */

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;

const MIN_SAMPLE_SIZE      = 100;
const MIN_RESAMPLES        = 1000;
const MIN_PERMUTATIONS     = 1000;
const ALPHA                = 0.05;
const ZSCORE_THRESHOLD     = 3.0;
const IQR_MULTIPLIER       = 1.5;
const EXPOSURE_IMBALANCE_THRESHOLD = 0.20;   // ±20%
const HIGH_VARIANCE_CV_THRESHOLD   = 2.0;    // coefficient of variation

const COHEN_H_SMALL  = 0.2;
const COHEN_H_MEDIUM = 0.5;

// ============================================================================
// Deterministic PRNG (mulberry32)
// ============================================================================

function makePRNG(seed) {
  let s = (seed >>> 0) || 0xdeadbeef;
  return function next() {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0xFFFFFFFF;
  };
}

function dataSeed(arr) {
  // Cheap reproducible seed from data — no randomness
  let h = 0x811c9dc5;
  for (let i = 0; i < Math.min(arr.length, 32); i++) {
    h ^= (arr[i] * 1000) | 0;
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

// ============================================================================
// Descriptive statistics helpers
// ============================================================================

function _sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

function _mean(arr) {
  return arr.length === 0 ? 0 : _sum(arr) / arr.length;
}

function _sortedCopy(arr) {
  return arr.slice().sort((a, b) => a - b);
}

function _median(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function _percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function _variance(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - m) ** 2;
  return v / (arr.length - 1); // sample variance (Bessel's correction)
}

function _stddev(arr) {
  return Math.sqrt(_variance(arr));
}

// ============================================================================
// Resample helper (in-place random draw with replacement)
// ============================================================================

function _resample(arr, rand) {
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = arr[Math.floor(rand() * arr.length)];
  }
  return out;
}

function _shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

// ============================================================================
// Public engine methods
// ============================================================================

/**
 * ITT (Intent-to-Treat) uplift.
 *
 * Compares conversion rates across ALL assigned users — never just exposed.
 *
 * @param {number} conversionsA  Total conversions in control group
 * @param {number} assignedA     Total users assigned to control
 * @param {number} conversionsB  Total conversions in treatment group
 * @param {number} assignedB     Total users assigned to treatment
 * @returns {{ rateA, rateB, uplift, upliftAbs }}
 */
function computeITT(conversionsA, assignedA, conversionsB, assignedB) {
  _assertNonNegInt(conversionsA, 'conversionsA');
  _assertNonNegInt(assignedA,    'assignedA');
  _assertNonNegInt(conversionsB, 'conversionsB');
  _assertNonNegInt(assignedB,    'assignedB');

  const rateA = assignedA > 0 ? conversionsA / assignedA : 0;
  const rateB = assignedB > 0 ? conversionsB / assignedB : 0;

  // Relative uplift; falls back to absolute when rateA = 0
  const uplift    = rateA > 0 ? (rateB - rateA) / rateA : (rateB - rateA);
  const upliftAbs = rateB - rateA;

  return Object.freeze({ rateA, rateB, uplift, upliftAbs });
}

/**
 * Bootstrap 95% confidence interval over ITT relative uplift.
 *
 * Resamples binary outcome vectors (1 = converted, 0 = not) for each group.
 * Minimum 1000 resamples. Deterministic seeded PRNG.
 *
 * @param {number[]} outcomesA  Binary outcomes for group A (0 or 1)
 * @param {number[]} outcomesB  Binary outcomes for group B (0 or 1)
 * @param {number}   [n]        Number of resamples (default 1000)
 * @returns {{ lower, upper, medianBoot }}
 */
function computeBootstrapCI95(outcomesA, outcomesB, n = MIN_RESAMPLES) {
  _assertArray(outcomesA, 'outcomesA');
  _assertArray(outcomesB, 'outcomesB');

  const iters = Math.max(MIN_RESAMPLES, n | 0);

  if (outcomesA.length === 0 || outcomesB.length === 0) {
    return Object.freeze({ lower: null, upper: null, medianBoot: null });
  }

  const seed = dataSeed(outcomesA) ^ dataSeed(outcomesB);
  const rand = makePRNG(seed);

  const uplifts = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const rA = _resample(outcomesA, rand);
    const rB = _resample(outcomesB, rand);
    const mA = _mean(rA);
    const mB = _mean(rB);
    uplifts[i] = mA > 0 ? (mB - mA) / mA : (mB - mA);
  }

  const sorted = _sortedCopy(uplifts);
  const lo = Math.floor(sorted.length * (ALPHA / 2));
  const hi = Math.ceil(sorted.length * (1 - ALPHA / 2)) - 1;

  return Object.freeze({
    lower:      sorted[lo],
    upper:      sorted[Math.min(hi, sorted.length - 1)],
    medianBoot: _median(sorted),
  });
}

/**
 * Non-parametric permutation p-value.
 *
 * Computes P(|δ_perm| >= |δ_observed|) under H0: labels irrelevant.
 * Minimum 1000 permutations. Deterministic seeded PRNG.
 *
 * @param {number[]} outcomesA
 * @param {number[]} outcomesB
 * @param {number}   [n]
 * @returns {number|null}
 */
function computePermutationPValue(outcomesA, outcomesB, n = MIN_PERMUTATIONS) {
  _assertArray(outcomesA, 'outcomesA');
  _assertArray(outcomesB, 'outcomesB');

  const iters = Math.max(MIN_PERMUTATIONS, n | 0);

  if (outcomesA.length === 0 || outcomesB.length === 0) return null;

  const mA = _mean(outcomesA);
  const mB = _mean(outcomesB);
  const observed = Math.abs(mB - mA);

  const combined = outcomesA.concat(outcomesB);
  const nA = outcomesA.length;
  const seed = (dataSeed(outcomesA) * 31 + dataSeed(outcomesB)) >>> 0;
  const rand = makePRNG(seed);

  let extreme = 0;
  for (let i = 0; i < iters; i++) {
    _shuffleInPlace(combined, rand);
    const pA = combined.slice(0, nA);
    const pB = combined.slice(nA);
    const delta = Math.abs(_mean(pB) - _mean(pA));
    if (delta >= observed) extreme++;
  }

  return extreme / iters;
}

/**
 * Cohen's h — effect size for proportions.
 *
 * h = 2*arcsin(sqrt(p1)) - 2*arcsin(sqrt(p2))
 * Interpretation:
 *   |h| < 0.2  → small
 *   |h| < 0.5  → medium
 *   |h| >= 0.5 → large
 *
 * @param {number} rateA  Conversion rate group A (0–1)
 * @param {number} rateB  Conversion rate group B (0–1)
 * @returns {{ h, interpretation }}
 */
function computeEffectSize(rateA, rateB) {
  _assertRate(rateA, 'rateA');
  _assertRate(rateB, 'rateB');

  const phi = (p) => 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p))));
  const h = phi(rateB) - phi(rateA);
  const absH = Math.abs(h);

  let interpretation;
  if (absH < COHEN_H_SMALL)  interpretation = 'negligible';
  else if (absH < COHEN_H_MEDIUM) interpretation = 'small';
  else if (absH < 0.8)            interpretation = 'medium';
  else                            interpretation = 'large';

  return Object.freeze({ h, absH, interpretation });
}

/**
 * Median uplift (bootstrap distribution median).
 * Returns the median of the bootstrap uplift distribution.
 * More robust than mean when distribution is skewed.
 *
 * @param {number[]} outcomesA
 * @param {number[]} outcomesB
 * @param {number}   [n]
 * @returns {number|null}
 */
function computeMedianUplift(outcomesA, outcomesB, n = MIN_RESAMPLES) {
  const ci = computeBootstrapCI95(outcomesA, outcomesB, n);
  return ci.medianBoot;
}

/**
 * Variance metrics for a session-level outcome array.
 *
 * @param {number[]} values  e.g. revenue per session
 * @returns {{ sampleVariance, standardDeviation, coefficientOfVariation }}
 */
function computeVariance(values) {
  _assertArray(values, 'values');
  if (values.length < 2) {
    return Object.freeze({
      sampleVariance: null,
      standardDeviation: null,
      coefficientOfVariation: null,
    });
  }

  const v   = _variance(values);
  const sd  = Math.sqrt(v);
  const m   = _mean(values);
  const cv  = m !== 0 ? sd / Math.abs(m) : null;

  return Object.freeze({
    sampleVariance:          v,
    standardDeviation:       sd,
    coefficientOfVariation:  cv,
  });
}

/**
 * Outlier detection using IQR and z-score methods.
 *
 * @param {number[]} values          Numeric outcome per session
 * @param {string[]} [sessionIds]    Parallel array of session identifiers
 * @returns {{ count, affectedSessions, severity, iqrOutliers, zscoreOutliers }}
 */
function detectOutliers(values, sessionIds = []) {
  _assertArray(values, 'values');
  if (values.length < 4) {
    return Object.freeze({ count: 0, affectedSessions: [], severity: 'none', iqrOutliers: [], zscoreOutliers: [] });
  }

  const sorted = _sortedCopy(values);
  const q1  = _percentile(sorted, 0.25);
  const q3  = _percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const loB = q1 - IQR_MULTIPLIER * iqr;
  const hiB = q3 + IQR_MULTIPLIER * iqr;

  const m  = _mean(values);
  const sd = _stddev(values);

  const iqrSet     = new Set();
  const zscoreSet  = new Set();
  const affected   = new Set();

  for (let i = 0; i < values.length; i++) {
    const v   = values[i];
    const sid = sessionIds[i] || `idx:${i}`;
    const isIQR = v < loB || v > hiB;
    const z     = sd > 0 ? Math.abs((v - m) / sd) : 0;
    const isZ   = z > ZSCORE_THRESHOLD;

    if (isIQR) { iqrSet.add(sid);    affected.add(sid); }
    if (isZ)   { zscoreSet.add(sid); affected.add(sid); }
  }

  const count = affected.size;
  const ratio = count / values.length;
  let severity;
  if (count === 0)    severity = 'none';
  else if (ratio < 0.02) severity = 'low';
  else if (ratio < 0.05) severity = 'medium';
  else                   severity = 'high';

  return Object.freeze({
    count,
    affectedSessions: Array.from(affected),
    severity,
    iqrOutliers:    Array.from(iqrSet),
    zscoreOutliers: Array.from(zscoreSet),
  });
}

/**
 * Sample quality assessment.
 *
 * @param {object} p
 * @param {number} p.assignedA
 * @param {number} p.assignedB
 * @param {number} p.exposedA
 * @param {number} p.exposedB
 * @param {object} p.varianceMetrics      Output of computeVariance()
 * @param {object} p.outlierResult        Output of detectOutliers()
 * @returns {{ quality, warnings }}
 *   quality: 'low' | 'medium' | 'high'
 */
function evaluateSampleQuality({ assignedA, assignedB, exposedA, exposedB, varianceMetrics, outlierResult }) {
  const warnings = [];

  // 1. Minimum sample size
  if (assignedA < MIN_SAMPLE_SIZE || assignedB < MIN_SAMPLE_SIZE) {
    warnings.push(`Low sample size: A=${assignedA}, B=${assignedB}. Minimum required: ${MIN_SAMPLE_SIZE} per group.`);
  }

  // 2. Assignment imbalance (should be ~50/50)
  const totalAssigned = assignedA + assignedB;
  if (totalAssigned > 0) {
    const splitA = assignedA / totalAssigned;
    if (Math.abs(splitA - 0.5) > 0.10) {
      warnings.push(`Assignment imbalance: A=${(splitA*100).toFixed(1)}%, B=${((1-splitA)*100).toFixed(1)}%. Expected ~50/50.`);
    }
  }

  // 3. Exposure ratio imbalance
  const expRateA = assignedA > 0 ? exposedA / assignedA : 0;
  const expRateB = assignedB > 0 ? exposedB / assignedB : 0;
  if (expRateA > 0 && expRateB > 0) {
    const expRatio = Math.abs(expRateB - expRateA) / expRateA;
    if (expRatio > EXPOSURE_IMBALANCE_THRESHOLD) {
      warnings.push(`Exposure imbalance: A exposure rate=${(expRateA*100).toFixed(1)}%, B=${(expRateB*100).toFixed(1)}%. Delta>${(EXPOSURE_IMBALANCE_THRESHOLD*100).toFixed(0)}%.`);
    }
  }

  // 4. High variance
  if (varianceMetrics && varianceMetrics.coefficientOfVariation != null) {
    if (varianceMetrics.coefficientOfVariation > HIGH_VARIANCE_CV_THRESHOLD) {
      warnings.push(`High variance: CV=${varianceMetrics.coefficientOfVariation.toFixed(2)}. Results may be unstable.`);
    }
  }

  // 5. Outlier contamination
  if (outlierResult && outlierResult.severity === 'high') {
    warnings.push(`Outlier contamination: ${outlierResult.count} sessions (${((outlierResult.count / Math.max(1, assignedA + assignedB))*100).toFixed(1)}%) flagged. Severity: high.`);
  }

  // Determine quality tier
  let quality;
  const hasCritical = warnings.some(w =>
    w.includes('Low sample size') || w.includes('Outlier contamination')
  );
  if (hasCritical || warnings.length >= 3) {
    quality = 'low';
  } else if (warnings.length >= 1) {
    quality = 'medium';
  } else {
    quality = 'high';
  }

  return Object.freeze({ quality, warnings: Object.freeze(warnings) });
}

/**
 * evaluateExperiment — Master entry point.
 *
 * Input:
 *   experimentId, assignedA, assignedB,
 *   exposedA, exposedB,
 *   conversionsA, conversionsB,
 *   outcomes: { A: number[], B: number[], sessions?: string[] },
 *   sessions: string[]    (optional session IDs for outlier tracking)
 *
 * Output: Full statistical report (see spec).
 *
 * @param {object} input
 * @returns {ExperimentReport}
 */
function evaluateExperiment({
  experimentId,
  assignedA,
  assignedB,
  exposedA,
  exposedB,
  conversionsA,
  conversionsB,
  outcomes = {},
  sessions = [],
}) {
  // ── Input validation ────────────────────────────────────────────────────────
  if (!experimentId || typeof experimentId !== 'string') {
    throw new TypeError('evaluateExperiment: experimentId must be a non-empty string');
  }
  _assertNonNegInt(assignedA,    'assignedA');
  _assertNonNegInt(assignedB,    'assignedB');
  _assertNonNegInt(exposedA,     'exposedA');
  _assertNonNegInt(exposedB,     'exposedB');
  _assertNonNegInt(conversionsA, 'conversionsA');
  _assertNonNegInt(conversionsB, 'conversionsB');

  // ── Derive binary outcome vectors ────────────────────────────────────────────
  // If caller provides raw outcome arrays, use them directly.
  // Otherwise, synthesise from scalar counts using ITT-correct binary vectors.
  let outcomesA = Array.isArray(outcomes.A) ? outcomes.A.map(Number) : null;
  let outcomesB = Array.isArray(outcomes.B) ? outcomes.B.map(Number) : null;

  if (!outcomesA || outcomesA.length === 0) {
    // Synthesise: conversions 1s followed by 0s, length = assignedA
    outcomesA = _synthOutcomes(conversionsA, assignedA);
  }
  if (!outcomesB || outcomesB.length === 0) {
    outcomesB = _synthOutcomes(conversionsB, assignedB);
  }

  const sessionIds = Array.isArray(sessions) ? sessions : [];

  // ── ITT ─────────────────────────────────────────────────────────────────────
  const itt = computeITT(conversionsA, assignedA, conversionsB, assignedB);

  // ── Bootstrap CI95 ───────────────────────────────────────────────────────────
  const ci95 = computeBootstrapCI95(outcomesA, outcomesB, MIN_RESAMPLES);

  // ── Permutation p-value ──────────────────────────────────────────────────────
  const pValue = computePermutationPValue(outcomesA, outcomesB, MIN_PERMUTATIONS);

  // ── Effect size ──────────────────────────────────────────────────────────────
  const effectSize = computeEffectSize(itt.rateA, itt.rateB);

  // ── Median uplift ────────────────────────────────────────────────────────────
  const medianUplift = ci95.medianBoot;

  // ── Variance metrics ─────────────────────────────────────────────────────────
  // Revenue/value outcomes if provided; otherwise use binary outcomes
  const valueOutcomes = (Array.isArray(outcomes.values) && outcomes.values.length > 0)
    ? outcomes.values.map(Number)
    : outcomesA.concat(outcomesB);
  const varianceMetrics = computeVariance(valueOutcomes);

  // ── Outliers ─────────────────────────────────────────────────────────────────
  const outlierResult = detectOutliers(valueOutcomes, sessionIds);

  // ── Exposure ratio ───────────────────────────────────────────────────────────
  const expRateA = assignedA > 0 ? exposedA / assignedA : 0;
  const expRateB = assignedB > 0 ? exposedB / assignedB : 0;
  const exposureRatio = expRateA > 0 ? expRateB / expRateA : (expRateB > 0 ? Infinity : 1);

  // ── Sample quality ────────────────────────────────────────────────────────────
  const { quality: sampleQuality, warnings } = evaluateSampleQuality({
    assignedA, assignedB, exposedA, exposedB, varianceMetrics, outlierResult,
  });

  // ── Significance ─────────────────────────────────────────────────────────────
  // Strict rule: pValue < 0.05 AND ci95.lower > 0 AND sampleQuality !== 'low'
  const significance = (
    pValue != null &&
    pValue < ALPHA &&
    ci95.lower != null &&
    ci95.lower > 0 &&
    sampleQuality !== 'low'
  );

  // ── Verdict ──────────────────────────────────────────────────────────────────
  const verdict = significance
    ? 'Statistically significant uplift detected.'
    : 'No statistically significant uplift detected.';

  return Object.freeze({
    experimentId,

    // Assignment counts
    assignedA,
    assignedB,

    // Exposure counts
    exposedA,
    exposedB,

    // Conversion counts
    conversionsA,
    conversionsB,

    // Derived rates
    conversionRateA: itt.rateA,
    conversionRateB: itt.rateB,

    // Exposure ratio
    exposureRatio,

    // ITT
    ittUplift:    itt.uplift,
    ittUpliftAbs: itt.upliftAbs,

    // CI95
    ci95: Object.freeze({ lower: ci95.lower, upper: ci95.upper }),

    // Permutation p-value
    pValue,

    // Effect size (Cohen's h)
    effectSize: Object.freeze({ h: effectSize.h, interpretation: effectSize.interpretation }),

    // Median uplift (bootstrap distribution median)
    medianUplift,

    // Variance
    variance: varianceMetrics,

    // Sample quality
    sampleQuality,

    // Outliers
    outliers: Object.freeze({
      count:            outlierResult.count,
      affectedSessions: outlierResult.affectedSessions,
      severity:         outlierResult.severity,
    }),

    // Significance
    significance,

    // Verdict
    verdict,

    // Warnings
    warnings,
  });
}

// ============================================================================
// Private helpers
// ============================================================================

function _synthOutcomes(conversions, assigned) {
  // P1-STAT FIX (M4): Previously returned [1,1,...,0,0,...] (sorted).
  // The permutation test shuffles the COMBINED array, not individual groups.
  // Starting from a sorted state means the first permutation always produces
  // |delta| = |delta_observed| (no shuffling has occurred), contributing a
  // systematic downward bias to p-values.
  // Fix: shuffle the synthetic vector deterministically using the data-dependent
  // seed from dataSeed() so the ordering is randomised but reproducible.
  if (assigned <= 0) return [];
  const n = Math.min(assigned, 1000000); // memory guard
  const out = new Array(n);
  const convCapped = Math.min(conversions, n);
  for (let i = 0; i < convCapped; i++) out[i] = 1;
  for (let i = convCapped; i < n; i++) out[i] = 0;

  // Deterministic shuffle using the vector's own content as seed
  const seed = (convCapped * 0x9e3779b9 + n) >>> 0;
  const rand = makePRNG(seed);
  _shuffleInPlace(out, rand);

  return out;
}

function _assertNonNegInt(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || Math.floor(v) !== v) {
    throw new TypeError(`StatisticalValidityEngine: ${label} must be a non-negative integer`);
  }
}

function _assertArray(v, label) {
  if (!Array.isArray(v)) {
    throw new TypeError(`StatisticalValidityEngine: ${label} must be an array`);
  }
}

function _assertRate(v, label) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new RangeError(`StatisticalValidityEngine: ${label} must be a number in [0, 1]`);
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  evaluateExperiment,
  computeITT,
  computeBootstrapCI95,
  computePermutationPValue,
  computeEffectSize,
  computeMedianUplift,
  computeVariance,
  detectOutliers,
  evaluateSampleQuality,
  SCHEMA_VERSION,
  MIN_SAMPLE_SIZE,
  MIN_RESAMPLES,
  MIN_PERMUTATIONS,
  ALPHA,
  COHEN_H_SMALL,
  COHEN_H_MEDIUM,
};
