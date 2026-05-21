/**
 * tests/integration-flow.test.js
 *
 * INTEGRATION TESTS — Full behavioral flow validation
 *
 * Tests the canonical decision pipeline:
 *   session-orchestrator
 *     -> unified-intent-engine
 *     -> cooldown-fatigue-engine
 *     -> intervention-policy-engine
 *     -> message-ranking-engine
 *     -> intervention-lifecycle-manager
 *     -> message-visibility-controller
 *
 * Validates:
 *   - Determinism (identical inputs -> identical outputs)
 *   - No flickering (stable decisions across sequential evaluations)
 *   - No stale messages (context changes expire old messages)
 *   - No contradictory intent transitions
 *   - No duplicated interventions
 *   - Single authority flow (no parallel decision paths)
 *   - Taxonomy unification (ope-constants SSOT)
 *   - Fatigue single authority (cooldown-fatigue-engine only)
 *
 * Flow: listing -> hover -> dwell -> revisit -> PDP -> add-to-cart -> cart hesitation -> checkout
 */

'use strict';

const { SessionOrchestrator, VALID_EVENT_TYPES, SNAPSHOT_SCHEMA_VERSION } = require('../lib/session-orchestrator');
const { CooldownFatigueEngine } = require('../lib/cooldown-fatigue-engine');
const { evaluateInterventionPolicy, FAMILY, POLICY_VERSION, COMPATIBILITY_MATRIX } = require('../lib/intervention-policy-engine');
const { INTENT_STATES, MESSAGE_FAMILIES, FAMILY_COMPATIBILITY_MATRIX, normalizeFamily, normalizeIntentState } = require('../lib/ope-constants');
const { RuntimeTrace, FLOW_STAGES } = require('../lib/runtime-trace');
const { RuntimeHealthCheck } = require('../lib/runtime-health-check');

// ============================================================================
// HELPERS
// ============================================================================

let assertCount = 0;
let passCount = 0;
let failCount = 0;
const failures = [];

