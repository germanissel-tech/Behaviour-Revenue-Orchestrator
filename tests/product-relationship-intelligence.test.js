/**
 * product-relationship-intelligence.test.js
 *
 * COMPREHENSIVE TESTS for Product Relationship Intelligence v3
 *
 * Validates:
 *   1. Relationship type taxonomy and constraints
 *   2. Category allowlist enforcement (FOOD/GROCERY/DELIVERY only)
 *   3. Completion confidence threshold (>0.85)
 *   4. Negative preference memory (dismissals, skips, TTL)
 *   5. Session intervention limits (max 1 per type per session)
 *   6. Cautious message generation (no forbidden phrases)
 *   7. Determinism and replay safety
 *   8. Integration with OPE architecture
 */

'use strict';

const { RELATIONSHIP_TYPES, validateInterventionPermission, isInterventionAllowedForCategory } = require('../lib/product-relationship-types');
const { CompletionConfidenceEngine } = require('../lib/completion-confidence-engine');
const { NegativePreferenceMemory, MS_PER_DAY } = require('../lib/negative-preference-memory');
const { generateCautiousMessage, validateMessage, FORBIDDEN_PHRASES } = require('../lib/cautious-message-templates');
const { ProductRelationshipInterventionEngine, INTERVENTION_DECISIONS } = require('../lib/product-relationship-intervention-engine');

// ============================================================================
// TEST HELPERS
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

function section(name) {
  console.log(`\n=== ${name} ===`);
}

function sub(name) {
  console.log(`  --- ${name}`);
}

// ============================================================================
// TEST 1: RELATIONSHIP TYPE TAXONOMY
// ============================================================================

function testRelationshipTypes() {
  section('TEST 1: Relationship Type Taxonomy');

  sub('1.1: All relationship types defined');
  assert(RELATIONSHIP_TYPES.REQUIRED_COMPONENT === 'required_component', 'REQUIRED_COMPONENT defined');
  assert(RELATIONSHIP_TYPES.PREPARATION_COMPONENT === 'preparation_component', 'PREPARATION_COMPONENT defined');
  assert(RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT === 'optional_complement', 'OPTIONAL_COMPLEMENT defined');
  assert(RELATIONSHIP_TYPES.LIFESTYLE_COMPLEMENT === 'lifestyle_complement', 'LIFESTYLE_COMPLEMENT defined');

  sub('1.2: Intervention permission by type');
  // REQUIRED_COMPONENT + food → allowed
  const result1 = validateInterventionPermission({
    fromCategory: 'food',
    toCategory: 'food',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
  });
  assertEqual(result1.allowed, true, 'REQUIRED_COMPONENT + food → allowed');

  // PREPARATION_COMPONENT + grocery → allowed
  const result2 = validateInterventionPermission({
    fromCategory: 'grocery',
    toCategory: 'grocery',
    relationshipType: RELATIONSHIP_TYPES.PREPARATION_COMPONENT,
  });
  assertEqual(result2.allowed, true, 'PREPARATION_COMPONENT + grocery → allowed');

  // OPTIONAL_COMPLEMENT → blocked (never auto)
  const result3 = validateInterventionPermission({
    fromCategory: 'food',
    toCategory: 'food',
    relationshipType: RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT,
  });
  assertEqual(result3.allowed, false, 'OPTIONAL_COMPLEMENT → blocked');
  assert(result3.reason.includes('optional_complement'), 'Reason mentions optional_complement');

  // LIFESTYLE_COMPLEMENT → blocked
  const result4 = validateInterventionPermission({
    fromCategory: 'food',
    toCategory: 'food',
    relationshipType: RELATIONSHIP_TYPES.LIFESTYLE_COMPLEMENT,
  });
  assertEqual(result4.allowed, false, 'LIFESTYLE_COMPLEMENT → blocked');

  console.log('  Relationship type taxonomy: OK');
}

// ============================================================================
// TEST 2: CATEGORY ALLOWLIST
// ============================================================================

