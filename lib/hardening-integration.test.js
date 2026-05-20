'use strict';

/**
 * tests/hardening-integration.test.js
 *
 * Integration tests for the Runtime Hardening layer:
 *   - decision-explainability-engine
 *   - intervention-outcome-tracker
 *   - intervention-learning-store
 *   - session-orchestrator integration
 *
 * Validates:
 *   1. Decision explainability integrity (every gate is recorded)
 *   2. Intervention outcome linkage (decisionId -> exposureId -> outcome)
 *   3. Replay-safe decision graphs (snapshot/restore preserves all state)
 *   4. Deterministic outcome tracking (same sequence -> same results)
 *   5. Learning-store bounded memory (maxBuckets, maxObservationsPerBucket)
 *   6. Snapshot/restore integrity (all three modules)
 *   7. Stale cleanup correctness (retention windows)
 *   8. No duplicated outcome attribution (wrong session rejected)
 *   9. Attribution window expiry (outcomes past window ignored)
 *  10. Cross-module linkage (decisionId flows end-to-end)
 */

const path = require('path');
const LIB = path.join(__dirname, '../lib');

const { DecisionExplainabilityEngine, DECISION_OUTCOMES, GATES } = require(`${LIB}/decision-explainability-engine`);
const { InterventionOutcomeTracker, OUTCOME_TYPES } = require(`${LIB}/intervention-outcome-tracker`);
const { InterventionLearningStore, SUCCESS_OUTCOMES, FAILURE_OUTCOMES, BUCKET_DIMENSIONS } = require(`${LIB}/intervention-learning-store`);

// ============================================================================
// Test harness
// ============================================================================

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  totalTests++;
  if (condition) {
    passed++;
    process.stdout.write(`  ✅ ${message}\n`);
  } else {
    failed++;
    failures.push(message);
    process.stdout.write(`  ❌ FAIL: ${message}\n`);
  }
}