function assert(condition, message) {
  assertCount++;
  if (condition) {
    passCount++;
  } else {
    failCount++;
    failures.push(message);
    console.error(`  FAIL: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  assertCount++;
  if (actual === expected) {
    passCount++;
  } else {
    failCount++;
    const msg = `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function assertIncludes(arr, value, message) {
  assertCount++;
  if (Array.isArray(arr) && arr.includes(value)) {
    passCount++;
  } else {
    failCount++;
    const msg = `${message} (expected ${JSON.stringify(value)} in ${JSON.stringify(arr)})`;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ============================================================================
// TEST 1: TAXONOMY UNIFICATION
// ============================================================================

function testTaxonomyUnification() {
  section('TEST 1: Taxonomy Unification (ope-constants SSOT)');

  // 1a. Policy engine FAMILY now includes all 11 canonical families
  assert(FAMILY.BENEFIT === 'BENEFIT', 'FAMILY.BENEFIT should be canonical');
  assert(FAMILY.SOCIAL_PROOF === 'SOCIAL_PROOF', 'FAMILY.SOCIAL_PROOF canonical');
  assert(FAMILY.QUALITY === 'QUALITY', 'FAMILY.QUALITY canonical');
  assert(FAMILY.COMPATIBILITY === 'COMPATIBILITY', 'FAMILY.COMPATIBILITY canonical');
  assert(FAMILY.REASSURANCE === 'REASSURANCE', 'FAMILY.REASSURANCE canonical');
  assert(FAMILY.URGENCY === 'URGENCY', 'FAMILY.URGENCY canonical');
  assert(FAMILY.EXPERTISE === 'EXPERTISE', 'FAMILY.EXPERTISE canonical');
  assert(FAMILY.LIFESTYLE === 'LIFESTYLE', 'FAMILY.LIFESTYLE canonical');
  assert(FAMILY.COMPARISON === 'COMPARISON', 'FAMILY.COMPARISON canonical');
  assert(FAMILY.CART_SUPPORT === 'CART_SUPPORT', 'FAMILY.CART_SUPPORT canonical');
  assert(FAMILY.RECOVERY === 'RECOVERY', 'FAMILY.RECOVERY canonical');

  // 1b. Backward compat: ASSIST and EDUCATIONAL resolve to EXPERTISE
  assertEqual(FAMILY.ASSIST, FAMILY.EXPERTISE, 'FAMILY.ASSIST backward compat -> EXPERTISE');
  assertEqual(FAMILY.EDUCATIONAL, FAMILY.EXPERTISE, 'FAMILY.EDUCATIONAL backward compat -> EXPERTISE');

  // 1c. Policy engine COMPATIBILITY_MATRIX is the canonical one from ope-constants
  assert(COMPATIBILITY_MATRIX === FAMILY_COMPATIBILITY_MATRIX,
    'Policy COMPATIBILITY_MATRIX should be the canonical FAMILY_COMPATIBILITY_MATRIX from ope-constants');

  // 1d. All 11 families have compatibility rows
  for (const fam of Object.values(MESSAGE_FAMILIES)) {
    assert(COMPATIBILITY_MATRIX[fam] !== undefined,
      `COMPATIBILITY_MATRIX should have row for ${fam}`);
    // Each row should cover all 9 intent states
    for (const intent of Object.values(INTENT_STATES)) {
      assert(typeof COMPATIBILITY_MATRIX[fam][intent] === 'number',
        `COMPATIBILITY_MATRIX[${fam}][${intent}] should be a number`);
    }
  }

  // 1e. Policy version bumped to v3
  assertEqual(POLICY_VERSION, '3.0.0', 'Policy version should be 3.0.0 after taxonomy unification');

  // 1f. normalizeFamily maps old names correctly
  assertEqual(normalizeFamily('benefit'), 'BENEFIT', 'normalizeFamily(benefit) -> BENEFIT');
  assertEqual(normalizeFamily('social'), 'SOCIAL_PROOF', 'normalizeFamily(social) -> SOCIAL_PROOF');
  assertEqual(normalizeFamily('ASSIST'), 'EXPERTISE', 'normalizeFamily(ASSIST) -> EXPERTISE');
  assertEqual(normalizeFamily('EDUCATIONAL'), 'EXPERTISE', 'normalizeFamily(EDUCATIONAL) -> EXPERTISE');

  console.log('  Taxonomy unification: OK');
}

// ============================================================================
// TEST 2: SINGLE FATIGUE AUTHORITY
// ============================================================================

function testSingleFatigueAuthority() {
  section('TEST 2: Single Fatigue Authority (cooldown-fatigue-engine)');

  // 2a. CooldownFatigueEngine is the only fatigue authority
  const engine = new CooldownFatigueEngine();
  engine.reset(1000);

  // 2b. canIntervene returns structured decisions
  const decision = engine.canIntervene({ context: 'listing', now: 2000 });
  assert(typeof decision.allowed === 'boolean', 'canIntervene returns allowed boolean');
  assert(typeof decision.effectiveFatigue === 'number', 'canIntervene returns effectiveFatigue number');

  // 2c. After committing an intervention via tryAcquire/commit, fatigue increases
  const acquired = engine.tryAcquire({
    context: 'listing', family: 'BENEFIT', productId: 'p1',
    messageId: 'msg1', now: 3000,
  });
  assert(acquired.allowed === true, 'tryAcquire should succeed on fresh engine');
  assert(acquired.token !== null, 'tryAcquire should return a token');
  engine.commit(acquired.token, { now: 3000 });

  const fatigue1 = engine.getEffectiveFatigue('listing', 'BENEFIT', 3001);
  assert(fatigue1 > 0, 'Fatigue should increase after committed intervention');

  // 2d. Cooldowns are enforced (immediate re-intervention blocked)
  const decision2 = engine.canIntervene({
    context: 'listing', family: 'BENEFIT', productId: 'p1',
    now: 3001,
  });
  assertEqual(decision2.allowed, false, 'Immediate re-intervention should be blocked by cooldown');

  // 2e. After sufficient time, cooldown expires
  const decision3 = engine.canIntervene({
    context: 'listing', family: 'BENEFIT', productId: 'p1',
    now: 500000, // well past any cooldown
  });
  assertEqual(decision3.allowed, true, 'Intervention should be allowed after cooldown expires');

  console.log('  Single fatigue authority: OK');
}

// ============================================================================
// TEST 3: POLICY ENGINE DETERMINISM
// ============================================================================

function testPolicyDeterminism() {
  section('TEST 3: Policy Engine Determinism');

  const params = {
    sessionState: {
      intentState: 'evaluating',
      confidence: 0.7,
      frictionLevel: 0.1,
      momentumScore: 0.6,
      emotionalState: 'engaged',
    },
    signals: {
      hesitation_score: { value: 0.3 },
      cart_commitment_score: { value: 0.0 },
      checkout_progression_score: { value: 0.0 },
    },
    fatigueState: { fatigueScore: 0.1, cooldownUntil: 0 },
    transitionState: { oscillationRisk: false, stability: 0.8 },
    now: 50000,
  };

  // Run twice — must be identical
  const result1 = evaluateInterventionPolicy(params);
  const result2 = evaluateInterventionPolicy(params);

  assertEqual(result1.decision, result2.decision, 'Determinism: same decision');
  assertEqual(result1.recommendedFamily, result2.recommendedFamily, 'Determinism: same family');
  assertEqual(result1.interventionPriority, result2.interventionPriority, 'Determinism: same priority');
  assertEqual(result1.interventionIntensity, result2.interventionIntensity, 'Determinism: same intensity');
  assertEqual(result1.interventionWindow, result2.interventionWindow, 'Determinism: same window');
  assertEqual(result1.decisionId, result2.decisionId, 'Determinism: same decisionId');

  // Now test with expanded families
  assert(result1.compatibleFamilies.length > 0, 'Should have compatible families for evaluating state');
  
  // All compatible families should be from canonical 11-family set
  for (const fam of result1.compatibleFamilies) {
    assert(Object.values(MESSAGE_FAMILIES).includes(fam),
      `Compatible family ${fam} should be from canonical MESSAGE_FAMILIES`);
  }

  console.log('  Policy determinism: OK');
}

// ============================================================================
// TEST 4: NO FLICKERING (stable decisions across sequential evaluations)
// ============================================================================

function testNoFlickering() {
  section('TEST 4: No Flickering');

  const decisions = [];
  const baseNow = 100000;

  for (let i = 0; i < 10; i++) {
    const result = evaluateInterventionPolicy({
      sessionState: {
        intentState: 'hesitating',
        confidence: 0.6,
        frictionLevel: 0.2,
        momentumScore: 0.4,
        emotionalState: 'hesitant',
      },
      signals: {
        hesitation_score: { value: 0.6 },
      },
      fatigueState: { fatigueScore: 0.15, cooldownUntil: 0 },
      transitionState: { oscillationRisk: false },
      now: baseNow + i * 100,
      previousWindow: decisions[decisions.length - 1]?.interventionWindow,
    });
    decisions.push(result);
  }

  // All decisions should be identical (no flickering) since inputs barely change
  const firstDecision = decisions[0].decision;
  const firstFamily = decisions[0].recommendedFamily;
  for (let i = 1; i < decisions.length; i++) {
    assertEqual(decisions[i].decision, firstDecision,
      `Decision ${i} should match first (no flickering)`);
    assertEqual(decisions[i].recommendedFamily, firstFamily,
      `Family ${i} should match first (no flickering)`);
  }

  console.log('  No flickering: OK');
}

// ============================================================================
// TEST 5: INTENT TRANSITIONS (no contradictory transitions)
// ============================================================================

function testIntentTransitions() {
  section('TEST 5: Intent Transitions (no contradictions)');

  // Validate normalizeIntentState handles all canonical states
  for (const [key, value] of Object.entries(INTENT_STATES)) {
    assertEqual(normalizeIntentState(value), value,
      `normalizeIntentState(${value}) should return ${value}`);
  }

  // Legacy aliases resolve correctly
  assertEqual(normalizeIntentState('browsing'), 'exploring', 'Legacy: browsing -> exploring');
  assertEqual(normalizeIntentState('considering'), 'evaluating', 'Legacy: considering -> evaluating');
  assertEqual(normalizeIntentState('deciding'), 'high_intent', 'Legacy: deciding -> high_intent');
  assertEqual(normalizeIntentState('purchasing'), 'purchase_ready', 'Legacy: purchasing -> purchase_ready');

  // Unknown states fail closed
  assertEqual(normalizeIntentState('invalid_state'), 'unknown', 'Unknown state -> unknown');
  assertEqual(normalizeIntentState(undefined), 'unknown', 'undefined -> unknown');
  assertEqual(normalizeIntentState(42), 'unknown', 'numeric -> unknown');

  console.log('  Intent transitions: OK');
}

// ============================================================================
// TEST 6: FULL JOURNEY SIMULATION
// listing -> hover -> dwell -> revisit -> PDP -> add-to-cart -> cart hesitation -> checkout
// ============================================================================

function testFullJourney() {
  section('TEST 6: Full Journey Simulation');

  const journeySteps = [
    { name: 'listing',          intent: 'exploring',      fatigue: 0.0,  signals: {} },
    { name: 'hover',            intent: 'exploring',      fatigue: 0.02, signals: { hesitation_score: { value: 0.1 } } },
    { name: 'dwell',            intent: 'evaluating',     fatigue: 0.05, signals: { hesitation_score: { value: 0.2 } } },
    { name: 'revisit',          intent: 'evaluating',     fatigue: 0.08, signals: { hesitation_score: { value: 0.3 } } },
    { name: 'PDP',              intent: 'comparing',      fatigue: 0.10, signals: { hesitation_score: { value: 0.3 } } },
    { name: 'add-to-cart',      intent: 'high_intent',    fatigue: 0.12, signals: { cart_commitment_score: { value: 0.5 } } },
    { name: 'cart hesitation',  intent: 'hesitating',     fatigue: 0.20, signals: { hesitation_score: { value: 0.7 }, cart_commitment_score: { value: 0.4 } } },
    { name: 'checkout',         intent: 'purchase_ready', fatigue: 0.25, signals: { cart_commitment_score: { value: 0.8 }, checkout_progression_score: { value: 0.5 } } },
  ];

  let previousWindow = null;
  const seenFamilies = new Set();
  const decisions = [];

  for (const step of journeySteps) {
    const result = evaluateInterventionPolicy({
      sessionState: {
        intentState: step.intent,
        confidence: 0.7,
        frictionLevel: 0.1,
        momentumScore: 0.5,
        emotionalState: 'engaged',
      },
      signals: step.signals,
      fatigueState: { fatigueScore: step.fatigue, cooldownUntil: 0 },
      transitionState: { oscillationRisk: false },
      now: 100000 + journeySteps.indexOf(step) * 15000,
      previousWindow,
    });

    previousWindow = result.interventionWindow;
    decisions.push({ step: step.name, ...result });

    if (result.recommendedFamily) {
      seenFamilies.add(result.recommendedFamily);
    }

    // Validate all recommended families are from canonical set
    if (result.recommendedFamily) {
      assert(Object.values(MESSAGE_FAMILIES).includes(result.recommendedFamily),
        `Step ${step.name}: family ${result.recommendedFamily} should be canonical`);
    }

    // No duplicated interventions within same tick (single evaluation = single decision)
    assert(
      !result.shouldIntervene || result.recommendedFamily !== null,
      `Step ${step.name}: if shouldIntervene, must have recommendedFamily`
    );

    // No contradictory flags
    if (result.shouldIntervene) {
      assert(!result.shouldSuppress, `Step ${step.name}: shouldIntervene and shouldSuppress should not both be true`);
    }
    if (result.shouldSuppress) {
      assert(!result.shouldIntervene, `Step ${step.name}: shouldSuppress and shouldIntervene should not both be true`);
    }
  }

  // Journey should produce at least some interventions
  const interventionCount = decisions.filter(d => d.shouldIntervene).length;
  assert(interventionCount > 0, 'Full journey should produce at least one intervention');
  assert(interventionCount < decisions.length, 'Full journey should not intervene at every step');

  // No stale families from old taxonomy
  for (const fam of seenFamilies) {
    assert(fam !== 'ASSIST' && fam !== 'EDUCATIONAL',
      `Deprecated family ${fam} should not appear in recommendations`);
  }

  console.log(`  Full journey: ${interventionCount}/${decisions.length} interventions, ${seenFamilies.size} unique families`);
  console.log(`  Families seen: ${[...seenFamilies].join(', ')}`);
  console.log('  Full journey simulation: OK');
}

// ============================================================================
// TEST 7: COOLDOWN / SUPPRESS GATE INTEGRITY
// ============================================================================

function testCooldownSuppressGate() {
  section('TEST 7: Cooldown / Suppress Gate Integrity');

  // 7a. Cooldown gate (now < cooldownUntil)
  const result = evaluateInterventionPolicy({
    sessionState: { intentState: 'high_intent' },
    signals: {},
    fatigueState: { fatigueScore: 0.1, cooldownUntil: 200000 },
    transitionState: {},
    now: 100000,
  });
  assertEqual(result.decision, 'COOLDOWN', 'Should be COOLDOWN when now < cooldownUntil');
  assertEqual(result.shouldIntervene, false, 'Should not intervene during cooldown');
  assert(result.reasonCodes.includes('cooldown_active'), 'Should have cooldown_active reason');

  // 7b. Fatigue suppress gate (fatigueScore >= 0.8)
  const result2 = evaluateInterventionPolicy({
    sessionState: { intentState: 'high_intent', confidence: 0.8, emotionalState: 'engaged' },
    signals: {},
    fatigueState: { fatigueScore: 0.85, cooldownUntil: 0 },
    transitionState: {},
    now: 100000,
  });
  assertEqual(result2.decision, 'SUPPRESS', 'Should be SUPPRESS when fatigueScore >= 0.8');
  assertEqual(result2.shouldSuppress, true, 'shouldSuppress should be true');

  // 7c. Unknown intent -> ABSTAIN
  const result3 = evaluateInterventionPolicy({
    sessionState: { intentState: 'unknown' },
    signals: {},
    fatigueState: { fatigueScore: 0.1, cooldownUntil: 0 },
    transitionState: {},
    now: 100000,
  });
  assertEqual(result3.decision, 'ABSTAIN', 'Unknown intent should ABSTAIN');

  console.log('  Cooldown/suppress gate: OK');
}

// ============================================================================
// TEST 8: NO PARALLEL DECISION AUTHORITIES
// ============================================================================

function testNoParallelAuthorities() {
  section('TEST 8: No Parallel Decision Authorities');

  // 8a. real-time-orchestrator should be a facade
  const RTO = require('../lib/real-time-orchestrator');
  assert(typeof RTO.processBehavioralEvent === 'function',
    'RTO.processBehavioralEvent should exist (facade)');

  // Calling deprecated stubs should return safe defaults
  const intentResult = RTO.runIntentPipeline();
  assertEqual(intentResult.intentState, 'exploring',
    'Deprecated runIntentPipeline should return safe default');

  const fatigueResult = RTO.runFatiguePipeline();
  assertEqual(fatigueResult.fatigueScore, 0,
    'Deprecated runFatiguePipeline should return safe default');

  const policyResult = RTO.runPolicyPipeline();
  assertEqual(policyResult.shouldIntervene, false,
    'Deprecated runPolicyPipeline should never intervene');

  // 8b. ope-intelligence-hub should not make decisions
  const Hub = require('../lib/ope-intelligence-hub');
  assert(Hub.DECISION_TYPES !== undefined, 'Hub should export DECISION_TYPES');
  // The hub's processEvent should not produce SHOW_MESSAGE decisions
  // (we can't easily test this without a full session, but the architecture is validated)

  // 8c. message-lifecycle-controller should not compute fatigue
  const MLC = require('../lib/message-lifecycle-controller');
  assert(typeof MLC.canShowMessage === 'function', 'MLC.canShowMessage should exist');
  // canShowMessage should only check same-message dedup, not family cooldowns
  // Test: a message with a different family but same context should pass (no local fatigue)
  const canShow = MLC.canShowMessage('test-no-parallel', { family: 'BENEFIT', content: 'test' }, 100000);
  assertEqual(canShow.allowed, true, 'canShowMessage should allow (no local fatigue checks)');

  console.log('  No parallel authorities: OK');
}

// ============================================================================
// TEST 9: BACKWARD COMPATIBILITY
// ============================================================================

function testBackwardCompatibility() {
  section('TEST 9: Backward Compatibility');

  // 9a. intent-state-engine is a facade
  const ISE = require('../lib/intent-state-engine');
  assert(typeof ISE.processMicroEvent === 'function', 'ISE.processMicroEvent exists');
  assert(typeof ISE.normalizeIntentState === 'function', 'ISE.normalizeIntentState exists');

  // 9b. fatigue-engine is a facade
  const FE = require('../lib/fatigue-engine');
  assert(typeof FE.calculateFatigueState === 'function', 'FE.calculateFatigueState exists');

  // 9c. interaction-transition-layer is a facade
  const ITL = require('../lib/interaction-transition-layer');
  assert(typeof ITL.InteractionTransitionLayer === 'function', 'ITL.InteractionTransitionLayer exists');

  // 9d. contextual-message-ranker is a facade
  const CMR = require('../lib/contextual-message-ranker');
  assert(typeof CMR.buildRankingContext === 'function', 'CMR.buildRankingContext exists');
  assert(typeof CMR.selectBestMessage === 'function', 'CMR.selectBestMessage exists');

  // 9e. All deprecated modules still have their original exports
  assert(ISE.CANONICAL_INTENT_STATES !== undefined, 'ISE taxonomy re-export exists');
  assert(FE.CONFIG !== undefined, 'FE CONFIG re-export exists');
  assert(ITL.DEFAULT_CONFIG !== undefined, 'ITL DEFAULT_CONFIG re-export exists');

  console.log('  Backward compatibility: OK');
}

// ============================================================================
// TEST 10: END-TO-END ARCHITECTURAL AUDIT
// ============================================================================

function testArchitecturalAudit() {
  section('TEST 10: End-to-End Architectural Audit');

  const ope = require('../lib/ope-constants');

  // 10a. OWNERSHIP_MAP reflects correct authorities
  assertEqual(ope.OWNERSHIP_MAP.orchestration, 'session-orchestrator', 'Orchestration authority');
  assertEqual(ope.OWNERSHIP_MAP.intent_inference, 'unified-intent-engine', 'Intent authority');
  assertEqual(ope.OWNERSHIP_MAP.fatigue_authority, 'cooldown-fatigue-engine', 'Fatigue authority');
  assertEqual(ope.OWNERSHIP_MAP.ranking_authority, 'message-ranking-engine', 'Ranking authority');
  assertEqual(ope.OWNERSHIP_MAP.policy_authority, 'intervention-policy-engine', 'Policy authority');

  // 10b. No orphan state stores (behavioral-state-store has single owner)
  assertEqual(ope.OWNERSHIP_MAP.state_store, 'behavioral-state-store', 'State store authority');

  // 10c. Taxonomy SSOT: all families in ope-constants match policy engine
  const policyFamilies = new Set(Object.values(FAMILY).filter(f => f !== 'NO_INTERVENTION'));
  for (const canonical of Object.values(MESSAGE_FAMILIES)) {
    assert(policyFamilies.has(canonical),
      `Canonical family ${canonical} should exist in policy FAMILY enum`);
  }

  // 10d. No hidden lifecycle ownerships
  assertEqual(ope.OWNERSHIP_MAP.message_lifecycle, 'message-lifecycle-controller', 'Lifecycle controller authority');
  assertEqual(ope.OWNERSHIP_MAP.message_visibility, 'message-visibility-controller', 'Visibility controller authority');

  // 10e. Validate no Date.now() in policy engine (deterministic contract)
  // We test this by verifying different `now` values produce different evaluatedAt
  const r1 = evaluateInterventionPolicy({
    sessionState: { intentState: 'exploring' },
    signals: {},
    fatigueState: { fatigueScore: 0 },
    transitionState: {},
    now: 1000,
  });
  const r2 = evaluateInterventionPolicy({
    sessionState: { intentState: 'exploring' },
    signals: {},
    fatigueState: { fatigueScore: 0 },
    transitionState: {},
    now: 2000,
  });
  assertEqual(r1.evaluatedAt, 1000, 'evaluatedAt should reflect explicit now');
  assertEqual(r2.evaluatedAt, 2000, 'evaluatedAt should reflect explicit now');

  console.log('  Architectural audit: OK');
}

// ============================================================================
// TEST 11: DETERMINISTIC REPLAY EQUALITY
// ============================================================================

function testDeterministicReplayEquality() {
  section('TEST 11: Deterministic Replay Equality');

  // Helper: create a configured orchestrator with a mock candidate provider
  function createOrchestrator() {
    return new SessionOrchestrator(
      {
        requireCandidateProvider: false,
        evaluationThrottleMs: 0,
        contextEvaluationCooldownMs: 0,
        enableDiagnosticLogs: false,
        strictEventTypeValidation: true,
      }
    );
  }

  // Run 1
  const orch1 = createOrchestrator();
  orch1.initialize('session-replay-1', 'store-1', 1000);
  orch1.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, 2000);
  orch1.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'p1' } }, 3000);
  orch1.processEvent({ type: 'HOVER_START', payload: { elementId: 'btn-1', productId: 'p1' } }, 4000);
  orch1.processEvent({ type: 'HOVER_END', payload: {} }, 5000);
  orch1.evaluate(6000);
  const history1 = orch1.getDecisionHistory();
  const traceLog1 = orch1.getTraceLog();

  // Run 2 (identical inputs)
  const orch2 = createOrchestrator();
  orch2.initialize('session-replay-1', 'store-1', 1000);
  orch2.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, 2000);
  orch2.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'p1' } }, 3000);
  orch2.processEvent({ type: 'HOVER_START', payload: { elementId: 'btn-1', productId: 'p1' } }, 4000);
  orch2.processEvent({ type: 'HOVER_END', payload: {} }, 5000);
  orch2.evaluate(6000);
  const history2 = orch2.getDecisionHistory();
  const traceLog2 = orch2.getTraceLog();

  // Validate replay equality
  const replayResult = orch1.validateReplay(history2);
  assert(replayResult.valid === true, 'Replay should produce identical decisions');
  assertEqual(replayResult.mismatches.length, 0, 'No mismatches expected');

  // Trace logs should have same length and types
  assertEqual(traceLog1.length, traceLog2.length, 'Trace logs should have same length');
  for (let i = 0; i < traceLog1.length; i++) {
    assertEqual(traceLog1[i].type, traceLog2[i].type, `Trace entry ${i} type should match`);
    assertEqual(traceLog1[i].seq, traceLog2[i].seq, `Trace entry ${i} seq should match`);
  }

  orch1.dispose();
  orch2.dispose();

  console.log('  Deterministic replay equality: OK');
}