function testCategoryAllowlist() {
  section('TEST 2: Category Allowlist (FOOD/GROCERY/DELIVERY only)');

  sub('2.1: Allowed categories');
  assert(isInterventionAllowedForCategory('food'), 'food → allowed');
  assert(isInterventionAllowedForCategory('FOOD'), 'FOOD → allowed (case insensitive)');
  assert(isInterventionAllowedForCategory('grocery'), 'grocery → allowed');
  assert(isInterventionAllowedForCategory('delivery'), 'delivery → allowed');
  assert(isInterventionAllowedForCategory('groceries'), 'groceries → allowed');
  assert(isInterventionAllowedForCategory('restaurant'), 'restaurant → allowed');
  assert(isInterventionAllowedForCategory('recipe'), 'recipe → allowed');

  sub('2.2: Blocked categories');
  assert(!isInterventionAllowedForCategory('fashion'), 'fashion → blocked');
  assert(!isInterventionAllowedForCategory('technology'), 'technology → blocked');
  assert(!isInterventionAllowedForCategory('electronics'), 'electronics → blocked');
  assert(!isInterventionAllowedForCategory('accessories'), 'accessories → blocked');
  assert(!isInterventionAllowedForCategory('beauty'), 'beauty → blocked');
  assert(!isInterventionAllowedForCategory('furniture'), 'furniture → blocked');

  sub('2.3: Permission validation with blocked category');
  const result = validateInterventionPermission({
    fromCategory: 'electronics',
    toCategory: 'electronics',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
  });
  assertEqual(result.allowed, false, 'electronics + REQUIRED_COMPONENT → blocked');
  assert(result.reason.includes('category'), 'Reason mentions category');

  console.log('  Category allowlist: OK');
}

// ============================================================================
// TEST 3: COMPLETION CONFIDENCE ENGINE
// ============================================================================

function testCompletionConfidence() {
  section('TEST 3: Completion Confidence Engine');

  const engine = new CompletionConfidenceEngine({ confidenceThreshold: 0.85 });

  sub('3.1: High confidence signals → meets threshold');
  const result1 = engine.computeConfidence({
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    signals: {
      relationshipStrength: 0.9,
      historicalPurchasePattern: 0.85,
      productCategoryConfidence: 0.95,
      cartContextScore: 0.8,
      missingComponentLikelihood: 0.9,
    },
    dismissalCount: 0,
    nowMs: 1000,
  });
  assert(result1.confidence >= 0.85, `High signals → confidence >= 0.85 (got ${result1.confidence.toFixed(3)})`);
  assertEqual(result1.meetsThreshold, true, 'High signals → meets threshold');

  sub('3.2: Low signals → below threshold');
  const result2 = engine.computeConfidence({
    triggerProductId: 'shirt',
    suggestedProductId: 'pants',
    signals: {
      relationshipStrength: 0.3,
      historicalPurchasePattern: 0.2,
      productCategoryConfidence: 0.5,
      cartContextScore: 0.3,
      missingComponentLikelihood: 0.4,
    },
    dismissalCount: 0,
    nowMs: 2000,
  });
  assert(result2.confidence < 0.85, `Low signals → confidence < 0.85 (got ${result2.confidence.toFixed(3)})`);
  assertEqual(result2.meetsThreshold, false, 'Low signals → below threshold');

  sub('3.3: Dismissals reduce confidence');
  const result3 = engine.computeConfidence({
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    signals: {
      relationshipStrength: 0.9,
      historicalPurchasePattern: 0.85,
      productCategoryConfidence: 0.95,
      cartContextScore: 0.8,
      missingComponentLikelihood: 0.9,
    },
    dismissalCount: 3,
    nowMs: 3000,
  });
  assert(result3.confidence < result1.confidence, 'Dismissals reduce confidence');
  assert(result3.rationale.some(r => r.includes('dismissal')), 'Rationale mentions dismissals');

  sub('3.4: Snapshot/restore');
  const snap = engine.snapshot();
  assertEqual(snap.__type, 'CompletionConfidenceEngine', 'Snapshot has correct type');
  
  const engine2 = new CompletionConfidenceEngine();
  engine2.restore(snap);
  assertEqual(engine2._version, engine._version, 'Restored version matches');

  console.log('  Completion confidence engine: OK');
}

