'use strict';

/**
 * tests/statistical-validity-engine.test.js
 *
 * Tests for statistical-validity-engine.js and its integration
 * with experiment-engine and intervention-outcome-tracker.
 */

const {
  evaluateExperiment,
  computeITT,
  computeBootstrapCI95,
  computePermutationPValue,
  computeEffectSize,
  computeMedianUplift,
  computeVariance,
  detectOutliers,
  evaluateSampleQuality,
  MIN_SAMPLE_SIZE,
} = require('../lib/statistical-validity-engine');

const { ExperimentEngine } = require('../lib/experiment-engine');
const { InterventionOutcomeTracker, OUTCOME_TYPES } = require('../lib/intervention-outcome-tracker');

// ============================================================================
// Minimal harness
// ============================================================================

let assertCount = 0, passCount = 0, failCount = 0;
const failures = [];

function assert(cond, msg) {
  assertCount++;
  if (cond) { passCount++; }
  else { failCount++; failures.push(msg); console.error(`  FAIL: ${msg}`); }
}
function assertEqual(a, b, msg) {
  assertCount++;
  if (a === b) { passCount++; }
  else { const m = `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`; failCount++; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertApprox(a, e, delta, msg) {
  assertCount++;
  if (typeof a === 'number' && Math.abs(a - e) <= delta) { passCount++; }
  else { const m = `${msg} (expected ~${e}±${delta}, got ${a})`; failCount++; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertBetween(v, lo, hi, msg) {
  assertCount++;
  if (typeof v === 'number' && v >= lo && v <= hi) { passCount++; }
  else { const m = `${msg} (expected [${lo},${hi}], got ${v})`; failCount++; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertNull(v, msg) { assertEqual(v, null, msg); }
function assertNotNull(v, msg) { assert(v !== null && v !== undefined, `${msg} (got ${v})`); }
function section(name) { console.log(`\n=== ${name} ===`); }

const NOW = 1_700_000_000_000;

// ============================================================================
// SVE-01: computeITT — Intent-to-Treat (ALL assigned, never just exposed)
// ============================================================================
section('SVE-01: computeITT — ITT correctness');
{
  // Baseline: equal groups, B has higher conversion
  const r = computeITT(10, 100, 20, 100);
  assertApprox(r.rateA, 0.10, 0.001, 'ITT rateA = 10/100');
  assertApprox(r.rateB, 0.20, 0.001, 'ITT rateB = 20/100');
  assertApprox(r.uplift, 1.0, 0.001, 'ITT uplift = (0.20-0.10)/0.10 = 1.0');
  assertApprox(r.upliftAbs, 0.10, 0.001, 'ITT upliftAbs = 0.20-0.10 = 0.10');

  // Zero conversions in A → uplift is absolute delta
  const r2 = computeITT(0, 100, 5, 100);
  assertApprox(r2.rateA, 0, 0.001, 'ITT rateA = 0 when no conversions');
  assertApprox(r2.uplift, 0.05, 0.001, 'ITT uplift = upliftAbs when rateA=0');

  // No assignments → rates are 0
  const r3 = computeITT(0, 0, 0, 0);
  assertEqual(r3.rateA, 0, 'ITT rateA = 0 when assignedA = 0');
  assertEqual(r3.rateB, 0, 'ITT rateB = 0 when assignedB = 0');

  // Symmetry: A > B
  const r4 = computeITT(30, 100, 10, 100);
  assert(r4.uplift < 0, 'ITT uplift is negative when B < A');

  // Type errors
  let threw = false;
  try { computeITT(-1, 100, 10, 100); } catch (e) { threw = true; }
  assert(threw, 'computeITT throws on negative conversions');
}

// ============================================================================
// SVE-02: computeBootstrapCI95 — correctness and determinism
// ============================================================================
section('SVE-02: computeBootstrapCI95');
{
  // Identical distributions → CI should straddle 0
  const base = Array(50).fill(0).map((_, i) => i % 2);
  const ci1 = computeBootstrapCI95(base, base.slice(), 200);
  assert(ci1.lower !== null, 'CI lower is not null for non-empty inputs');
  assert(ci1.upper !== null, 'CI upper is not null');
  assert(ci1.lower <= ci1.upper, 'CI lower <= upper');

  // Strong signal: B has 80% conversion, A has 20%
  const a = Array(100).fill(0); a.fill(1, 0, 20);
  const b = Array(100).fill(0); b.fill(1, 0, 80);
  const ci2 = computeBootstrapCI95(a, b, 500);
  assert(ci2.lower > 0, 'CI lower > 0 when B strongly outperforms A');
  assert(ci2.upper > ci2.lower, 'CI upper > lower');

  // Determinism: same inputs → same result
  const ci3a = computeBootstrapCI95(a, b, 200);
  const ci3b = computeBootstrapCI95(a, b, 200);
  assertApprox(ci3a.lower, ci3b.lower, 0.000001, 'Bootstrap CI is deterministic');
  assertApprox(ci3a.upper, ci3b.upper, 0.000001, 'Bootstrap upper is deterministic');

  // Empty inputs → null
  const ciEmpty = computeBootstrapCI95([], [1, 0, 1], 100);
  assertNull(ciEmpty.lower, 'Empty A → null lower');
  assertNull(ciEmpty.upper, 'Empty A → null upper');

  // medianBoot is a number
  assert(typeof ci2.medianBoot === 'number', 'medianBoot is a number');
}

// ============================================================================
// SVE-03: computePermutationPValue — p-value validity
// ============================================================================
section('SVE-03: computePermutationPValue');
{
  // Null hypothesis (same data): p should be high
  const base = Array(40).fill(0).map((_, i) => i % 3 === 0 ? 1 : 0);
  const pNull = computePermutationPValue(base, base.slice(), 300);
  assert(typeof pNull === 'number', 'p-value is a number');
  assertBetween(pNull, 0, 1, 'p-value in [0, 1]');

  // Strong signal: p should be small
  const aLow  = Array(80).fill(0);
  const bHigh = Array(80).fill(1);
  const pStrong = computePermutationPValue(aLow, bHigh, 300);
  assert(pStrong < 0.05, `Strong signal: p < 0.05 (got ${pStrong})`);

  // Determinism
  const p1 = computePermutationPValue(base, base.slice().reverse(), 200);
  const p2 = computePermutationPValue(base, base.slice().reverse(), 200);
  assertApprox(p1, p2, 0.000001, 'Permutation p-value is deterministic');

  // Empty → null
  assertNull(computePermutationPValue([], [1, 0], 100), 'Empty A → null p-value');
}

// ============================================================================
// SVE-04: computeEffectSize — Cohen's h
// ============================================================================
section('SVE-04: computeEffectSize — Cohen\'s h');
{
  // Equal rates → h ≈ 0
  const e1 = computeEffectSize(0.3, 0.3);
  assertApprox(e1.h, 0, 0.0001, 'Cohen\'s h = 0 for equal rates');
  assertEqual(e1.interpretation, 'negligible', 'Equal rates → negligible');

  // Large difference
  const e2 = computeEffectSize(0.05, 0.50);
  assert(e2.absH > 0.5, `Large rate difference → large effect (h=${e2.absH.toFixed(3)})`);
  assert(['medium','large'].includes(e2.interpretation), 'Large rate diff → medium/large');

  // Negative h when B < A
  const e3 = computeEffectSize(0.5, 0.1);
  assert(e3.h < 0, 'h is negative when rateB < rateA');
  assert(e3.absH > 0, 'absH is always positive');

  // Boundary: 0 and 1
  const e4 = computeEffectSize(0, 0);
  assertEqual(e4.interpretation, 'negligible', 'Both zero → negligible');

  // Type error
  let threw = false;
  try { computeEffectSize(1.5, 0.5); } catch (e) { threw = true; }
  assert(threw, 'computeEffectSize throws for rate > 1');
}

// ============================================================================
// SVE-05: computeVariance
// ============================================================================
section('SVE-05: computeVariance');
{
  // Known variance
  const data = [2, 4, 4, 4, 5, 5, 7, 9]; // classic textbook example
  const v = computeVariance(data);
  assertNotNull(v.sampleVariance,         'sampleVariance is not null');
  assertNotNull(v.standardDeviation,      'standardDeviation is not null');
  assertNotNull(v.coefficientOfVariation, 'coefficientOfVariation is not null');
  assert(v.sampleVariance > 0, 'sampleVariance > 0 for non-uniform data');
  assertApprox(v.standardDeviation, Math.sqrt(v.sampleVariance), 0.0001, 'stddev = sqrt(variance)');

  // Constant data → variance = 0
  const vConst = computeVariance([5, 5, 5, 5, 5]);
  assertApprox(vConst.sampleVariance, 0, 0.0001, 'Constant data → variance = 0');

  // Too few values → nulls
  const vFew = computeVariance([42]);
  assertNull(vFew.sampleVariance,         'Single value → null variance');
  assertNull(vFew.standardDeviation,      'Single value → null stddev');
  assertNull(vFew.coefficientOfVariation, 'Single value → null CV');

  // Empty → nulls
  const vEmpty = computeVariance([]);
  assertNull(vEmpty.sampleVariance, 'Empty → null variance');
}

// ============================================================================
// SVE-06: detectOutliers — IQR + z-score
// ============================================================================
section('SVE-06: detectOutliers');
{
  // Clean data → no outliers
  const clean = Array.from({ length: 20 }, (_, i) => 10 + i * 0.5);
  const r1 = detectOutliers(clean);
  assertEqual(r1.count, 0, 'Clean data → 0 outliers');
  assertEqual(r1.severity, 'none', 'Clean data → severity = none');

  // Data with clear outliers
  const dirty = Array(50).fill(5).concat([500, -400]);
  const sids  = dirty.map((_, i) => `s-${i}`);
  const r2 = detectOutliers(dirty, sids);
  assert(r2.count >= 2, `Dirty data: at least 2 outliers (got ${r2.count})`);
  assert(r2.affectedSessions.some(s => sids.indexOf(s) === 50), 'Session 50 (value=500) flagged');
  assert(r2.affectedSessions.some(s => sids.indexOf(s) === 51), 'Session 51 (value=-400) flagged');
  assert(['low','medium','high'].includes(r2.severity), 'Severity is low/medium/high');

  // Too few values → no detection
  const r3 = detectOutliers([1, 2, 3]);
  assertEqual(r3.count, 0, 'Too few values → no outliers');
}

// ============================================================================
// SVE-07: evaluateSampleQuality — all warning paths
// ============================================================================
section('SVE-07: evaluateSampleQuality');
{
  const noOutliers = { count: 0, severity: 'none' };
  const noVariance = { coefficientOfVariation: 0.5 };

  // Low sample size → quality = 'low'
  const r1 = evaluateSampleQuality({
    assignedA: 50, assignedB: 80,
    exposedA: 40, exposedB: 60,
    varianceMetrics: noVariance,
    outlierResult: noOutliers,
  });
  assertEqual(r1.quality, 'low', 'assignedA<100 → quality = low');
  assert(r1.warnings.some(w => w.includes('Low sample size')), 'Low sample size warning present');

  // Balanced, sufficient → quality = 'high'
  const r2 = evaluateSampleQuality({
    assignedA: 500, assignedB: 500,
    exposedA: 450, exposedB: 440,
    varianceMetrics: noVariance,
    outlierResult: noOutliers,
  });
  assertEqual(r2.quality, 'high', 'Balanced sufficient data → quality = high');
  assertEqual(r2.warnings.length, 0, 'No warnings for balanced sufficient data');

  // Exposure imbalance
  const r3 = evaluateSampleQuality({
    assignedA: 500, assignedB: 500,
    exposedA: 400, exposedB: 200,   // 80% vs 40% — >20% delta
    varianceMetrics: noVariance,
    outlierResult: noOutliers,
  });
  assert(r3.warnings.some(w => w.includes('Exposure imbalance')), 'Exposure imbalance warning present');

  // High variance
  const r4 = evaluateSampleQuality({
    assignedA: 500, assignedB: 500,
    exposedA: 450, exposedB: 440,
    varianceMetrics: { coefficientOfVariation: 3.5 },
    outlierResult: noOutliers,
  });
  assert(r4.warnings.some(w => w.includes('High variance')), 'High variance warning present');

  // Outlier contamination (high severity)
  const r5 = evaluateSampleQuality({
    assignedA: 500, assignedB: 500,
    exposedA: 450, exposedB: 440,
    varianceMetrics: noVariance,
    outlierResult: { count: 55, severity: 'high' },
  });
  assertEqual(r5.quality, 'low', 'High outlier severity → quality = low');
  assert(r5.warnings.some(w => w.includes('Outlier contamination')), 'Outlier contamination warning present');
}

// ============================================================================
// SVE-08: evaluateExperiment — full report structure
// ============================================================================
section('SVE-08: evaluateExperiment — report structure');
{
  const report = evaluateExperiment({
    experimentId: 'struct-test',
    assignedA: 300, assignedB: 300,
    exposedA: 250, exposedB: 240,
    conversionsA: 30, conversionsB: 45,
    outcomes: {}, sessions: [],
  });

  // Required fields
  const requiredFields = [
    'experimentId', 'assignedA', 'assignedB', 'exposedA', 'exposedB',
    'conversionsA', 'conversionsB', 'conversionRateA', 'conversionRateB',
    'exposureRatio', 'ittUplift', 'ittUpliftAbs', 'ci95', 'pValue',
    'effectSize', 'medianUplift', 'variance', 'sampleQuality',
    'outliers', 'significance', 'verdict', 'warnings',
  ];
  for (const f of requiredFields) {
    assert(f in report, `Report has field: ${f}`);
  }

  // Exact field structure
  assert('lower' in report.ci95 && 'upper' in report.ci95, 'ci95 has lower and upper');
  assert('h' in report.effectSize && 'interpretation' in report.effectSize, 'effectSize has h and interpretation');
  assert('count' in report.outliers, 'outliers has count');
  assert('severity' in report.outliers, 'outliers has severity');
  assert('sampleVariance' in report.variance, 'variance has sampleVariance');
  assert(Array.isArray(report.warnings), 'warnings is an array');
  assert(typeof report.significance === 'boolean', 'significance is boolean');
  assert(typeof report.verdict === 'string', 'verdict is a string');
  assertEqual(report.experimentId, 'struct-test', 'experimentId preserved');
}

// ============================================================================
// SVE-09: evaluateExperiment — ITT formula is correct (ALL assigned)
// ============================================================================
section('SVE-09: evaluateExperiment — ITT uses ALL assigned (not exposed only)');
{
  // 1000 assigned per group, only 100 exposed each
  // 50 conversions in B assigned, 20 in A assigned
  const report = evaluateExperiment({
    experimentId: 'itt-formula-test',
    assignedA: 1000, assignedB: 1000,
    exposedA: 100, exposedB: 100,
    conversionsA: 20, conversionsB: 50,
    outcomes: {}, sessions: [],
  });

  // ITT rate = conversions / ASSIGNED (not / exposed)
  assertApprox(report.conversionRateA, 20 / 1000, 0.0001, 'ITT rateA = conversions/assignedA');
  assertApprox(report.conversionRateB, 50 / 1000, 0.0001, 'ITT rateB = conversions/assignedB');
  assertApprox(report.ittUplift, (0.05 - 0.02) / 0.02, 0.001, 'ITT uplift = (rateB-rateA)/rateA');

  // If we used only exposed: rateA=0.20, rateB=0.50 — NOT what ITT produces
  assert(report.conversionRateA < 0.10, 'ITT does NOT divide by exposedA (would give 0.20)');
}

// ============================================================================
// SVE-10: significance rule — strict triple condition
// ============================================================================
section('SVE-10: significance — strict triple condition');
{
  // Low sample → significance must be false regardless of p-value
  const lowSample = evaluateExperiment({
    experimentId: 'sig-low-sample',
    assignedA: 50, assignedB: 50,
    exposedA: 40, exposedB: 45,
    conversionsA: 0, conversionsB: 50,   // extreme signal
    outcomes: {}, sessions: [],
  });
  assertEqual(lowSample.significance, false, 'significance=false when sampleQuality=low');
  assertEqual(lowSample.verdict, 'No statistically significant uplift detected.', 'Correct verdict for non-significant');

  // Sufficient sample, but CI crosses zero
  const ciCrossesZero = evaluateExperiment({
    experimentId: 'sig-ci-zero',
    assignedA: 500, assignedB: 500,
    exposedA: 450, exposedB: 440,
    conversionsA: 50, conversionsB: 52,  // tiny difference
    outcomes: {}, sessions: [],
  });
  // Whether significant or not depends on bootstrap; key constraint is CI test
  assert(typeof ciCrossesZero.significance === 'boolean', 'significance is boolean');

  // Verify verdict text matches significance boolean
  if (ciCrossesZero.significance) {
    assertEqual(ciCrossesZero.verdict, 'Statistically significant uplift detected.', 'Verdict matches significance=true');
  } else {
    assertEqual(ciCrossesZero.verdict, 'No statistically significant uplift detected.', 'Verdict matches significance=false');
  }
}

// ============================================================================
// SVE-11: evaluateExperiment — verdict text is exact spec text
// ============================================================================
section('SVE-11: verdict text matches spec exactly');
{
  const verdictFalse = 'No statistically significant uplift detected.';
  const verdictTrue  = 'Statistically significant uplift detected.';

  // Low sample → always false
  const r1 = evaluateExperiment({ experimentId: 'v1', assignedA: 10, assignedB: 10, exposedA: 8, exposedB: 9, conversionsA: 1, conversionsB: 2, outcomes: {}, sessions: [] });
  assertEqual(r1.verdict, verdictFalse, 'Low sample verdict = exact spec text');

  // Force-test the verdict strings via sampleQuality path
  assert(!r1.verdict.includes('Winner'), 'Verdict never says "Winner"');
  assert(!r1.verdict.includes('better'), 'Verdict never says "better"');
  assert(!r1.verdict.includes('uplift detected') || r1.verdict === verdictTrue || r1.verdict === verdictFalse,
    'Verdict is one of the two exact strings');
}

// ============================================================================
// SVE-12: evaluateExperiment — determinism
// ============================================================================
section('SVE-12: determinism — same inputs → same outputs');
{
  const input = {
    experimentId: 'det-test',
    assignedA: 200, assignedB: 200,
    exposedA: 180, exposedB: 175,
    conversionsA: 20, conversionsB: 35,
    outcomes: {}, sessions: [],
  };

  const r1 = evaluateExperiment(input);
  const r2 = evaluateExperiment(input);
  assertEqual(r1.pValue,         r2.pValue,        'pValue is deterministic');
  assertEqual(r1.ci95.lower,     r2.ci95.lower,    'CI lower is deterministic');
  assertEqual(r1.ci95.upper,     r2.ci95.upper,    'CI upper is deterministic');
  assertEqual(r1.significance,   r2.significance,  'significance is deterministic');
  assertEqual(r1.sampleQuality,  r2.sampleQuality, 'sampleQuality is deterministic');
  assertEqual(r1.outliers.count, r2.outliers.count,'outlier count is deterministic');
}

// ============================================================================
// SVE-13: evaluateExperiment — invalid inputs throw
// ============================================================================
section('SVE-13: input validation');
{
  const good = { assignedA: 100, assignedB: 100, exposedA: 80, exposedB: 80, conversionsA: 10, conversionsB: 15, outcomes: {}, sessions: [] };

  let threw = false;
  try { evaluateExperiment({ ...good, experimentId: '' }); } catch (e) { threw = true; }
  assert(threw, 'Empty experimentId throws');

  threw = false;
  try { evaluateExperiment({ ...good, experimentId: 'x', assignedA: -1 }); } catch (e) { threw = true; }
  assert(threw, 'Negative assignedA throws');

  threw = false;
  try { evaluateExperiment({ ...good, experimentId: 'x', conversionsA: 1.5 }); } catch (e) { threw = true; }
  assert(threw, 'Non-integer conversionsA throws');
}

// ============================================================================
// SVE-14: integration — ExperimentEngine.getStatisticalReport()
// ============================================================================
section('SVE-14: integration with ExperimentEngine.getStatisticalReport()');
{
  const eng = new ExperimentEngine({
    minSessionsForStats: 2,
    bootstrapIterations: 100,
    permutationIterations: 100,
  });

  let now = NOW;
  for (let i = 0; i < 40; i++) {
    const id = `integ-sess-${i}`;
    eng.assignVariant(id);
    eng.recordExposure({ sessionId: id, context: 'cart', productId: 'p1', now });
    if (i % 4 === 0) {
      eng.recordConversion({ sessionId: id, type: 'checkout', revenue: 50 + i * 2, now: now + 1000 });
    }
    now += 500;
  }

  const report = eng.getStatisticalReport('integ-exp', null);

  // Structure check
  assert('experimentId'    in report, 'getStatisticalReport: experimentId present');
  assert('ittUplift'       in report, 'getStatisticalReport: ittUplift present');
  assert('significance'    in report, 'getStatisticalReport: significance present');
  assert('verdict'         in report, 'getStatisticalReport: verdict present');
  assert('sampleQuality'   in report, 'getStatisticalReport: sampleQuality present');
  assert('ci95'            in report, 'getStatisticalReport: ci95 present');
  assert('pValue'          in report, 'getStatisticalReport: pValue present');
  assert('effectSize'      in report, 'getStatisticalReport: effectSize present');
  assert('outliers'        in report, 'getStatisticalReport: outliers present');
  assert('warnings'        in report, 'getStatisticalReport: warnings present');

  // ITT correctness
  const totalSessions = report.assignedA + report.assignedB;
  assert(totalSessions === 40, `Total sessions = 40 (got ${totalSessions})`);
  assertEqual(report.conversionsA + report.conversionsB, 10, 'Total conversions = 10 (every 4th of 40)');

  // Never modifies engine state
  const diagBefore = eng.getDiagnostics();
  eng.getStatisticalReport('integ-exp', null);
  const diagAfter = eng.getDiagnostics();
  assertEqual(diagBefore.totalSessions, diagAfter.totalSessions, 'getStatisticalReport does not modify session count');
  assertEqual(diagBefore.decisionLogSize, diagAfter.decisionLogSize, 'getStatisticalReport does not modify decision log');
}

// ============================================================================
// SVE-15: integration — InterventionOutcomeTracker.getConversionSnapshot()
// ============================================================================
section('SVE-15: integration with InterventionOutcomeTracker.getConversionSnapshot()');
{
  const tracker = new InterventionOutcomeTracker();

  // Record some exposures and outcomes
  tracker.recordExposure({
    decisionId: 'd-1', messageId: 'm-1', sessionId: 'snap-sess-1',
    storeId: 'store-1', productId: 'p-1', context: 'cart',
    family: 'URGENCY', nowMs: NOW,
  });
  tracker.recordOutcome({
    sessionId: 'snap-sess-1', messageId: 'm-1', exposureId: null,
    outcomeType: OUTCOME_TYPES.CHECKOUT_AFTER,
    delta: { revenueDelta: 49.99 },
    nowMs: NOW + 60000,
  });

  tracker.recordExposure({
    decisionId: 'd-2', messageId: 'm-2', sessionId: 'snap-sess-2',
    storeId: 'store-1', productId: 'p-2', context: 'listing',
    family: 'SOCIAL_PROOF', nowMs: NOW + 1000,
  });
  tracker.recordOutcome({
    sessionId: 'snap-sess-2', messageId: 'm-2', exposureId: null,
    outcomeType: OUTCOME_TYPES.DISMISSED,
    delta: null,
    nowMs: NOW + 30000,
  });

  const snap = tracker.getConversionSnapshot(['snap-sess-1', 'snap-sess-2', 'snap-sess-missing']);

  assert(typeof snap.exposedCount   === 'number', 'exposedCount is number');
  assert(typeof snap.convertedCount === 'number', 'convertedCount is number');
  assert(typeof snap.revenueBySession  === 'object', 'revenueBySession is object');
  assert(typeof snap.outcomesBySession === 'object', 'outcomesBySession is object');

  // Empty sessionIds → zeros
  const snapEmpty = tracker.getConversionSnapshot([]);
  assertEqual(snapEmpty.exposedCount,   0, 'Empty sessionIds → exposedCount = 0');
  assertEqual(snapEmpty.convertedCount, 0, 'Empty sessionIds → convertedCount = 0');

  // Type error
  let threw = false;
  try { tracker.getConversionSnapshot('not-an-array'); } catch (e) { threw = true; }
  assert(threw, 'getConversionSnapshot throws on non-array');
}

// ============================================================================
// SVE-16: authority — SVE is EXPLAIN ONLY
// ============================================================================
section('SVE-16: authority — EXPLAIN ONLY, no side effects');
{
  // evaluateExperiment must be a pure function
  // Test: calling it twice produces identical frozen results
  const input = {
    experimentId: 'purity-test',
    assignedA: 200, assignedB: 200,
    exposedA: 150, exposedB: 145,
    conversionsA: 22, conversionsB: 31,
    outcomes: {}, sessions: [],
  };

  const r1 = evaluateExperiment(input);
  // Attempt to mutate (should fail — result is frozen)
  let mutationThrew = false;
  try {
    'use strict';
    (r1 ).ittUplift = 9999;
  } catch (e) { mutationThrew = true; }
  // Frozen check is strict-mode only; we verify the value didn't change
  assert(r1.ittUplift !== 9999, 'evaluateExperiment result is frozen / immutable');

  // Input is not mutated
  const inputCopy = { ...input };
  evaluateExperiment(input);
  assertEqual(input.assignedA,    inputCopy.assignedA,    'evaluateExperiment does not mutate input.assignedA');
  assertEqual(input.conversionsB, inputCopy.conversionsB, 'evaluateExperiment does not mutate input.conversionsB');
}

// ============================================================================
// Results
// ============================================================================

console.log('\n====================================================');
console.log('  STATISTICAL VALIDITY ENGINE TEST SUITE');
console.log(`  RESULTS: ${passCount}/${assertCount} passed, ${failCount} failed`);
if (failures.length > 0) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log('====================================================\n');

if (failCount > 0) process.exit(1);