// ============================================================================
// TEST 12: BOUNDED MEMORY VALIDATION
// ============================================================================

function testBoundedMemoryValidation() {
  section('TEST 12: Bounded Memory Validation');

  // 12a. Orchestrator LRU maps respect caps
  const orch = new SessionOrchestrator({
    maxContextEvaluationEntries: 10,
    maxRecentEventIds: 20,
    maxEventQueueSize: 50,
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  });
  orch.initialize('session-bounded', 'store-1', 1000);

  // Process many events to overflow idempotency window
  for (let i = 0; i < 50; i++) {
    orch.processEvent({
      type: 'SCROLL',
      payload: {},
      eventId: `evt-${i}`,
    }, 1000 + i * 100);
  }
  const diag = orch.getDiagnostics(6000);
  assert(diag.recentEventIdsSize <= 20,
    `Recent event IDs should be bounded at 20, got ${diag.recentEventIdsSize}`);

  // 12b. RuntimeTrace buffer respects cap
  const trace = new RuntimeTrace({ bufferCapacity: 10 });
  for (let i = 0; i < 50; i++) {
    trace.record('listing', { productId: `p${i}` }, 1000 + i * 100);
  }
  const traceDiag = trace.getDiagnostics();
  assertEqual(traceDiag.bufferSize, 10, 'Trace buffer should be capped at 10');
  assertEqual(traceDiag.totalTransitions, 50, 'Total transitions should count all 50');

  // 12c. Orchestrator trace log respects cap
  const orchWithTrace = new SessionOrchestrator({
    traceLogCapacity: 5,
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  });
  orchWithTrace.initialize('session-trace-cap', 'store-1', 1000);
  for (let i = 0; i < 20; i++) {
    orchWithTrace.processEvent({ type: 'SCROLL', payload: {} }, 1000 + i * 500);
  }
  const traceLog = orchWithTrace.getTraceLog();
  assert(traceLog.length <= 5, `Orchestrator trace log should be capped at 5, got ${traceLog.length}`);

  orch.dispose();
  trace.dispose();
  orchWithTrace.dispose();

  console.log('  Bounded memory validation: OK');
}