// ============================================================================
// TEST 4: NEGATIVE PREFERENCE MEMORY
// ============================================================================

function testNegativePreferenceMemory() {
  section('TEST 4: Negative Preference Memory');

  const memory = new NegativePreferenceMemory({
    memoryTtlDays: 90,
    dismissCountToSuppress: 2,
    skipCountToSuppress: 3,
  });

  const relationshipId = 'flour:eggs';
  const nowMs = Date.now(); // Only for test, engine uses injected nowMs

  sub('4.1: Record dismissal');
  memory.recordDismissal({
    relationshipId,
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    nowMs,
  });

  const stats = memory.getDismissalStats(relationshipId, nowMs);
  assertEqual(stats.dismissCount, 1, 'First dismissal recorded');
  assertEqual(stats.reachesThreshold, false, '1 dismissal < threshold');

  sub('4.2: Second dismissal → suppression');
  memory.recordDismissal({
    relationshipId,
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    nowMs: nowMs + 1000,
  });

  const stats2 = memory.getDismissalStats(relationshipId, nowMs + 1000);
  assertEqual(stats2.dismissCount, 2, 'Second dismissal recorded');
  assertEqual(stats2.reachesThreshold, true, '2 dismissals >= threshold');

  const suppression = memory.shouldSuppress(relationshipId, nowMs + 1000);
  assertEqual(suppression.suppressed, true, 'Should be suppressed after 2 dismissals');

  sub('4.3: TTL expiration');
  const futureMs = nowMs + (91 * MS_PER_DAY); // 91 days later
  const suppressionExpired = memory.shouldSuppress(relationshipId, futureMs);
  assertEqual(suppressionExpired.suppressed, false, 'Suppression expired after TTL');

  sub('4.4: Snapshot/restore');
  const snap = memory.snapshot();
  assertEqual(snap.__type, 'NegativePreferenceMemory', 'Snapshot has correct type');

  const memory2 = new NegativePreferenceMemory();
  memory2.restore(snap);
  assertEqual(memory2._version, memory._version, 'Restored version matches');

  console.log('  Negative preference memory: OK');
}

// ============================================================================
// TEST 5: CAUTIOUS MESSAGE TEMPLATES
// ============================================================================

function testCautiousMessages() {
  section('TEST 5: Cautious Message Templates');

  sub('5.1: Forbidden phrases detection');
  for (const phrase of FORBIDDEN_PHRASES.slice(0, 5)) {
    const result = validateMessage(`Hey, ${phrase} this product!`);
    assertEqual(result.valid, false, `Detects forbidden phrase: "${phrase}"`);
  }

  sub('5.2: Valid cautious messages');
  const validMessages = [
    'Algunas personas suelen comprar huevos junto con harina.',
    'Some people often buy eggs along with flour.',
    'For reference: eggs is a common component.',
    'Podría interesarte saber que los huevos suelen acompañar.',
  ];
  for (const msg of validMessages) {
    const result = validateMessage(msg);
    assertEqual(result.valid, true, `Valid message accepted: "${msg.slice(0, 40)}..."`);
  }

  sub('5.3: Message generation');
  const generated = generateCautiousMessage({
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    suggestedProduct: 'eggs',
    triggerProduct: 'flour',
    language: 'es',
    seed: 42,
  });
  assertEqual(generated.valid, true, 'Generated message is valid');
  assert(generated.message.length > 0, 'Generated message is not empty');
  assert(!generated.message.includes('{'), 'No unresolved placeholders');

  sub('5.4: Messages use cautious language');
  const cautiousKeywords = ['suelen', 'Podría', 'Algunas', 'Información'];
  const hasKeyword = cautiousKeywords.some(k => generated.message.includes(k));
  assert(hasKeyword, 'Message uses cautious language');

  console.log('  Cautious message templates: OK');
}

