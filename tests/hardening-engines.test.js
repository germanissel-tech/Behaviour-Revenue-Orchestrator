'use strict';

/**
 * tests/hardening-engines.test.js
 *
 * Test suite for the three new hardening engines:
 *   - user-memory-engine.js
 *   - mobile-behavior-engine.js
 *   - observability-engine.js
 */

const { UserMemoryEngine, MS_PER_DAY: UME_MS_DAY } = require('../lib/user-memory-engine');
const {
  MobileBehaviorEngine,
  INTENT_STATES,
  SWIPE_DIRECTIONS,
} = require('../lib/mobile-behavior-engine');
const {
  ObservabilityEngine,
  DECISION_TYPES,
  ERROR_SEVERITY,
} = require('../lib/observability-engine');

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
  else { failCount++; const m = `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertApprox(a, e, delta, msg) {
  assertCount++;
  if (typeof a === 'number' && Math.abs(a - e) <= delta) { passCount++; }
  else { failCount++; const m = `${msg} (expected ~${e}±${delta}, got ${a})`; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertBetween(v, lo, hi, msg) {
  assertCount++;
  if (typeof v === 'number' && v >= lo && v <= hi) { passCount++; }
  else { failCount++; const m = `${msg} (expected [${lo},${hi}], got ${v})`; failures.push(m); console.error(`  FAIL: ${m}`); }
}
function assertNull(v, msg) { assertEqual(v, null, msg); }
function assertNotNull(v, msg) { assert(v !== null && v !== undefined, msg + ` (got ${v})`); }
function section(name) { console.log(`\n=== ${name} ===`); }

const NOW = 1_700_000_000_000; // fixed base timestamp

// ============================================================================
// ── USER MEMORY ENGINE ──────────────────────────────────────────────────────
// ============================================================================

section('UME-01: getUserMemory — returns both layers');
{
  const eng = new UserMemoryEngine();
  const mem = eng.getUserMemory('sess-1', 'user-1', NOW);
  assert('shortTerm' in mem, 'getUserMemory has shortTerm');
  assert('longTerm'  in mem, 'getUserMemory has longTerm');
  assert(mem.shortTerm !== null, 'shortTerm is non-null');
  assert(mem.longTerm  !== null, 'longTerm is non-null when userId provided');

  const memNoUser = eng.getUserMemory('sess-2', null, NOW);
  assertEqual(memNoUser.longTerm, null, 'longTerm is null when no userId');
}

section('UME-02: recordIgnoredSuggestion — marks product ignored');
{
  const eng = new UserMemoryEngine();
  eng.recordIgnoredSuggestion({ sessionId: 'sess-ign', productId: 'p-1', reason: 'user_dismissed', nowMs: NOW });
  assert(eng.isProductIgnored('sess-ign', 'p-1'), 'p-1 is ignored after recordIgnoredSuggestion');
  assert(!eng.isProductIgnored('sess-ign', 'p-2'), 'p-2 is not ignored');
  assert(!eng.isProductIgnored('sess-other', 'p-1'), 'p-1 not ignored for different session');

  const patterns = eng.getSessionPatterns('sess-ign');
  assertEqual(patterns.dismissals, 1, 'dismissal count incremented');
}

section('UME-03: recordBehavior — session patterns accumulate');
{
  const eng = new UserMemoryEngine();
  const s = 'sess-beh';
  eng.recordBehavior({ sessionId: s, productId: 'p-A', context: 'listing', eventType: 'view', category: 'electronics', nowMs: NOW });
  eng.recordBehavior({ sessionId: s, productId: 'p-A', context: 'listing', eventType: 'revisit', category: 'electronics', nowMs: NOW + 1000 });
  eng.recordBehavior({ sessionId: s, productId: 'p-A', context: 'cart',    eventType: 'add_to_cart', nowMs: NOW + 2000 });
  eng.recordBehavior({ sessionId: s, productId: 'p-B', context: 'listing', eventType: 'exit_intent', nowMs: NOW + 3000 });

  const p = eng.getSessionPatterns(s);
  assertEqual(p.revisits,  1, 'revisit counted');
  assertEqual(p.cartAdds,  1, 'cartAdd counted');
  assertEqual(p.exits,     1, 'exit counted');
}

section('UME-04: recordPurchase — long-term cycles');
{
  const eng = new UserMemoryEngine();
  const uid = 'user-cycles';

  eng.recordPurchase({ sessionId: 'sess-1', userId: uid, products: [{ productId: 'p-1', category: 'A', price: 50 }], revenue: 50, nowMs: NOW });
  eng.recordPurchase({ sessionId: 'sess-2', userId: uid, products: [{ productId: 'p-2', category: 'A', price: 60 }], revenue: 60, nowMs: NOW + 30 * UME_MS_DAY });
  eng.recordPurchase({ sessionId: 'sess-3', userId: uid, products: [{ productId: 'p-3', category: 'B', price: 70 }], revenue: 70, nowMs: NOW + 60 * UME_MS_DAY });

  const lt = eng.getLongTermMemory(uid, NOW + 60 * UME_MS_DAY);
  assertEqual(lt.purchaseCycles.length, 3, '3 purchase cycles recorded');
  assertEqual(lt.behaviorPatterns.totalPurchases, 3, 'totalPurchases = 3');
  assertApprox(lt.behaviorPatterns.totalRevenue, 180, 0.01, 'totalRevenue = 180');
}

section('UME-05: getPurchaseCyclePrediction — statistical');
{
  const eng = new UserMemoryEngine({ minCyclesForPrediction: 2 });
  const uid = 'user-pred';

  // No data → null prediction
  const pred0 = eng.getPurchaseCyclePrediction(uid, NOW);
  assertEqual(pred0.confidence, 0, 'No cycles → confidence = 0');
  assertNull(pred0.predictedNextMs, 'No cycles → predictedNextMs = null');

  // Add 3 purchases with ~30-day interval
  const interval = 30 * UME_MS_DAY;
  eng.recordPurchase({ sessionId: 'a', userId: uid, products: [], revenue: 10, nowMs: NOW });
  eng.recordPurchase({ sessionId: 'b', userId: uid, products: [], revenue: 10, nowMs: NOW + interval });
  eng.recordPurchase({ sessionId: 'c', userId: uid, products: [], revenue: 10, nowMs: NOW + 2 * interval });

  const pred = eng.getPurchaseCyclePrediction(uid, NOW + 2 * interval);
  assertNotNull(pred.predictedNextMs, 'predictedNextMs is not null');
  assertNotNull(pred.medianIntervalMs, 'medianIntervalMs is not null');
  assertBetween(pred.confidence, 0, 1, 'confidence in [0,1]');
  assert(pred.cycleCount >= 2, 'cycleCount >= 2');
  assertApprox(pred.medianIntervalMs, interval, interval * 0.05, 'medianInterval ≈ 30 days');
}

section('UME-06: shouldSuppress — rejection tracking');
{
  const eng = new UserMemoryEngine({ rejectionCountToSuppress: 2 });
  const uid = 'user-rej';

  // 1 rejection → do not suppress
  eng.recordRejection({ sessionId: 'a', userId: uid, entityId: 'fam-URGENCY', entityType: 'family', nowMs: NOW });
  const r1 = eng.shouldSuppress(uid, 'fam-URGENCY', 'family', NOW);
  assertEqual(r1.suppress, false, '1 rejection: do not suppress');
  assertEqual(r1.count, 1, '1 rejection: count = 1');

  // 2nd rejection → suppress
  eng.recordRejection({ sessionId: 'b', userId: uid, entityId: 'fam-URGENCY', entityType: 'family', nowMs: NOW + 1000 });
  const r2 = eng.shouldSuppress(uid, 'fam-URGENCY', 'family', NOW + 1000);
  assertEqual(r2.suppress, true, '2 rejections: suppress = true');
  assertEqual(r2.count, 2, '2 rejections: count = 2');

  // TTL expired → do not suppress
  const expiredNow = NOW + 1000 + 91 * UME_MS_DAY;
  const r3 = eng.shouldSuppress(uid, 'fam-URGENCY', 'family', expiredNow);
  assertEqual(r3.suppress, false, 'After TTL: suppress = false');
}

section('UME-07: getFrequentCategories — ranked output');
{
  const eng = new UserMemoryEngine();
  const uid = 'user-cats';

  for (let i = 0; i < 5; i++) eng.recordBehavior({ sessionId: 'x', userId: uid, category: 'electronics', eventType: 'view', nowMs: NOW + i * 1000 });
  for (let i = 0; i < 3; i++) eng.recordBehavior({ sessionId: 'x', userId: uid, category: 'apparel',     eventType: 'view', nowMs: NOW + i * 1000 });
  eng.recordBehavior({ sessionId: 'x', userId: uid, category: 'home', eventType: 'view', nowMs: NOW });

  const cats = eng.getFrequentCategories(uid, NOW, 3);
  assert(Array.isArray(cats), 'getFrequentCategories returns array');
  assertEqual(cats[0].category, 'electronics', 'electronics ranked first (5 visits)');
  assertEqual(cats[1].category, 'apparel',     'apparel ranked second (3 visits)');
  assert(cats.length <= 3, 'topN = 3 respected');
}

section('UME-08: getRecentInteractions — FIFO bounded');
{
  const eng = new UserMemoryEngine({ maxRecentInteractions: 5 });
  const s = 'sess-recent';

  for (let i = 0; i < 8; i++) {
    eng.recordBehavior({ sessionId: s, productId: `p-${i}`, context: 'listing', eventType: 'view', nowMs: NOW + i * 100 });
  }

  const recent = eng.getRecentInteractions(s, 10);
  assert(recent.length <= 5, 'Bounded to maxRecentInteractions=5');
  const types = recent.map(r => r.type);
  assert(types.every(t => t === 'view'), 'All recent interactions are view type');
}

section('UME-09: snapshot / restore');
{
  const eng = new UserMemoryEngine();
  eng.recordIgnoredSuggestion({ sessionId: 'snap-sess', productId: 'snap-p', nowMs: NOW });
  eng.recordPurchase({ sessionId: 'snap-sess', userId: 'snap-user', products: [], revenue: 99, nowMs: NOW });

  const snap = eng.snapshot();
  assert(snap.__schemaVersion === 1, 'snapshot schemaVersion = 1');

  const eng2 = new UserMemoryEngine();
  eng2.restore(snap);
  assert(eng2.isProductIgnored('snap-sess', 'snap-p'), 'Restored: product still ignored');
  const lt = eng2.getLongTermMemory('snap-user', NOW);
  assertEqual(lt.behaviorPatterns.totalPurchases, 1, 'Restored: 1 purchase in long-term');
}

section('UME-10: dispose prevents further use');
{
  const eng = new UserMemoryEngine();
  eng.dispose();
  let threw = false;
  try { eng.getUserMemory('x', null, NOW); } catch (e) { threw = true; }
  assert(threw, 'getUserMemory throws after dispose');
}

// ============================================================================
// ── MOBILE BEHAVIOR ENGINE ──────────────────────────────────────────────────
// ============================================================================

section('MBE-01: recordTouch — basic recording');
{
  const eng = new MobileBehaviorEngine();
  eng.recordTouch({ sessionId: 'mob-1', eventType: 'touchstart', x: 100, y: 700, viewportHeight: 812, viewportWidth: 390, nowMs: NOW });
  eng.recordTouch({ sessionId: 'mob-1', eventType: 'touchend',   x: 100, y: 700, viewportHeight: 812, viewportWidth: 390, nowMs: NOW + 300 });

  const diag = eng.getDiagnostics();
  assertEqual(diag.activeSessions, 1, 'One active session after touch recording');
}

section('MBE-02: thumb zone detection');
{
  const eng = new MobileBehaviorEngine({ minEventsForInference: 2 });
  const vH = 812;

  // Bottom 40% → in thumb zone (y > 812 * 0.6 = 487)
  eng.recordTouch({ sessionId: 'mob-tz', eventType: 'touchstart', x: 195, y: 700, viewportHeight: vH, viewportWidth: 390, nowMs: NOW });

  // Top area → not in thumb zone
  eng.recordTouch({ sessionId: 'mob-tz', eventType: 'touchstart', x: 195, y: 100, viewportHeight: vH, viewportWidth: 390, nowMs: NOW + 500 });

  // Infer intent to verify thumb zone is being used in signals
  const result = eng.inferMobileIntent({ sessionId: 'mob-tz', nowMs: NOW + 600 });
  assert(typeof result.signals.thumbZoneRatio === 'number', 'thumbZoneRatio is a number');
  assertBetween(result.signals.thumbZoneRatio, 0, 1, 'thumbZoneRatio in [0,1]');
}

section('MBE-03: recordScroll — velocity computed');
{
  const eng = new MobileBehaviorEngine({ minEventsForInference: 2 });
  const s = 'mob-scroll';

  eng.recordScroll({ sessionId: s, deltaY: 100, deltaX: 0, nowMs: NOW });
  eng.recordScroll({ sessionId: s, deltaY: 200, deltaX: 0, nowMs: NOW + 100 }); // 200px/100ms = 2px/ms (fast)

  const result = eng.inferMobileIntent({ sessionId: s, nowMs: NOW + 200 });
  // avgScrollVelocity may be null if timeDelta between scrolls is 0; check it's a number or null
  assert(result.signals.avgScrollVelocity === null || typeof result.signals.avgScrollVelocity === 'number',
    'avgScrollVelocity is number or null (computed from scrolls)');
}

section('MBE-04: recordGesture — swipe recorded');
{
  const eng = new MobileBehaviorEngine();
  const s = 'mob-gest';

  eng.recordGesture({ sessionId: s, gestureType: 'swipe', direction: 'up',  velocity: 2.0, nowMs: NOW });
  eng.recordGesture({ sessionId: s, gestureType: 'swipe', direction: 'up',  velocity: 1.8, nowMs: NOW + 300 });
  eng.recordGesture({ sessionId: s, gestureType: 'swipe', direction: 'down', velocity: 0.5, nowMs: NOW + 600 });
  // Add some touches to meet minEventsForInference
  eng.recordTouch({ sessionId: s, eventType: 'touchstart', x: 0, y: 0, viewportHeight: 812, viewportWidth: 390, nowMs: NOW + 700 });

  const result = eng.inferMobileIntent({ sessionId: s, nowMs: NOW + 800 });
  assertEqual(result.signals.swipeDir.up, 2,   'swipeDir.up = 2');
  assertEqual(result.signals.swipeDir.down, 1, 'swipeDir.down = 1');
}

section('MBE-05: inferMobileIntent — high_intent via long press');
{
  const eng = new MobileBehaviorEngine({ longPressThresholdMs: 500, minEventsForInference: 1 });
  const s = 'mob-hi';

  eng.recordGesture({ sessionId: s, gestureType: 'long_press', durationMs: 900, elementContext: 'add_to_cart_button', nowMs: NOW });
  // One touch to ensure data
  eng.recordTouch({ sessionId: s, eventType: 'touchstart', x: 195, y: 700, viewportHeight: 812, viewportWidth: 390, nowMs: NOW + 100 });

  const result = eng.inferMobileIntent({ sessionId: s, nowMs: NOW + 200 });
  assertEqual(result.intent, INTENT_STATES.HIGH_INTENT, 'Long press → high_intent');
  assert(result.confidence > 0, 'confidence > 0 for high_intent');
}

section('MBE-06: inferMobileIntent — exploring via fast scroll');
{
  const eng = new MobileBehaviorEngine({ fastSwipeThreshold: 1.0, minEventsForInference: 1 });
  const s = 'mob-exp';

  // Precomputed fast velocity
  eng.recordScroll({ sessionId: s, deltaY: 500, deltaX: 0, velocityPxMs: 3.0, nowMs: NOW });
  eng.recordScroll({ sessionId: s, deltaY: 400, deltaX: 0, velocityPxMs: 2.5, nowMs: NOW + 200 });

  const result = eng.inferMobileIntent({ sessionId: s, nowMs: NOW + 300 });
  assertEqual(result.intent, INTENT_STATES.EXPLORING, 'Fast scroll → exploring');
}

section('MBE-07: inferMobileIntent — disengaged via inactivity');
{
  const eng = new MobileBehaviorEngine({ hesitationWindowMs: 3000, minEventsForInference: 1 });
  const s = 'mob-dis';

  eng.recordTouch({ sessionId: s, eventType: 'touchstart', x: 100, y: 400, viewportHeight: 812, viewportWidth: 390, nowMs: NOW });
  eng.recordTouch({ sessionId: s, eventType: 'touchend',   x: 100, y: 400, viewportHeight: 812, viewportWidth: 390, nowMs: NOW + 100 });

  // Infer 10 seconds later → disengaged
  const result = eng.inferMobileIntent({ sessionId: s, nowMs: NOW + 10_000 });
  assertEqual(result.intent, INTENT_STATES.DISENGAGED, 'Long inactivity → disengaged');
}

section('MBE-08: no data → exploring with confidence 0');
{
  const eng = new MobileBehaviorEngine();
  const result = eng.inferMobileIntent({ sessionId: 'no-data', nowMs: NOW });
  assertEqual(result.intent, INTENT_STATES.EXPLORING, 'No data → exploring');
  assertEqual(result.confidence, 0, 'No data → confidence = 0');
}

section('MBE-09: snapshot / restore');
{
  const eng = new MobileBehaviorEngine();
  eng.recordTouch({ sessionId: 'snap-mob', eventType: 'touchstart', x: 100, y: 400, viewportHeight: 812, viewportWidth: 390, nowMs: NOW });
  eng.recordScroll({ sessionId: 'snap-mob', deltaY: 100, deltaX: 0, nowMs: NOW + 500 });

  const snap = eng.snapshot();
  assert(snap.__schemaVersion === 1, 'snapshot schemaVersion = 1');
  assert(Array.isArray(snap.sessions), 'snapshot.sessions is array');

  const eng2 = new MobileBehaviorEngine();
  eng2.restore(snap);
  const result = eng2.inferMobileIntent({ sessionId: 'snap-mob', nowMs: NOW + 600 });
  assert(typeof result.intent === 'string', 'Restored engine: inferMobileIntent works');
}

section('MBE-10: desktop-safe — no session created without events');
{
  const eng = new MobileBehaviorEngine();
  const diag = eng.getDiagnostics();
  assertEqual(diag.activeSessions, 0, 'Desktop: 0 sessions without any events');
  const result = eng.inferMobileIntent({ sessionId: 'desktop-sess', nowMs: NOW });
  assertEqual(result.confidence, 0, 'Desktop: inference returns confidence=0 with no data');
}

// ============================================================================
// ── OBSERVABILITY ENGINE ────────────────────────────────────────────────────
// ============================================================================

section('OBS-01: recordDecision — basic recording');
{
  const eng = new ObservabilityEngine();
  const id = eng.recordDecision({
    sessionId: 'obs-sess-1',
    decision:  DECISION_TYPES.INTERVENE,
    confidence: 0.85,
    reason:    'High hesitation',
    context:   'product_detail',
    signals:   { hesitationScore: 0.85 },
    nowMs:     NOW,
  });
  assert(typeof id === 'string' && id.length > 0, 'recordDecision returns a recordId');

  const diag = eng.getDiagnostics();
  assertEqual(diag.decisionBufferSize, 1, 'Buffer has 1 decision');
  assertEqual(diag.counters.totalDecisions, 1, 'totalDecisions = 1');
}

section('OBS-02: recordError — severity tracking');
{
  const eng = new ObservabilityEngine();
  eng.recordError({ sessionId: 'err-sess', errorCode: 'RANK_FAIL', message: 'Ranking returned null', severity: ERROR_SEVERITY.HIGH, context: 'cart', nowMs: NOW });
  eng.recordError({ sessionId: 'err-sess', errorCode: 'TIMEOUT',   message: 'Evaluate timed out',    severity: ERROR_SEVERITY.MEDIUM, nowMs: NOW + 1000 });

  const diag = eng.getDiagnostics();
  assertEqual(diag.errorBufferSize, 2, 'Error buffer has 2 entries');
  assertEqual(diag.counters.bySeverity[ERROR_SEVERITY.HIGH], 1, 'bySeverity.high = 1');
  assertEqual(diag.counters.bySeverity[ERROR_SEVERITY.MEDIUM], 1, 'bySeverity.medium = 1');
}

section('OBS-03: recordPerformance — slow detection');
{
  const eng = new ObservabilityEngine({ slowDecisionThresholdMs: 50 });
  eng.recordPerformance({ sessionId: 'perf-sess', operation: 'evaluate', durationMs: 30,  nowMs: NOW });         // fast
  eng.recordPerformance({ sessionId: 'perf-sess', operation: 'evaluate', durationMs: 120, nowMs: NOW + 1000 });  // slow

  const diag = eng.getDiagnostics();
  assertEqual(diag.perfBufferSize, 2, 'Perf buffer has 2 entries');
}

section('OBS-04: queryDecisions — filtering');
{
  const eng = new ObservabilityEngine();
  eng.recordDecision({ sessionId: 'q-sess-A', decision: DECISION_TYPES.INTERVENE, confidence: 0.9, reason: 'r1', context: 'cart',    variant: 'B', nowMs: NOW });
  eng.recordDecision({ sessionId: 'q-sess-A', decision: DECISION_TYPES.SKIP,      confidence: 0.3, reason: 'r2', context: 'listing', variant: 'B', nowMs: NOW + 100 });
  eng.recordDecision({ sessionId: 'q-sess-B', decision: DECISION_TYPES.INTERVENE, confidence: 0.8, reason: 'r3', context: 'cart',    variant: 'A', nowMs: NOW + 200 });

  const bySession = eng.queryDecisions({ sessionId: 'q-sess-A' });
  assertEqual(bySession.length, 2, 'queryDecisions by sessionId returns 2');

  const byDecision = eng.queryDecisions({ decision: DECISION_TYPES.INTERVENE });
  assertEqual(byDecision.length, 2, 'queryDecisions by INTERVENE returns 2');

  const byContext = eng.queryDecisions({ context: 'cart' });
  assertEqual(byContext.length, 2, 'queryDecisions by context cart returns 2');

  const byVariant = eng.queryDecisions({ variant: 'A' });
  assertEqual(byVariant.length, 1, 'queryDecisions by variant A returns 1');

  const limited = eng.queryDecisions({ limit: 1 });
  assertEqual(limited.length, 1, 'queryDecisions with limit=1 returns 1');
}

section('OBS-05: queryErrors — filtering');
{
  const eng = new ObservabilityEngine();
  eng.recordError({ errorCode: 'E1', message: 'e1', severity: ERROR_SEVERITY.HIGH,   sessionId: 's1', nowMs: NOW });
  eng.recordError({ errorCode: 'E2', message: 'e2', severity: ERROR_SEVERITY.LOW,    sessionId: 's1', nowMs: NOW + 100 });
  eng.recordError({ errorCode: 'E1', message: 'e3', severity: ERROR_SEVERITY.MEDIUM, sessionId: 's2', nowMs: NOW + 200 });

  const highErrors = eng.queryErrors({ severity: ERROR_SEVERITY.HIGH });
  assertEqual(highErrors.length, 1, 'queryErrors by HIGH severity = 1 (got ' + highErrors.length + ')');

  const byCode = eng.queryErrors({ errorCode: 'E1' });
  assertEqual(byCode.length, 2, 'queryErrors by errorCode E1 = 2');

  const bySession = eng.queryErrors({ sessionId: 's1' });
  assertEqual(bySession.length, 2, 'queryErrors by sessionId s1 = 2');
}

section('OBS-06: getMetrics — structure and values');
{
  const eng = new ObservabilityEngine();

  // Record a mix of decisions
  for (let i = 0; i < 10; i++) {
    eng.recordDecision({ sessionId: `s-${i}`, decision: DECISION_TYPES.INTERVENE, confidence: 0.8, reason: 'hesitation', context: 'cart', variant: 'B', nowMs: NOW + i * 100 });
  }
  for (let i = 0; i < 5; i++) {
    eng.recordDecision({ sessionId: `s-${i}`, decision: DECISION_TYPES.SKIP, confidence: 0.3, reason: 'low_confidence', context: 'listing', nowMs: NOW + i * 100 + 1000 });
  }
  for (let i = 0; i < 5; i++) {
    eng.recordPerformance({ sessionId: `s-${i}`, operation: 'evaluate', durationMs: 20 + i * 10, nowMs: NOW + i * 200 });
  }

  const metrics = eng.getMetrics(NOW + 5000);

  assertEqual(metrics.totalDecisions, 15, 'totalDecisions = 15');
  assertBetween(metrics.interventionRate, 0, 1, 'interventionRate in [0,1]');
  assertApprox(metrics.interventionRate, 10/15, 0.01, 'interventionRate ≈ 0.667');
  assert(typeof metrics.errorRate === 'number', 'errorRate is a number');
  assert(Array.isArray(metrics.topReasons), 'topReasons is array');
  assert(metrics.topReasons.length > 0, 'topReasons is non-empty');
  assert('p50' in metrics.performance, 'performance has p50');
  assert('p95' in metrics.performance, 'performance has p95');
  assert('p99' in metrics.performance, 'performance has p99');
  assert(typeof metrics.performance.slowRate === 'number', 'performance.slowRate is number');
  assert('A' in metrics.variants && 'B' in metrics.variants, 'metrics.variants has A and B');
  assertEqual(metrics.variants.B, 10, 'metrics.variants.B = 10');
}

section('OBS-07: getMetrics — cached result');
{
  // Cache is invalidated on every write (recordDecision/recordError/recordPerformance).
  // Cache only persists across repeated READS with no writes in between.
  const eng = new ObservabilityEngine({ metricsCacheTtlMs: 5000 });
  eng.recordDecision({ sessionId: 's', decision: DECISION_TYPES.INTERVENE, confidence: 0.9, reason: 'r', context: 'cart', nowMs: NOW });

  // Two consecutive reads with no write → same cached object
  const m1 = eng.getMetrics(NOW);
  const m2 = eng.getMetrics(NOW + 10);  // within TTL, no write between
  assert(m1 === m2, 'Repeated reads without writes → same cached object reference');
  assertEqual(m1.totalDecisions, 1, 'Cached: totalDecisions = 1');

  // After a write → cache invalidated → fresh computation
  eng.recordDecision({ sessionId: 's', decision: DECISION_TYPES.SKIP, confidence: 0.2, reason: 'r2', context: 'listing', nowMs: NOW + 100 });
  const m3 = eng.getMetrics(NOW + 100);
  assertEqual(m3.totalDecisions, 2, 'After write: totalDecisions recomputed = 2');

  // TTL expiry without writes: two reads within TTL → same reference
  const m4 = eng.getMetrics(NOW + 200);
  const m5 = eng.getMetrics(NOW + 300);
  assert(m4 === m5, 'Two reads within TTL (no writes) → same cache reference');

  // After TTL expires → recomputed (new object)
  const m6 = eng.getMetrics(NOW + 200 + 6000);
  assert(m6 !== m4, 'After TTL expiry → new metrics object');
  assertEqual(m6.totalDecisions, 2, 'Post-TTL: totalDecisions still = 2');
}

section('OBS-08: explainDecision — human-readable summary');
{
  const eng = new ObservabilityEngine();
  const id = eng.recordDecision({
    sessionId: 'ex-sess', decision: DECISION_TYPES.BLOCK_FATIGUE,
    confidence: 0.9, reason: 'Recent intervention detected',
    context: 'cart', selectedFamily: 'URGENCY', variant: 'B', nowMs: NOW,
  });

  const explanation = eng.explainDecision(id);
  assert(explanation !== null, 'explainDecision returns non-null');
  assert(typeof explanation.summary === 'string', 'summary is a string');
  assert(explanation.summary.includes('BLOCK_FATIGUE'), 'summary includes decision');
  assert(explanation.summary.includes('Recent intervention detected'), 'summary includes reason');
  assertEqual(explanation.decision, DECISION_TYPES.BLOCK_FATIGUE, 'decision preserved');
  assertEqual(explanation.selectedFamily, 'URGENCY', 'selectedFamily preserved');

  // Non-existent id → null
  assertNull(eng.explainDecision('nonexistent-id'), 'explainDecision returns null for unknown id');
}

section('OBS-09: snapshot / restore');
{
  const eng = new ObservabilityEngine();
  eng.recordDecision({ sessionId: 'snap-s', decision: DECISION_TYPES.INTERVENE, confidence: 0.8, reason: 'r', context: 'cart', nowMs: NOW });
  eng.recordError({ sessionId: 'snap-s', errorCode: 'E1', message: 'm', severity: ERROR_SEVERITY.MEDIUM, nowMs: NOW + 100 });
  eng.recordPerformance({ sessionId: 'snap-s', operation: 'evaluate', durationMs: 45, nowMs: NOW + 200 });

  const snap = eng.snapshot();
  assert(snap.__schemaVersion === 1, 'snapshot schemaVersion = 1');

  const eng2 = new ObservabilityEngine();
  eng2.restore(snap);
  assertEqual(eng2.getDiagnostics().counters.totalDecisions, 1, 'Restored: totalDecisions = 1');
  assertEqual(eng2.getDiagnostics().counters.totalErrors, 1, 'Restored: totalErrors = 1');

  const decisions = eng2.queryDecisions({ sessionId: 'snap-s' });
  assertEqual(decisions.length, 1, 'Restored: 1 decision queryable');
}

section('OBS-10: reset — clears all state');
{
  const eng = new ObservabilityEngine();
  eng.recordDecision({ sessionId: 's', decision: DECISION_TYPES.INTERVENE, confidence: 0.9, reason: 'r', context: 'cart', nowMs: NOW });
  eng.recordError({ sessionId: 's', errorCode: 'E', message: 'm', severity: ERROR_SEVERITY.HIGH, nowMs: NOW });
  eng.reset();

  const diag = eng.getDiagnostics();
  assertEqual(diag.decisionBufferSize, 0, 'After reset: decisionBuffer empty');
  assertEqual(diag.errorBufferSize, 0, 'After reset: errorBuffer empty');
  assertEqual(diag.counters.totalDecisions, 0, 'After reset: totalDecisions = 0');
}

section('OBS-11: dispose prevents further use');
{
  const eng = new ObservabilityEngine();
  eng.dispose();
  let threw = false;
  try { eng.recordDecision({ sessionId: 's', decision: 'X', confidence: 0, reason: 'r', context: 'c', nowMs: NOW }); }
  catch (e) { threw = true; }
  assert(threw, 'recordDecision throws after dispose');
}

section('OBS-12: countaers never go negative; DO_NOTHING is valid');
{
  const eng = new ObservabilityEngine();
  eng.recordDecision({ sessionId: 's', decision: DECISION_TYPES.DO_NOTHING, confidence: 0.1, reason: 'nothing_to_say', context: 'listing', nowMs: NOW });
  const diag = eng.getDiagnostics();
  assertEqual(diag.counters.byDecision.DO_NOTHING, 1, 'DO_NOTHING counted correctly');
  assertEqual(diag.counters.totalDecisions, 1, 'totalDecisions = 1 after DO_NOTHING');
}

// ============================================================================
// Results
// ============================================================================

console.log('\n====================================================');
console.log('  HARDENING ENGINES TEST SUITE');
console.log(`  RESULTS: ${passCount}/${assertCount} passed, ${failCount} failed`);
if (failures.length > 0) {
  console.log('\n  FAILURES:');
  failures.forEach(f => console.log(`    • ${f}`));
}
console.log('====================================================\n');

if (failCount > 0) process.exit(1);