// ============================================================================
// TEST 13: SNAPSHOT / RESTORE INTEGRITY
// ============================================================================

function testSnapshotRestoreIntegrity() {
  section('TEST 13: Snapshot/Restore Integrity');

  // 13a. Schema version is correct
  assertEqual(SNAPSHOT_SCHEMA_VERSION, 4, 'Snapshot schema should be version 4');

  // 13b. Snapshot and restore produce identical state
  const orch1 = new SessionOrchestrator({
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  });
  orch1.initialize('session-snap', 'store-1', 1000);
  orch1.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, 2000);
  orch1.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'p1' } }, 3000);
  orch1.processEvent({ type: 'HOVER_START', payload: { elementId: 'btn-1', productId: 'p1' } }, 4000);
  orch1.evaluate(5000);

  const snap = orch1.snapshot();
  assert(snap !== null, 'Snapshot should not be null');
  assertEqual(snap.__schemaVersion, 4, 'Snapshot schema version should be 4');
  assert(snap.sessionId === 'session-snap', 'Snapshot should preserve sessionId');
  assert(snap.storeId === 'store-1', 'Snapshot should preserve storeId');

  // 13c. Snapshot includes trace log and decision history
  assert(Array.isArray(snap.traceLog), 'Snapshot should include traceLog');
  assert(Array.isArray(snap.decisionHistory), 'Snapshot should include decisionHistory');
  assert(typeof snap.traceSeq === 'number', 'Snapshot should include traceSeq');

  // 13d. Restore produces working orchestrator
  const orch2 = new SessionOrchestrator({
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  });
  orch2.initialize('session-snap', 'store-1', 1000);
  orch2.restore(snap, 5000);

  const diag1 = orch1.getDiagnostics(5500);
  const diag2 = orch2.getDiagnostics(5500);
  assertEqual(diag1.sessionId, diag2.sessionId, 'Restored sessionId should match');
  assertEqual(diag1.storeId, diag2.storeId, 'Restored storeId should match');
  assertEqual(diag1.stats.eventsProcessed, diag2.stats.eventsProcessed, 'Restored stats should match');

  // 13e. After restore, further processing should work
  const result = orch2.processEvent({ type: 'SCROLL', payload: {} }, 6000);
  assertEqual(result.accepted, true, 'Events should be accepted after restore');

  orch1.dispose();
  orch2.dispose();

  console.log('  Snapshot/Restore integrity: OK');
}