// ============================================================================
// TEST 6: MAIN INTERVENTION ENGINE
// ============================================================================

function testInterventionEngine() {
  section('TEST 6: Main Intervention Engine');

  const engine = new ProductRelationshipInterventionEngine();
  const baseNowMs = 1000000;

  sub('6.1: Session lifecycle');
  engine.beginSession('test-session-1', baseNowMs);
  assert(engine._sessionId === 'test-session-1', 'Session started');

  sub('6.2: Valid intervention (food + required_component + high confidence)');
  const result1 = engine.evaluate({
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromCategory: 'food',
    toCategory: 'food',
    confidenceSignals: {
      relationshipStrength: 0.95,
      historicalPurchasePattern: 0.9,
      productCategoryConfidence: 0.95,
      cartContextScore: 0.85,
      missingComponentLikelihood: 0.9,
    },
    triggerProductName: 'Harina',
    suggestedProductName: 'Huevos',
    nowMs: baseNowMs + 1000,
  });
  assertEqual(result1.decision, INTERVENTION_DECISIONS.INTERVENE, 'Valid intervention approved');
  assertEqual(result1.shouldIntervene, true, 'shouldIntervene is true');
  assert(result1.message, 'Message generated');
  assert(result1.messageContext, 'Message context provided');

  sub('6.3: Session limit (same type)');
  const result2 = engine.evaluate({
    triggerProductId: 'butter',
    suggestedProductId: 'sugar',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromCategory: 'food',
    toCategory: 'food',
    confidenceSignals: {
      relationshipStrength: 0.95,
      historicalPurchasePattern: 0.9,
      productCategoryConfidence: 0.95,
      cartContextScore: 0.85,
      missingComponentLikelihood: 0.9,
    },
    nowMs: baseNowMs + 120000, // 2 minutes later (past cooldown)
  });
  assertEqual(result2.decision, INTERVENTION_DECISIONS.SESSION_LIMIT, 'Second same-type intervention blocked');
  assert(result2.reason.includes('type_limit'), 'Reason mentions type limit');

  sub('6.4: Blocked category (tech)');
  engine.reset(baseNowMs + 200000);
  engine.beginSession('test-session-2', baseNowMs + 200000);

  const result3 = engine.evaluate({
    triggerProductId: 'camera',
    suggestedProductId: 'sd_card',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromCategory: 'technology',
    toCategory: 'technology',
    confidenceSignals: {
      relationshipStrength: 0.95,
      historicalPurchasePattern: 0.9,
    },
    nowMs: baseNowMs + 201000,
  });
  assertEqual(result3.decision, INTERVENTION_DECISIONS.BLOCK_CATEGORY, 'Tech category blocked');
  assertEqual(result3.shouldIntervene, false, 'shouldIntervene is false');

  sub('6.5: Low confidence');
  const result4 = engine.evaluate({
    triggerProductId: 'bread',
    suggestedProductId: 'jam',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromCategory: 'food',
    toCategory: 'food',
    confidenceSignals: {
      relationshipStrength: 0.3,
      historicalPurchasePattern: 0.2,
      productCategoryConfidence: 0.5,
      cartContextScore: 0.3,
      missingComponentLikelihood: 0.4,
    },
    nowMs: baseNowMs + 202000,
  });
  assertEqual(result4.decision, INTERVENTION_DECISIONS.LOW_CONFIDENCE, 'Low confidence blocked');

  sub('6.6: Snapshot/restore');
  const snap = engine.snapshot();
  assertEqual(snap.__type, 'ProductRelationshipInterventionEngine', 'Snapshot has correct type');

  const engine2 = new ProductRelationshipInterventionEngine();
  engine2.restore(snap);
  assertEqual(engine2._sessionId, engine._sessionId, 'Restored session matches');

  console.log('  Main intervention engine: OK');
}