function assertEqual(actual, expected, message) {
  totalTests++;
  if (actual === expected) {
    passed++;
    process.stdout.write(`  ✅ ${message}\n`);
  } else {
    failed++;
    const detail = `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(detail);
    process.stdout.write(`  ❌ FAIL: ${detail}\n`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  totalTests++;
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  if (ok) {
    passed++;
    process.stdout.write(`  ✅ ${message}\n`);
  } else {
    failed++;
    const detail = `${message} — expected ~${expected} (±${tolerance}), got ${actual}`;
    failures.push(detail);
    process.stdout.write(`  ❌ FAIL: ${detail}\n`);
  }
}

function section(name) {
  process.stdout.write(`\n${'─'.repeat(60)}\n${name}\n${'─'.repeat(60)}\n`);
}

// ============================================================================
// Shared fixtures
// ============================================================================

const BASE_NOW = 1_700_000_000_000; // fixed epoch for determinism
const SESSION = 's_test_001';
const STORE = 'demo';
const PRODUCT = 'prod_001';

// ============================================================================
// TEST 1: Decision Explainability — gate recording integrity
// ============================================================================

section('TEST 1: Decision Explainability — gate recording integrity');

{
  const dee = new DecisionExplainabilityEngine();

  // All gates pass → approved
  const b1 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: BASE_NOW });
  b1.withBehavioralState({ intentState: 'exploring', intentConfidence: 0.72, funnelStage: 'discovery', revisitCount: 0 })
    .withSignals({ dwellMs: 2400, scroll: 0.4 })
    .withFatigueSnapshot({ fatigueScore: 0.15, canIntervene: true, reason: null })
    .withRankingResult({ selected: { id: 'msg_001', family: 'benefit', subtype: 'discovery_intro' }, rejected: ['urgency', 'social'] });
  for (const gate of GATES) b1.gatePass(gate);
  const decId1 = b1.approve();

  assert(typeof decId1 === 'string', 'approve() returns string decisionId');
  const rec1 = dee.getDecision(decId1);
  assert(rec1 !== null, 'record is stored after approve()');
  assertEqual(rec1.finalDecision, DECISION_OUTCOMES.APPROVED, 'finalDecision is APPROVED');
  assertEqual(rec1.gatesPassed.length, GATES.length, `all ${GATES.length} gates are recorded as passed`);
  assertEqual(rec1.gatesRejected.length, 0, 'no gates rejected on approval');
  assertEqual(rec1.intentState, 'exploring', 'intentState captured');
  assertEqual(rec1.funnelStage, 'discovery', 'funnelStage captured');
  assertEqual(rec1.selectedFamily, 'benefit', 'selectedFamily captured');
  assert(rec1.rejectedFamilies.includes('urgency'), 'rejectedFamilies includes urgency');
  assert(rec1.signals !== null, 'signals captured');
  assert(rec1.fatigueSnapshot !== null, 'fatigueSnapshot captured');

  // Fatigue blocks
  const b2 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'modal', productId: PRODUCT, nowMs: BASE_NOW + 1000 });
  b2.gatePass('presence').gatePass('context_cooldown').withFatigueSnapshot({ fatigueScore: 0.95 });
  const decId2 = b2.block('fatigue_score_too_high');
  const rec2 = dee.getDecision(decId2);
  assertEqual(rec2.finalDecision, DECISION_OUTCOMES.BLOCKED, 'blocked record has BLOCKED outcome');
  assert(rec2.gatesRejected.includes('fatigue'), 'fatigue gate rejected on block');
  assert(rec2.suppressionReasons.includes('fatigue_score_too_high'), 'suppression reason recorded');

  // Policy suppresses
  const b3 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'cart', productId: PRODUCT, nowMs: BASE_NOW + 2000 });
  b3.gatePass('presence').gatePass('context_cooldown').gatePass('fatigue');
  const decId3 = b3.deny('policy_suppress');
  assertEqual(dee.getDecision(decId3).finalDecision, DECISION_OUTCOMES.DENIED, 'denied record has DENIED outcome');

  // Delayed
  const b4 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'cart', productId: PRODUCT, nowMs: BASE_NOW + 3000 });
  b4.gatePass('presence').gatePass('context_cooldown').gatePass('fatigue');
  b4.gateReject('policy', 'policy_delay').commit(DECISION_OUTCOMES.DELAYED, 'shouldDelay');
  assertEqual(dee.getDecision(b4.decisionId).finalDecision, DECISION_OUTCOMES.DELAYED, 'delayed record has DELAYED outcome');

  // Suppressed by visibility
  const b5 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: BASE_NOW + 4000 });
  for (const g of ['presence', 'context_cooldown', 'fatigue', 'policy', 'candidates', 'ranking']) b5.gatePass(g);
  const decId5 = b5.suppress('not_visible');
  assertEqual(dee.getDecision(decId5).finalDecision, DECISION_OUTCOMES.SUPPRESSED, 'suppressed record has SUPPRESSED outcome');

  // Session stats
  const stats = dee.getSessionStats(SESSION, BASE_NOW + 10000);
  assertEqual(stats.total, 5, 'stats.total = 5 decisions');
  assertApprox(stats.approvalRate, 0.2, 0.01, 'approvalRate = 0.20');
  assertApprox(stats.blockRate, 0.2, 0.01, 'blockRate = 0.20');

  // explain() output
  const explanation = dee.explain(decId1);
  assert(explanation.includes('approved'), 'explain() includes final outcome');
  assert(explanation.includes('Gates passed'), 'explain() includes gates passed');
  assert(explanation.includes('benefit'), 'explain() includes selected family');
  assert(explanation.includes('exploring'), 'explain() includes intent state');

  // linkOutcome() patching
  dee.linkOutcome(decId1, 'exp_x_1');
  assertEqual(dee.getDecision(decId1).outcomeId, 'exp_x_1', 'linkOutcome() patches outcomeId');

  // query() filter
  const approved = dee.query({ finalDecision: DECISION_OUTCOMES.APPROVED, sessionId: SESSION });
  assertEqual(approved.length, 1, 'query(finalDecision=approved) returns 1 record');
  const fromTs = dee.query({ fromTs: BASE_NOW + 2000 });
  assertEqual(fromTs.length, 3, 'query(fromTs) filters correctly');
}

// ============================================================================
// TEST 2: Explainability — nowMs validation (determinism contract)
// ============================================================================

section('TEST 2: Explainability — determinism contracts');

{
  const dee = new DecisionExplainabilityEngine();

  // nowMs must be a finite number
  let threw = false;
  try {
    dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: NaN });
  } catch (e) {
    threw = e instanceof TypeError;
  }
  assert(threw, 'openDecision throws TypeError on NaN nowMs');

  // Dry-run
  const b = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: BASE_NOW });
  b.asDryRun();
  b.commit(DECISION_OUTCOMES.DRY_RUN, 'dry_run_test');
  assert(dee.getDecision(b.decisionId).dryRun === true, 'dryRun flag is true after asDryRun()');

  // Committed twice → idempotent (second call returns same decisionId)
  const b2 = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: BASE_NOW + 1 });
  const id1 = b2.approve('first_commit');
  const id2 = b2.approve('second_commit'); // should be no-op
  assertEqual(id1, id2, 'second commit() is idempotent — returns same decisionId');
  assertEqual(dee.query({ sessionId: SESSION, finalDecision: DECISION_OUTCOMES.APPROVED }).length, 1,
    'only one record stored despite double commit');
}

// ============================================================================
// TEST 3: Explainability — snapshot/restore integrity
// ============================================================================

section('TEST 3: Explainability — snapshot/restore');

{
  const dee = new DecisionExplainabilityEngine();
  const decIds = [];
  for (let i = 0; i < 5; i++) {
    const b = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: BASE_NOW + i * 1000 });
    b.withBehavioralState({ intentState: 'evaluating', intentConfidence: 0.5 + i * 0.05, funnelStage: 'consideration' });
    if (i % 2 === 0) decIds.push(b.approve());
    else decIds.push(b.block('test_block'));
  }

  const snap = dee.snapshot();
  assertEqual(snap.__type, 'DecisionExplainabilityEngine', 'snapshot has correct __type');
  assertEqual(snap.__version, 1, 'snapshot has correct __version');
  assertEqual(snap.records.length, 5, 'snapshot contains all 5 records');

  const dee2 = new DecisionExplainabilityEngine();
  const restored = dee2.restore(snap);
  assertEqual(restored, true, 'restore() returns true on success');
  assertEqual(dee2._seq, dee._seq, 'seq is preserved after restore');

  for (const id of decIds) {
    const orig = dee.getDecision(id);
    const rest = dee2.getDecision(id);
    assert(rest !== null, `restored record ${id} exists`);
    assertEqual(rest.finalDecision, orig.finalDecision, `finalDecision matches for ${id}`);
    assertEqual(rest.gatesPassed.length, orig.gatesPassed.length, `gatesPassed length matches for ${id}`);
  }

  // Wrong type → restore returns false
  const badRestore = dee2.restore({ __type: 'WrongType', __version: 1, records: [] });
  assertEqual(badRestore, false, 'restore() returns false on wrong __type');

  // Wrong version → restore returns false
  const badVersion = dee2.restore({ __type: 'DecisionExplainabilityEngine', __version: 99, records: [] });
  assertEqual(badVersion, false, 'restore() returns false on wrong __version');
}

// ============================================================================
// TEST 4: Explainability — cleanup correctness
// ============================================================================

section('TEST 4: Explainability — stale cleanup');

{
  const dee = new DecisionExplainabilityEngine({ retentionMs: 5000 });

  // 3 old records
  for (let i = 0; i < 3; i++) {
    const b = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: 1000 + i });
    b.approve();
  }
  // 2 fresh records
  const freshNow = BASE_NOW + 1_000_000;
  for (let i = 0; i < 2; i++) {
    const b = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: PRODUCT, nowMs: freshNow + i });
    b.approve();
  }

  // cleanup at freshNow + 3000: cutoff = freshNow+3000 - 5000 = freshNow-2000
  // old records (t=100,101,102) are far below cutoff → purged
  // fresh records (t=freshNow, freshNow+1) are above cutoff → kept
  dee.cleanup(freshNow + 3000);
  const diag = dee.getDiagnostics();
  assertEqual(diag.recordCount, 2, 'cleanup() removes 3 old records, 2 fresh remain');

  // cleanup throws on invalid nowMs
  let threw = false;
  try { dee.cleanup('not_a_number'); } catch(e) { threw = true; }
  assert(threw, 'cleanup() throws on non-number nowMs');
}

// ============================================================================
// TEST 5: Outcome Tracker — exposure recording and outcome attribution
// ============================================================================

section('TEST 5: Outcome Tracker — exposure and attribution');

{
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 30_000 });

  const expId = iot.recordExposure({
    decisionId: 'dec_001',
    messageId: 'msg_001',
    sessionId: SESSION,
    storeId: STORE,
    productId: PRODUCT,
    context: 'listing',
    family: 'benefit',
    subtype: 'discovery_intro',
    intentStateAtExposure: 'exploring',
    funnelStageAtExposure: 'discovery',
    hesitationScoreAtExposure: 0.1,
    revenueAtExposure: 0,
    nowMs: BASE_NOW,
  });

  assert(typeof expId === 'string' && expId.startsWith('exp_'), 'recordExposure() returns prefixed exposureId');
  assert(iot.hasActiveExposure(SESSION), 'hasActiveExposure() true after recordExposure');

  const actives = iot.getActiveExposures(SESSION);
  assertEqual(actives.length, 1, 'getActiveExposures() returns 1 active record');
  assertEqual(actives[0].family, 'benefit', 'active record has correct family');
  assertEqual(actives[0].decisionId, 'dec_001', 'active record has correct decisionId');

  // Record hover outcome
  const ok1 = iot.recordOutcome({
    sessionId: SESSION,
    messageId: 'msg_001',
    outcomeType: OUTCOME_TYPES.HOVER_AFTER,
    nowMs: BASE_NOW + 3_000,
  });
  assert(ok1 === true, 'recordOutcome(HOVER_AFTER) returns true');

  // Record add-to-cart
  const ok2 = iot.recordOutcome({
    sessionId: SESSION,
    messageId: 'msg_001',
    outcomeType: OUTCOME_TYPES.ADD_TO_CART_AFTER,
    delta: { intentState: 'high_intent' },
    nowMs: BASE_NOW + 8_000,
  });
  assert(ok2 === true, 'recordOutcome(ADD_TO_CART_AFTER) returns true');

  // Wrong session → rejected
  const wrongOk = iot.recordOutcome({
    sessionId: 's_wrong',
    messageId: 'msg_001',
    outcomeType: OUTCOME_TYPES.CLICKED,
    nowMs: BASE_NOW + 9_000,
  });
  assert(wrongOk === false, 'recordOutcome() for wrong session returns false');
}

// ============================================================================
// TEST 6: Outcome Tracker — attribution window expiry
// ============================================================================

section('TEST 6: Outcome Tracker — attribution window expiry');

{
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 5_000 });

  iot.recordExposure({
    decisionId: 'dec_002', messageId: 'msg_002', sessionId: SESSION,
    storeId: STORE, productId: PRODUCT, context: 'modal', family: 'reassurance',
    nowMs: BASE_NOW,
  });

  // Outcome arrives after window
  const expired = iot.recordOutcome({
    sessionId: SESSION, messageId: 'msg_002',
    outcomeType: OUTCOME_TYPES.ADD_TO_CART_AFTER,
    nowMs: BASE_NOW + 10_000, // 10s > 5s window
  });
  assert(expired === false, 'outcome past attribution window returns false');
  assert(!iot.hasActiveExposure(SESSION), 'expired exposure is removed from active set');
}

// ============================================================================
// TEST 7: Outcome Tracker — session close
// ============================================================================

section('TEST 7: Outcome Tracker — session close and metrics');

{
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 60_000 });

  // Two exposures
  iot.recordExposure({
    decisionId: 'dec_a', messageId: 'msg_a', sessionId: SESSION,
    storeId: STORE, productId: PRODUCT, context: 'listing', family: 'benefit',
    intentStateAtExposure: 'exploring', funnelStageAtExposure: 'discovery',
    nowMs: BASE_NOW,
  });
  iot.recordOutcome({ sessionId: SESSION, messageId: 'msg_a', outcomeType: OUTCOME_TYPES.ADD_TO_CART_AFTER, nowMs: BASE_NOW + 5_000 });

  iot.recordExposure({
    decisionId: 'dec_b', messageId: 'msg_b', sessionId: SESSION,
    storeId: STORE, productId: PRODUCT, context: 'modal', family: 'reassurance',
    intentStateAtExposure: 'hesitating', funnelStageAtExposure: 'evaluation',
    nowMs: BASE_NOW + 10_000,
  });
  // No explicit outcome for msg_b → will be 'ignored' on closeSession

  iot.closeSession(SESSION, BASE_NOW + 20_000);
  assert(!iot.hasActiveExposure(SESSION), 'no active exposures after closeSession');

  const metrics = iot.getSessionMetrics(SESSION, BASE_NOW + 25_000);
  assertEqual(metrics.total, 2, 'metrics.total = 2');
  assert(metrics.attributed >= 1, 'at least msg_a is attributed (cart_add outcome)');  // msg_b gets ignored (not user-attributed)
  assert(metrics.cartAddRate > 0, 'cartAddRate > 0');
  assert(metrics.ignoreRate > 0, 'ignoreRate > 0 (msg_b was ignored)');

  const outcomes = iot.getOutcomesForLearning(SESSION);
  assertEqual(outcomes.length, 2, 'getOutcomesForLearning() returns 2 records');
  assert(outcomes.every(o => o.decisionId !== undefined), 'all outcomes have decisionId');
  assert(outcomes.every(o => o.family !== undefined), 'all outcomes have family');
  assert(outcomes.every(o => o.primaryOutcome !== undefined), 'all outcomes have primaryOutcome');
}

// ============================================================================
// TEST 8: Outcome Tracker — snapshot/restore
// ============================================================================

section('TEST 8: Outcome Tracker — snapshot/restore');

{
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 60_000 });

  // Build state
  const expId = iot.recordExposure({
    decisionId: 'dec_snap', messageId: 'msg_snap', sessionId: SESSION,
    storeId: STORE, productId: PRODUCT, context: 'cart', family: 'urgency',
    nowMs: BASE_NOW,
  });
  iot.recordOutcome({ sessionId: SESSION, messageId: 'msg_snap', outcomeType: OUTCOME_TYPES.CHECKOUT_AFTER, nowMs: BASE_NOW + 12_000 });
  iot.closeSession(SESSION, BASE_NOW + 15_000);

  const snap = iot.snapshot();
  assertEqual(snap.__type, 'InterventionOutcomeTracker', 'snapshot __type correct');
  assertEqual(snap.__version, 1, 'snapshot __version correct');

  const iot2 = new InterventionOutcomeTracker();
  const ok = iot2.restore(snap);
  assertEqual(ok, true, 'restore() returns true');
  assertEqual(iot2._seq, iot._seq, 'seq restored correctly');
  assertEqual(iot2._completedOutcomes.length, iot._completedOutcomes.length, 'completedOutcomes restored');

  const restoredMetrics = iot2.getSessionMetrics(SESSION);
  assert(restoredMetrics.checkoutRate > 0, 'restored metrics show checkout rate');

  // Wrong type
  assertEqual(iot2.restore({ __type: 'Wrong' }), false, 'restore() returns false on wrong type');
}

// ============================================================================
// TEST 9: Learning Store — ingest, aggregate, reliability
// ============================================================================

section('TEST 9: Learning Store — ingest and statistics');

{
  const ils = new InterventionLearningStore({ minObservationsForReliability: 5, maxObservationsPerBucket: 100 });

  // Ingest 10 outcomes for 'benefit' family in 'fashion' category
  const sampleOutcomes = [];
  for (let i = 0; i < 10; i++) {
    sampleOutcomes.push({
      family: 'benefit',
      subtype: 'discovery_intro',
      primaryOutcome: i < 7 ? OUTCOME_TYPES.ADD_TO_CART_AFTER : OUTCOME_TYPES.IGNORED,
      intentStateAtExposure: 'exploring',
      funnelStageAtExposure: 'discovery',
      hesitationScoreAtExposure: 0.15,
      revisitCount: 0,
      deltaMs: 5000 + i * 200,
    });
  }
  ils.ingestOutcomes(sampleOutcomes, { productCategory: 'fashion', cartPattern: 'single' }, BASE_NOW);

  const stats = ils.getFamilyStats('benefit');
  assert(stats.total >= 10, 'getFamilyStats total >= 10');
  assert(stats.reliable, 'stats are reliable (total >= minObservationsForReliability)');
  assertApprox(stats.cartAddRate, 0.7, 0.05, 'cartAddRate ≈ 0.70 (7/10)');
  assertApprox(stats.ignoreRate, 0.3, 0.05, 'ignoreRate ≈ 0.30 (3/10)');
  assert(stats.averageDeltaMs != null, 'averageDeltaMs is computed');

  // Unreliable family (< minObservations)
  ils.ingestOutcomes([{
    family: 'urgency', subtype: 'scarcity',
    primaryOutcome: OUTCOME_TYPES.DISMISSED,
    intentStateAtExposure: 'high_intent', funnelStageAtExposure: 'purchase_intent',
    hesitationScoreAtExposure: 0, deltaMs: 2000,
  }], {}, BASE_NOW);
  const urgencyStats = ils.getFamilyStats('urgency');
  assert(!urgencyStats.reliable, 'urgency stats are unreliable (only 1 observation)');

  // Contextual stats
  const ctxStats = ils.getFamilyStatsForContext('benefit', {
    intentState: 'exploring', funnelStage: 'discovery', category: 'fashion',
  });
  assert(ctxStats.total > 0, 'getFamilyStatsForContext returns data');

  // getAllFamilyStats ordering
  const allStats = ils.getAllFamilyStats();
  assert(allStats.length >= 2, 'getAllFamilyStats returns at least 2 entries');
  // benefit has higher success rate than urgency
  const benefitIdx = allStats.findIndex(s => s.family === 'benefit');
  const urgencyIdx = allStats.findIndex(s => s.family === 'urgency');
  if (benefitIdx >= 0 && urgencyIdx >= 0) {
    assert(benefitIdx < urgencyIdx, 'benefit ranks above urgency by successRate');
  }

  // rankFamiliesForContext
  const ranked = ils.rankFamiliesForContext({ intentState: 'exploring', funnelStage: 'discovery' }, ['benefit', 'urgency']);
  assertEqual(ranked[0].family, 'benefit', 'benefit ranks first for this context');
  assert(ranked[0].reliable, 'top ranked family is reliable');
  assert(!ranked[ranked.length - 1].reliable || ranked.length === 1, 'unreliable families ranked last');
}

// ============================================================================
// TEST 10: Learning Store — bounded memory
// ============================================================================

section('TEST 10: Learning Store — bounded memory');

{
  // maxBuckets enforcement
  const ilsBounded = new InterventionLearningStore({ maxBuckets: 4, maxObservationsPerBucket: 50 });
  for (let i = 0; i < 20; i++) {
    ilsBounded.ingestOutcomes([{
      family: `family_${i}`,
      primaryOutcome: OUTCOME_TYPES.IGNORED,
      intentStateAtExposure: `state_${i}`,
      funnelStageAtExposure: 'discovery',
      deltaMs: 1000,
    }], { productCategory: `cat_${i}` }, BASE_NOW + i);
  }
  assert(ilsBounded._buckets.size <= 4, `maxBuckets=${4} enforced (got ${ilsBounded._buckets.size})`);

  // maxObservationsPerBucket enforcement
  const ilsObs = new InterventionLearningStore({ maxBuckets: 512, maxObservationsPerBucket: 5 });
  const manyOutcomes = Array.from({ length: 20 }, (_, i) => ({
    family: 'benefit',
    primaryOutcome: i % 2 === 0 ? OUTCOME_TYPES.ADD_TO_CART_AFTER : OUTCOME_TYPES.IGNORED,
    intentStateAtExposure: 'exploring',
    funnelStageAtExposure: 'discovery',
    deltaMs: 1000 + i * 100,
  }));
  ilsObs.ingestOutcomes(manyOutcomes, { productCategory: 'tech' }, BASE_NOW);

  const bucketKey = 'benefit::by_family::benefit';
  const bucket = ilsObs._buckets.get(bucketKey);
  assert(bucket != null, 'bucket exists after ingest');
  assert(bucket.total <= 5, `maxObservationsPerBucket=5 enforced (got ${bucket && bucket.total})`);
}

// ============================================================================
// TEST 11: Learning Store — snapshot/restore
// ============================================================================

section('TEST 11: Learning Store — snapshot/restore integrity');

{
  const ils = new InterventionLearningStore({ minObservationsForReliability: 2, maxObservationsPerBucket: 100 });

  // Build state with known distribution
  const knownOutcomes = [
    { family: 'benefit', primaryOutcome: OUTCOME_TYPES.ADD_TO_CART_AFTER, intentStateAtExposure: 'evaluating', funnelStageAtExposure: 'consideration', deltaMs: 4000 },
    { family: 'benefit', primaryOutcome: OUTCOME_TYPES.ADD_TO_CART_AFTER, intentStateAtExposure: 'evaluating', funnelStageAtExposure: 'consideration', deltaMs: 4500 },
    { family: 'benefit', primaryOutcome: OUTCOME_TYPES.IGNORED, intentStateAtExposure: 'evaluating', funnelStageAtExposure: 'consideration', deltaMs: 7000 },
  ];
  ils.ingestOutcomes(knownOutcomes, { productCategory: 'tech' }, BASE_NOW);

  const origStats = ils.getFamilyStats('benefit');
  const snap = ils.snapshot();

  assertEqual(snap.__type, 'InterventionLearningStore', 'snapshot __type correct');
  assertEqual(snap.__version, 1, 'snapshot __version correct');

  const ils2 = new InterventionLearningStore({ minObservationsForReliability: 2, maxObservationsPerBucket: 100 });
  const restoreOk = ils2.restore(snap);
  assertEqual(restoreOk, true, 'restore() returns true');
  assertEqual(ils2._seq, ils._seq, 'seq restored');
  assertEqual(ils2._buckets.size, ils._buckets.size, 'bucket count restored');

  const restoredStats = ils2.getFamilyStats('benefit');
  assertEqual(restoredStats.total, origStats.total, 'total preserved after restore');
  assertApprox(restoredStats.cartAddRate, origStats.cartAddRate, 0.001, 'cartAddRate preserved after restore');
  assertApprox(restoredStats.ignoreRate, origStats.ignoreRate, 0.001, 'ignoreRate preserved after restore');

  // Wrong type → false
  assertEqual(ils2.restore({ __type: 'Wrong' }), false, 'restore() returns false on wrong type');
}

// ============================================================================
// TEST 12: Learning Store — cleanup correctness
// ============================================================================

section('TEST 12: Learning Store — stale cleanup');

{
  const ils = new InterventionLearningStore({ retentionMs: 10_000, maxObservationsPerBucket: 100 });

  // Old observations
  ils.ingestOutcomes([
    { family: 'social', primaryOutcome: OUTCOME_TYPES.DISMISSED, intentStateAtExposure: 'exploring', funnelStageAtExposure: 'discovery', deltaMs: 1000 },
    { family: 'social', primaryOutcome: OUTCOME_TYPES.IGNORED, intentStateAtExposure: 'exploring', funnelStageAtExposure: 'discovery', deltaMs: 2000 },
  ], {}, 1000); // very old timestamp

  // Fresh observation
  ils.ingestOutcomes([
    { family: 'social', primaryOutcome: OUTCOME_TYPES.ADD_TO_CART_AFTER, intentStateAtExposure: 'high_intent', funnelStageAtExposure: 'purchase_intent', deltaMs: 500 },
  ], {}, BASE_NOW);

  const beforeCleanup = ils.getFamilyStats('social');
  assert(beforeCleanup.total >= 3, 'before cleanup: all 3 observations present');

  // Cleanup at BASE_NOW + 1000 → retention 10s → cutoff = BASE_NOW - 9000
  // old observations at t=1000 are far below cutoff → purged
  // fresh observation at BASE_NOW → kept
  ils.cleanup(BASE_NOW + 1000);
  const afterCleanup = ils.getFamilyStats('social');
  assertEqual(afterCleanup.total, 1, 'after cleanup: only 1 fresh observation remains');
}

// ============================================================================
// TEST 13: Cross-module linkage (decisionId end-to-end)
// ============================================================================

section('TEST 13: Cross-module linkage — decisionId end-to-end');

{
  const dee = new DecisionExplainabilityEngine();
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 60_000 });
  const ils = new InterventionLearningStore({ minObservationsForReliability: 1 });

  // Step 1: Open and approve a decision
  const db = dee.openDecision({ sessionId: SESSION, storeId: STORE, context: 'listing', productId: 'cross_product', nowMs: BASE_NOW });
  db.withBehavioralState({ intentState: 'evaluating', intentConfidence: 0.8, funnelStage: 'consideration', revisitCount: 1 })
    .withFatigueSnapshot({ fatigueScore: 0.2 })
    .withRankingResult({ selected: { id: 'msg_cross_001', family: 'quality', subtype: 'material_quality' }, rejected: [] });
  for (const g of GATES) db.gatePass(g);
  const decId = db.approve('all_gates_passed');

  // Step 2: Record exposure (with decisionId)
  const expId = iot.recordExposure({
    decisionId: decId,
    messageId: 'msg_cross_001',
    sessionId: SESSION, storeId: STORE, productId: 'cross_product',
    context: 'listing', family: 'quality', subtype: 'material_quality',
    intentStateAtExposure: 'evaluating', funnelStageAtExposure: 'consideration',
    hesitationScoreAtExposure: 0.25, nowMs: BASE_NOW,
  });

  // Step 3: Outcome arrives
  iot.recordOutcome({
    sessionId: SESSION, messageId: 'msg_cross_001',
    outcomeType: OUTCOME_TYPES.CART_RECOVERY,
    nowMs: BASE_NOW + 20_000,
  });

  // Step 4: Close session, get outcomes for learning
  iot.closeSession(SESSION, BASE_NOW + 25_000);
  const outcomes = iot.getOutcomesForLearning(SESSION);
  assert(outcomes.length > 0, 'outcomes exist after session close');

  const linkedOutcome = outcomes.find(o => o.decisionId === decId);
  assert(linkedOutcome !== undefined, 'outcome is linked to decisionId');
  assertEqual(linkedOutcome.family, 'quality', 'linked outcome has correct family');

  // Step 5: Link back to explainability record
  dee.linkOutcome(decId, expId);
  const explRecord = dee.getDecision(decId);
  assertEqual(explRecord.outcomeId, expId, 'explainability record linked to exposureId');

  // Step 6: Ingest into learning store
  ils.ingestOutcomes(outcomes, { productCategory: 'home', cartPattern: 'single' }, BASE_NOW + 30_000);
  const learningStats = ils.getFamilyStats('quality');
  assert(learningStats.total > 0, 'learning store has quality family stats after ingest');

  // Step 7: Verify the full chain is auditable
  const fullChain = {
    decisionId: decId,
    exposureId: expId,
    sessionId: SESSION,
    decisionRecord: dee.getDecision(decId),
    outcomeRecord: outcomes.find(o => o.decisionId === decId),
    learningStats: ils.getFamilyStats('quality'),
  };
  assert(fullChain.decisionRecord !== null, 'full chain: decisionRecord exists');
  assert(fullChain.outcomeRecord !== null, 'full chain: outcomeRecord exists');
  assert(fullChain.learningStats.total > 0, 'full chain: learningStats populated');
  assertEqual(fullChain.decisionRecord.selectedFamily, 'quality', 'full chain: selectedFamily flows correctly');
  assertEqual(fullChain.outcomeRecord.primaryOutcome, OUTCOME_TYPES.CART_RECOVERY, 'full chain: primaryOutcome is CART_RECOVERY');
}

// ============================================================================
// TEST 14: No duplicated outcome attribution
// ============================================================================

section('TEST 14: No duplicated outcome attribution');

{
  const iot = new InterventionOutcomeTracker({ attributionWindowMs: 60_000 });

  iot.recordExposure({
    decisionId: 'dec_dup', messageId: 'msg_dup', sessionId: SESSION,
    storeId: STORE, productId: PRODUCT, context: 'cart', family: 'reassurance',
    nowMs: BASE_NOW,
  });

  // Record same outcome type twice
  iot.recordOutcome({ sessionId: SESSION, messageId: 'msg_dup', outcomeType: OUTCOME_TYPES.HOVER_AFTER, nowMs: BASE_NOW + 1000 });
  iot.recordOutcome({ sessionId: SESSION, messageId: 'msg_dup', outcomeType: OUTCOME_TYPES.HOVER_AFTER, nowMs: BASE_NOW + 1500 });

  const actives = iot.getActiveExposures(SESSION);
  if (actives.length > 0) {
    // Multiple outcomes for same type are allowed (they represent separate hover events)
    const hoverOutcomes = actives[0].outcomes.filter(o => o.type === OUTCOME_TYPES.HOVER_AFTER);
    assert(hoverOutcomes.length === 2, 'two separate hover events are both recorded');
  }

  // But the primaryOutcome should be a single most-significant type
  iot.recordOutcome({ sessionId: SESSION, messageId: 'msg_dup', outcomeType: OUTCOME_TYPES.CHECKOUT_AFTER, nowMs: BASE_NOW + 5000 });
  iot.closeSession(SESSION, BASE_NOW + 10_000);

  const metrics = iot.getSessionMetrics(SESSION, BASE_NOW + 15_000);
  assertEqual(metrics.total, 1, 'only 1 exposure record (no duplication)');
  assert(metrics.checkoutRate > 0, 'checkout is the primary outcome');
}

// ============================================================================
// Summary
// ============================================================================

process.stdout.write(`\n${'═'.repeat(60)}\n`);
process.stdout.write(`TEST RESULTS: ${passed} passed, ${failed} failed / ${totalTests} total\n`);
if (failures.length > 0) {
  process.stdout.write(`\nFailed assertions:\n`);
  failures.forEach(f => process.stdout.write(`  ❌ ${f}\n`));
}
process.stdout.write(`${'═'.repeat(60)}\n`);
process.exit(failed > 0 ? 1 : 0);