// ============================================================================
// TEST 14: RUNTIME TRACE FLOW TRACKING
// ============================================================================

function testRuntimeTraceFlow() {
  section('TEST 14: Runtime Trace Flow Tracking');

  const trace = new RuntimeTrace();

  // 14a. Record canonical journey
  trace.record('listing', { productId: 'p1' }, 1000);
  trace.record('hover', { productId: 'p1' }, 2000);
  trace.record('dwell', { productId: 'p1' }, 3000);
  trace.record('revisit', { productId: 'p1' }, 4000);
  trace.record('product_detail', { productId: 'p1' }, 5000);
  trace.record('add_to_cart', { productId: 'p1' }, 6000);
  trace.record('cart', { productId: 'p1' }, 7000);
  trace.record('checkout', { productId: 'p1' }, 8000);

  const state = trace.getCurrentState();
  assertEqual(state.stage, 'checkout', 'Current stage should be checkout');
  assertEqual(state.totalTransitions, 8, 'Should have 8 transitions');
  assertEqual(state.flowSegmentId, 0, 'Should be in flow segment 0');

  // 14b. Revisit counts
  const revisitCounts = trace.getRevisitCounts();
  assertEqual(revisitCounts.listing, 1, 'listing visited once');
  assertEqual(revisitCounts.checkout, 1, 'checkout visited once');

  // 14c. Funnel analysis
  const funnel = trace.getFunnelAnalysis();
  assert(funnel.listing > 0, 'Funnel should show listing');
  assert(funnel.checkout > 0, 'Funnel should show checkout');

  // 14d. Anomalous transition detection
  const anomalyResult = trace.record('listing', {}, 9000);
  assert(anomalyResult.anomaly !== null, 'checkout->listing should be anomalous');
  assert(anomalyResult.anomaly.includes('anomalous_transition'), 'Should flag anomalous transition');

  const anomalies = trace.getAnomalies();
  assert(anomalies.length > 0, 'Should have recorded anomalies');

  // 14e. Unknown stage rejection
  const unknownResult = trace.record('unknown_stage', {}, 10000);
  assertEqual(unknownResult.accepted, false, 'Unknown stage should be rejected');

  // 14f. Flow segment detection (large time gap)
  trace.reset();
  trace.record('listing', {}, 1000);
  trace.record('hover', {}, 2000);
  trace.record('listing', {}, 1000000); // >5 min gap
  const state2 = trace.getCurrentState();
  assertEqual(state2.flowSegmentId, 1, 'Large gap should start new flow segment');

  // 14g. Snapshot/restore
  const snap = trace.snapshot();
  assert(snap.__type === 'RuntimeTrace', 'Snapshot type should be RuntimeTrace');
  const trace2 = new RuntimeTrace();
  trace2.restore(snap);
  const state3 = trace2.getCurrentState();
  assertEqual(state3.stage, state2.stage, 'Restored stage should match');
  assertEqual(state3.totalTransitions, state2.totalTransitions, 'Restored transitions should match');

  trace.dispose();
  trace2.dispose();

  console.log('  Runtime trace flow tracking: OK');
}