// ============================================================================
// TEST 7: DETERMINISM
// ============================================================================

function testDeterminism() {
  section('TEST 7: Determinism');

  sub('7.1: Same inputs → same outputs');
  const engine1 = new ProductRelationshipInterventionEngine();
  const engine2 = new ProductRelationshipInterventionEngine();

  const params = {
    triggerProductId: 'flour',
    suggestedProductId: 'eggs',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromCategory: 'food',
    toCategory: 'food',
    confidenceSignals: {
      relationshipStrength: 0.9,
      historicalPurchasePattern: 0.85,
      productCategoryConfidence: 0.95,
      cartContextScore: 0.8,
      missingComponentLikelihood: 0.9,
    },
    nowMs: 1000000,
  };

  engine1.beginSession('det-test', params.nowMs - 1000);
  engine2.beginSession('det-test', params.nowMs - 1000);

  const result1 = engine1.evaluate(params);
  const result2 = engine2.evaluate(params);

  assertEqual(result1.decision, result2.decision, 'Same decision');
  assertEqual(result1.shouldIntervene, result2.shouldIntervene, 'Same shouldIntervene');
  // Note: message may vary by seed, but decision should be identical

  sub('7.2: No Date.now() usage');
  // Verify that invalid nowMs throws
  let threw = false;
  try {
    engine1.evaluate({ ...params, nowMs: undefined });
  } catch (e) {
    threw = true;
    assert(e.message.includes('nowMs'), 'Error mentions nowMs');
  }
  assert(threw, 'Throws on missing nowMs');

  console.log('  Determinism: OK');
}

// ============================================================================
// TEST 8: FORBIDDEN PATTERNS
// ============================================================================

function testForbiddenPatterns() {
  section('TEST 8: Forbidden Patterns');

  sub('8.1: Burger → fries blocked (even in food)');
  const result1 = validateInterventionPermission({
    fromCategory: 'food',
    toCategory: 'food',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromSubcategory: 'burger',
    toSubcategory: 'fries',
  });
  assertEqual(result1.allowed, false, 'burger → fries blocked');
  assert(result1.reason.includes('forbidden_pattern'), 'Reason mentions forbidden pattern');

  sub('8.2: Camera → sd_card blocked');
  const result2 = validateInterventionPermission({
    fromCategory: 'electronics',
    toCategory: 'electronics',
    relationshipType: RELATIONSHIP_TYPES.REQUIRED_COMPONENT,
    fromSubcategory: 'camera',
    toSubcategory: 'sd_card',
  });
  assertEqual(result2.allowed, false, 'camera → sd_card blocked by category');

  sub('8.3: Shirt → shoes blocked');
  const result3 = validateInterventionPermission({
    fromCategory: 'fashion',
    toCategory: 'fashion',
    relationshipType: RELATIONSHIP_TYPES.LIFESTYLE_COMPLEMENT,
    fromSubcategory: 'shirt',
    toSubcategory: 'shoes',
  });
  assertEqual(result3.allowed, false, 'shirt → shoes blocked');

  console.log('  Forbidden patterns: OK');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

function runAllTests() {
  console.log('\n========================================');
  console.log('PRODUCT RELATIONSHIP INTELLIGENCE v3 TESTS');
  console.log('========================================');

  testRelationshipTypes();
  testCategoryAllowlist();
  testCompletionConfidence();
  testNegativePreferenceMemory();
  testCautiousMessages();
  testInterventionEngine();
  testDeterminism();
  testForbiddenPatterns();

  console.log('\n========================================');
  console.log(`RESULTS: ${passCount}/${assertCount} passed, ${failCount} failed`);
  console.log('========================================');

  if (failCount > 0) {
    console.log('\nFailed assertions:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  } else {
    console.log('\nAll tests passed!\n');
    process.exit(0);
  }
}

runAllTests();