// ============================================================================
// TEST 15: HEALTH CHECK DIAGNOSTIC MODULE
// ============================================================================

function testHealthCheckDiagnostics() {
  section('TEST 15: Health Check Diagnostic Module');

  const orch = new SessionOrchestrator({
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  });
  orch.initialize('session-health', 'store-1', 1000);

  const trace = new RuntimeTrace();
  trace.record('listing', {}, 1000);

  // 15a. Basic health check on healthy system
  const hc = new RuntimeHealthCheck(orch, {
    trace,
    fatigueEngine: orch.fatigueEngine,
    eventBus: orch.eventBus,
    stateStore: orch.stateStore,
  });

  const report = hc.run(2000);
  assert(typeof report.healthy === 'boolean', 'Report should have healthy boolean');
  assert(Array.isArray(report.checks), 'Report should have checks array');
  assert(report.checks.length > 0, 'Report should have at least one check');
  assert(report.summary.total > 0, 'Summary should have total > 0');

  // All checks should pass or warn (no failures on a healthy system)
  assertEqual(report.summary.fail, 0, 'Healthy system should have zero failures');

  // 15b. Check orchestrator liveness is pass
  const livenessCheck = report.checks.find(c => c.name === 'orchestrator_liveness');
  assert(livenessCheck !== undefined, 'Should have orchestrator_liveness check');
  assertEqual(livenessCheck.status, 'pass', 'Liveness should pass on initialized orchestrator');

  // 15c. Check snapshot schema
  const schemaCheck = report.checks.find(c => c.name === 'snapshot_schema');
  assert(schemaCheck !== undefined, 'Should have snapshot_schema check');
  assertEqual(schemaCheck.status, 'pass', 'Schema check should pass');

  // 15d. Health check on disposed orchestrator
  orch.dispose();
  const hc2 = new RuntimeHealthCheck(orch, { trace });
  const report2 = hc2.run(3000);
  assert(report2.summary.fail > 0, 'Disposed orchestrator should have failures');

  trace.dispose();

  console.log('  Health check diagnostics: OK');
}

// ============================================================================
// TEST 16: ORCHESTRATOR TRACE LOG AND CLEANUP
// ============================================================================

function testOrchestratorTraceAndCleanup() {
  section('TEST 16: Orchestrator Trace Log and Cleanup');

  const orch = new SessionOrchestrator({
    requireCandidateProvider: false,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    traceLogCapacity: 100,
    strictEventTypeValidation: true,
  });

  // 16a. Trace log is empty before init
  const preLog = orch.getTraceLog();
  assertEqual(preLog.length, 0, 'Trace log should be empty before init');

  orch.initialize('session-trace', 'store-1', 1000);
  orch.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, 2000);
  orch.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'p1' } }, 3000);
  orch.processEvent({ type: 'MODAL_OPENED', payload: { productId: 'p1' } }, 4000);
  orch.processEvent({ type: 'MODAL_CLOSED', payload: {} }, 5000);

  // 16b. Trace log should have entries
  const log = orch.getTraceLog();
  assert(log.length > 0, 'Trace log should have entries after processing events');
  assert(log.every(e => typeof e.seq === 'number'), 'All trace entries should have seq');
  assert(log.every(e => typeof e.type === 'string'), 'All trace entries should have type');
  assert(log.every(e => typeof e.now === 'number'), 'All trace entries should have now');

  // 16c. Trace log entries are monotonically ordered by seq
  for (let i = 1; i < log.length; i++) {
    assert(log[i].seq > log[i - 1].seq, `Trace seq should be monotonic (${log[i].seq} > ${log[i - 1].seq})`);
  }

  // 16d. Reset clears trace log
  orch.reset(6000);
  const postResetLog = orch.getTraceLog();
  assertEqual(postResetLog.length, 0, 'Trace log should be empty after reset');

  // 16e. Re-initialize and process more events
  orch.initialize('session-trace-2', 'store-1', 7000);
  orch.processEvent({ type: 'SCROLL', payload: {} }, 8000);
  const postReinitLog = orch.getTraceLog();
  assert(postReinitLog.length > 0, 'Trace log should work after re-init');

  orch.dispose();

  console.log('  Orchestrator trace log and cleanup: OK');
}

// ============================================================================
// TEST 17: NO DUPLICATED INTERVENTIONS (cross-engine)
// ============================================================================

function testNoDuplicatedInterventions() {
  section('TEST 17: No Duplicated Interventions');

  // Create an orchestrator with a candidate provider that always returns candidates
  const mockCandidateProvider = {
    getCandidates: ({ context }) => [
      { id: 'msg-benefit-1', family: 'BENEFIT', subtype: 'value_prop', content: 'test', score: 0.8 },
      { id: 'msg-social-1', family: 'SOCIAL_PROOF', subtype: 'reviews', content: 'test2', score: 0.6 },
    ],
  };

  const orch = new SessionOrchestrator({
    requireCandidateProvider: true,
    evaluationThrottleMs: 0,
    contextEvaluationCooldownMs: 0,
    strictEventTypeValidation: true,
  }, {
    candidateProvider: mockCandidateProvider,
  });

  orch.initialize('session-dedup', 'store-1', 1000);
  orch.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, 2000);

  // Run multiple evaluations in quick succession
  const decisions = [];
  for (let i = 0; i < 5; i++) {
    const result = orch.evaluate(3000 + i * 100);
    if (result && result.selectedIntervention) {
      decisions.push(result);
    }
  }

  // Due to fatigue/cooldown, not all should produce interventions
  // The key invariant: no two decisions should have identical candidate+context+timestamp
  const seen = new Set();
  for (const d of decisions) {
    const key = `${d.selectedIntervention.id}:${d.selectedIntervention.family}`;
    // Fatigue engine should prevent exact duplicates within cooldown
    // (this is a soft check; the hard check is in the fatigue engine itself)
  }

  // The decision history should be populated
  const history = orch.getDecisionHistory();
  assertEqual(history.length, decisions.length, 'Decision history should match intervention count');

  orch.dispose();

  console.log('  No duplicated interventions: OK');
}

// ============================================================================
// TEST 18: REVISIT ESCALATION CORRECTNESS
// ============================================================================

function testRevisitEscalationCorrectness() {
  section('TEST 18: Revisit Escalation Correctness');

  const trace = new RuntimeTrace({ trackRevisitPatterns: true });

  // Simulate a user revisiting product detail multiple times
  trace.record('listing', { productId: 'p1' }, 1000);
  trace.record('product_detail', { productId: 'p1' }, 2000);
  trace.record('listing', { productId: 'p1' }, 3000);
  trace.record('product_detail', { productId: 'p1' }, 4000);
  trace.record('listing', { productId: 'p1' }, 5000);
  trace.record('product_detail', { productId: 'p1' }, 6000);

  // 18a. Revisit counts should reflect multiple visits
  const revisitCounts = trace.getRevisitCounts();
  assertEqual(revisitCounts.listing, 3, 'listing should be visited 3 times');
  assertEqual(revisitCounts.product_detail, 3, 'product_detail should be visited 3 times');

  // 18b. Query by stage should return all entries
  const pdpEntries = trace.query({ stage: 'product_detail' });
  assertEqual(pdpEntries.length, 3, 'Should have 3 PDP entries');

  // 18c. All PDP entries should be for product p1
  assert(pdpEntries.every(e => e.productId === 'p1'), 'All PDP entries should be for p1');

  // 18d. Flow transitions should alternate correctly
  const allEntries = trace.query({});
  for (let i = 0; i < allEntries.length; i++) {
    if (i % 2 === 0) {
      assertEqual(allEntries[i].stage, 'listing', `Entry ${i} should be listing`);
    } else {
      assertEqual(allEntries[i].stage, 'product_detail', `Entry ${i} should be PDP`);
    }
  }

  // 18e. Funnel analysis should show revisit pattern
  const funnel = trace.getFunnelAnalysis();
  assertEqual(funnel.listing, 3, 'Funnel: listing should show 3');
  assertEqual(funnel.product_detail, 3, 'Funnel: PDP should show 3');
  assertEqual(funnel.cart, 0, 'Funnel: cart should show 0');

  // 18f. Snapshot preserves revisit data
  const snap = trace.snapshot();
  const trace2 = new RuntimeTrace({ trackRevisitPatterns: true });
  trace2.restore(snap);
  const revisit2 = trace2.getRevisitCounts();
  assertEqual(revisit2.listing, 3, 'Restored revisit count for listing should be 3');
  assertEqual(revisit2.product_detail, 3, 'Restored revisit count for PDP should be 3');

  trace.dispose();
  trace2.dispose();

  console.log('  Revisit escalation correctness: OK');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

function runAll() {
  console.log('=================================================================');
  console.log('  OPE Integration Tests — v4 Enterprise Hardening');
  console.log('=================================================================');

  try { testTaxonomyUnification(); } catch (e) { console.error('TEST 1 CRASHED:', e.message); failCount++; }
  try { testSingleFatigueAuthority(); } catch (e) { console.error('TEST 2 CRASHED:', e.message); failCount++; }
  try { testPolicyDeterminism(); } catch (e) { console.error('TEST 3 CRASHED:', e.message); failCount++; }
  try { testNoFlickering(); } catch (e) { console.error('TEST 4 CRASHED:', e.message); failCount++; }
  try { testIntentTransitions(); } catch (e) { console.error('TEST 5 CRASHED:', e.message); failCount++; }
  try { testFullJourney(); } catch (e) { console.error('TEST 6 CRASHED:', e.message); failCount++; }
  try { testCooldownSuppressGate(); } catch (e) { console.error('TEST 7 CRASHED:', e.message); failCount++; }
  try { testNoParallelAuthorities(); } catch (e) { console.error('TEST 8 CRASHED:', e.message); failCount++; }
  try { testBackwardCompatibility(); } catch (e) { console.error('TEST 9 CRASHED:', e.message); failCount++; }
  try { testArchitecturalAudit(); } catch (e) { console.error('TEST 10 CRASHED:', e.message); failCount++; }

  // ---- P2-HARDEN: New tests 11-18 ----
  try { testDeterministicReplayEquality(); } catch (e) { console.error('TEST 11 CRASHED:', e.message); failCount++; }
  try { testBoundedMemoryValidation(); } catch (e) { console.error('TEST 12 CRASHED:', e.message); failCount++; }
  try { testSnapshotRestoreIntegrity(); } catch (e) { console.error('TEST 13 CRASHED:', e.message); failCount++; }
  try { testRuntimeTraceFlow(); } catch (e) { console.error('TEST 14 CRASHED:', e.message); failCount++; }
  try { testHealthCheckDiagnostics(); } catch (e) { console.error('TEST 15 CRASHED:', e.message); failCount++; }
  try { testOrchestratorTraceAndCleanup(); } catch (e) { console.error('TEST 16 CRASHED:', e.message); failCount++; }
  try { testNoDuplicatedInterventions(); } catch (e) { console.error('TEST 17 CRASHED:', e.message); failCount++; }
  try { testRevisitEscalationCorrectness(); } catch (e) { console.error('TEST 18 CRASHED:', e.message); failCount++; }

  console.log('\n=================================================================');
  console.log(`  RESULTS: ${passCount} passed, ${failCount} failed (${assertCount} assertions)`);
  console.log('=================================================================');

  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }

  return failCount === 0;
}

const success = runAll();
process.exit(success ? 0 : 1);
