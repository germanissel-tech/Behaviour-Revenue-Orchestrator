/**
 * tests/product-relationship-hardening.test.js (PHASE 7)
 *
 * TEST COVERAGE for Product Relationship Intelligence hardening phases:
 *   - Phase 1: Ontology normalization tests
 *   - Phase 2: Historical memory tests
 *   - Phase 3: Adaptive threshold tests
 *   - Phase 4: Return-risk integration tests
 *   - Phase 5: Memory cleanup tests
 *   - Phase 6: Replay consistency tests
 *
 * Validates:
 *   - Same inputs -> same outputs
 *   - No state drift
 *   - No duplicate interventions
 */

'use strict';

const { ProductOntologyNormalizer, CANONICAL_PRODUCT_TYPES } = require('../lib/product-ontology-normalizer');
const { HistoricalPurchaseMemory } = require('../lib/historical-purchase-memory');
const { AdaptiveConfidenceThresholds, CATEGORY_BASE_THRESHOLDS } = require('../lib/adaptive-confidence-thresholds');
const { ReturnRiskIntelligenceEngine, RISK_TIERS } = require('../lib/return-risk-intelligence-engine');
const { MemorySafetyAudit, SEVERITY } = require('../lib/memory-safety-audit');
const { BidirectionalDependencyValidator, MODULE_DEPENDENCIES } = require('../lib/bidirectional-dependency-validator');
const { NegativePreferenceMemory } = require('../lib/negative-preference-memory');
const { CompletionConfidenceEngine } = require('../lib/completion-confidence-engine');

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

function assertApprox(actual, expected, tolerance, message) {
  assertCount++;
  if (Math.abs(actual - expected) <= tolerance) {
    passCount++;
  } else {
    failCount++;
    const msg = `${message} (expected ~${expected}±${tolerance}, got ${actual})`;
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
  }
}

function section(name) {
  console.log(`\n=== ${name} ===`);
}

// ============================================================================
// TEST 1: ONTOLOGY NORMALIZATION (PHASE 1)
// ============================================================================

function testOntologyNormalization() {
  section('TEST 1: Ontology Normalization (Phase 1)');

  const normalizer = new ProductOntologyNormalizer();
  const nowMs = 1000000;

  // 1a. Exact alias match for hamburger
  const burger1 = normalizer.normalizeProduct({ name: 'Beef Burger Patty' }, nowMs);
  assertEqual(burger1.canonicalType, 'hamburger_patty', 'Burger patty should normalize to hamburger_patty');
  assertEqual(burger1.source, 'exact_alias', 'Should be exact alias match');
  assert(burger1.confidence >= 0.75, 'Confidence should meet floor');

  // 1b. Spanish alias match
  const burger2 = normalizer.normalizeProduct({ name: 'Hamburguesa de res' }, nowMs);
  assertEqual(burger2.canonicalType, 'hamburger_patty', 'Spanish hamburguesa should normalize');
  assert(burger2.confidence > 0, 'Should have positive confidence');

  // 1c. Pasta variations
  const pasta1 = normalizer.normalizeProduct({ name: 'Spaghetti N°5' }, nowMs);
  assertEqual(pasta1.canonicalType, 'dry_pasta', 'Spaghetti should normalize to dry_pasta');

  const pasta2 = normalizer.normalizeProduct({ name: 'Fideos Tallarines' }, nowMs);
  assertEqual(pasta2.canonicalType, 'dry_pasta', 'Fideos tallarines should normalize');

  // 1d. Category normalization
  assertEqual(normalizer.normalizeCategory('comida'), 'food', 'Spanish comida -> food');
  assertEqual(normalizer.normalizeCategory('grocery'), 'grocery', 'grocery -> grocery');
  assertEqual(normalizer.normalizeCategory('electrónica'), 'electronics', 'Spanish electrónica -> electronics');

  // 1e. Unknown product
  const unknown = normalizer.normalizeProduct({ name: 'xyz123abc' }, nowMs);
  assertEqual(unknown.canonicalType, null, 'Unknown product should return null canonicalType');
  assertEqual(unknown.source, 'unknown', 'Source should be unknown');

  // 1f. Determinism: same input -> same output
  const result1 = normalizer.normalizeProduct({ name: 'French Fries frozen' }, nowMs);
  const result2 = normalizer.normalizeProduct({ name: 'French Fries frozen' }, nowMs);
  assertEqual(result1.canonicalType, result2.canonicalType, 'Determinism: same canonicalType');
  assertEqual(result1.confidence, result2.confidence, 'Determinism: same confidence');

  // 1g. Automatic intervention check
  assert(normalizer.allowsAutomaticIntervention('food'), 'Food allows automatic intervention');
  assert(normalizer.allowsAutomaticIntervention('grocery'), 'Grocery allows automatic intervention');
  assert(!normalizer.allowsAutomaticIntervention('electronics'), 'Electronics does NOT allow automatic intervention');
  assert(!normalizer.allowsAutomaticIntervention('fashion'), 'Fashion does NOT allow automatic intervention');

  // 1h. Snapshot/restore
  const snapshot = normalizer.snapshot();
  assert(snapshot.__type === 'ProductOntologyNormalizer', 'Snapshot has correct type');
  assert(snapshot.__version === 1, 'Snapshot has correct version');

  normalizer.dispose();
  console.log('  Ontology normalization: OK');
}

// ============================================================================
// TEST 2: HISTORICAL PURCHASE MEMORY (PHASE 2)
// ============================================================================

function testHistoricalPurchaseMemory() {
  section('TEST 2: Historical Purchase Memory (Phase 2)');

  const memory = new HistoricalPurchaseMemory();
  const baseNow = 1000000;

  // 2a. Record purchases with co-occurrence
  memory.recordPurchase({
    sessionId: 'session1',
    products: [
      { productId: 'p1', canonicalType: 'dry_pasta', category: 'food' },
      { productId: 'p2', canonicalType: 'pasta_sauce', category: 'food' },
    ],
    nowMs: baseNow,
  });

  memory.recordPurchase({
    sessionId: 'session2',
    products: [
      { productId: 'p3', canonicalType: 'dry_pasta', category: 'food' },
      { productId: 'p4', canonicalType: 'pasta_sauce', category: 'food' },
    ],
    nowMs: baseNow + 1000,
  });

  memory.recordPurchase({
    sessionId: 'session3',
    products: [
      { productId: 'p5', canonicalType: 'dry_pasta', category: 'food' },
      { productId: 'p6', canonicalType: 'pasta_sauce', category: 'food' },
    ],
    nowMs: baseNow + 2000,
  });

  // 2b. Check affinity (should be high after 3 co-purchases)
  const pattern = memory.getRelationshipPattern('dry_pasta', 'pasta_sauce', baseNow + 3000);
  assertEqual(pattern.affinity, 'high', 'Pasta + sauce should have high affinity after 3 purchases');
  assert(pattern.presentCount >= 3, 'Should have at least 3 present observations');
  assertEqual(pattern.absentCount, 0, 'Should have no absent observations');
  assert(pattern.confidence > 0, 'Should have positive confidence');

  // 2c. Record missing complement (pasta without sauce)
  memory.recordMissingComplement({
    primaryCanonicalType: 'hamburger_patty',
    expectedComplementType: 'burger_bun',
    nowMs: baseNow + 4000,
  });

  memory.recordMissingComplement({
    primaryCanonicalType: 'hamburger_patty',
    expectedComplementType: 'burger_bun',
    nowMs: baseNow + 5000,
  });

  memory.recordMissingComplement({
    primaryCanonicalType: 'hamburger_patty',
    expectedComplementType: 'burger_bun',
    nowMs: baseNow + 6000,
  });

  // 2d. Check suppression due to repeated absence
  const burgerPattern = memory.getRelationshipPattern('hamburger_patty', 'burger_bun', baseNow + 7000);
  assertEqual(burgerPattern.affinity, 'low', 'Burger + bun should have low affinity after 3 absences');
  assert(burgerPattern.absentCount >= 3, 'Should have at least 3 absent observations');

  const suppression = memory.shouldSuppressRelationship('hamburger_patty', 'burger_bun', baseNow + 7000);
  assertEqual(suppression.suppress, true, 'Should suppress relationship due to low affinity');

  // 2e. Snapshot/restore
  const snapshot = memory.snapshot();
  assert(snapshot.__type === 'HistoricalPurchaseMemory', 'Snapshot has correct type');

  const newMemory = new HistoricalPurchaseMemory();
  newMemory.restore(snapshot);

  const restoredPattern = newMemory.getRelationshipPattern('dry_pasta', 'pasta_sauce', baseNow + 8000);
  assertEqual(restoredPattern.presentCount, pattern.presentCount, 'Restored memory preserves observations');

  memory.dispose();
  newMemory.dispose();
  console.log('  Historical purchase memory: OK');
}

// ============================================================================
// TEST 3: ADAPTIVE CONFIDENCE THRESHOLDS (PHASE 3)
// ============================================================================

function testAdaptiveConfidenceThresholds() {
  section('TEST 3: Adaptive Confidence Thresholds (Phase 3)');

  const thresholds = new AdaptiveConfidenceThresholds();
  const nowMs = 1000000;

  // 3a. Base thresholds by category
  const foodThreshold = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'REQUIRED_COMPONENT',
    nowMs,
  });
  assertApprox(foodThreshold.baseThreshold, 0.85, 0.01, 'Food base threshold should be 0.85');
  assertEqual(foodThreshold.allowsAutomaticIntervention, true, 'Food should allow automatic intervention');

  const pharmacyThreshold = thresholds.getDynamicThreshold({
    category: 'pharmacy',
    relationshipType: 'REQUIRED_COMPONENT',
    nowMs,
  });
  assertApprox(pharmacyThreshold.baseThreshold, 0.97, 0.01, 'Pharmacy base threshold should be 0.97');
  assertEqual(pharmacyThreshold.allowsAutomaticIntervention, false, 'Pharmacy should NOT allow automatic intervention');

  // 3b. Relationship type modifiers
  const requiredThreshold = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'REQUIRED_COMPONENT',
    nowMs,
  });

  const styleThreshold = thresholds.getDynamicThreshold({
    category: 'fashion',
    relationshipType: 'STYLE_MATCH',
    nowMs,
  });

  assert(requiredThreshold.threshold < requiredThreshold.baseThreshold,
    'REQUIRED_COMPONENT should lower threshold');
  assert(styleThreshold.threshold > styleThreshold.baseThreshold,
    'STYLE_MATCH should raise threshold');

  // 3c. Reliability adjustment
  const goodReliability = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'PREPARATION_COMPONENT',
    historicalReliability: 0.90,
    nowMs,
  });

  const poorReliability = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'PREPARATION_COMPONENT',
    historicalReliability: 0.20,
    nowMs,
  });

  assert(goodReliability.threshold < poorReliability.threshold,
    'Good reliability should lower threshold vs poor reliability');

  // 3d. Variance adjustment
  const lowVariance = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'PREPARATION_COMPONENT',
    confidenceVariance: 0.1,
    nowMs,
  });

  const highVariance = thresholds.getDynamicThreshold({
    category: 'food',
    relationshipType: 'PREPARATION_COMPONENT',
    confidenceVariance: 0.8,
    nowMs,
  });

  assert(lowVariance.threshold < highVariance.threshold,
    'Low variance should lower threshold vs high variance');

  // 3e. Determinism
  const result1 = thresholds.getDynamicThreshold({
    category: 'grocery',
    relationshipType: 'REQUIRED_COMPONENT',
    historicalReliability: 0.75,
    confidenceVariance: 0.3,
    nowMs,
  });
  const result2 = thresholds.getDynamicThreshold({
    category: 'grocery',
    relationshipType: 'REQUIRED_COMPONENT',
    historicalReliability: 0.75,
    confidenceVariance: 0.3,
    nowMs,
  });
  assertEqual(result1.threshold, result2.threshold, 'Determinism: same threshold');

  // 3f. Category helper
  assert(thresholds.categoryAllowsAutomaticIntervention('food'), 'Food allows intervention');
  assert(thresholds.categoryAllowsAutomaticIntervention('delivery'), 'Delivery allows intervention');
  assert(!thresholds.categoryAllowsAutomaticIntervention('electronics'), 'Electronics does not allow intervention');

  thresholds.dispose();
  console.log('  Adaptive confidence thresholds: OK');
}

// ============================================================================
// TEST 4: RETURN-RISK INTEGRATION (PHASE 4)
// ============================================================================

function testReturnRiskIntegration() {
  section('TEST 4: Return-Risk Integration (Phase 4)');

  // Create mock dependencies
  const mockOntology = {
    resolve: (product, nowMs) => ({
      productId: product.productId,
      category: 'photography',
      subcategory: 'camera_body',
      returnRiskFactors: ['size_dependent', 'compatibility_risk'],
    }),
  };

  const mockGraph = {
    findMissingComplements: () => [],
  };

  const mockCompatibility = {
    evaluate: () => ({ outcome: 'compatible' }),
    evaluateSet: () => [],
  };

  const engine = new ReturnRiskIntelligenceEngine(mockOntology, mockGraph, mockCompatibility);
  const nowMs = 1000000;

  // 4a. Assess risk for cart with compatibility risks
  const assessment = engine.assess({
    cartProducts: [
      { productId: 'camera1', viewCount: 3 },
    ],
    viewedProducts: [],
    nowMs,
  });

  assert(assessment.riskScore >= 0, 'Risk score should be >= 0');
  assert(assessment.riskScore <= 1, 'Risk score should be <= 1');
  assert(assessment.riskTier !== undefined, 'Should have risk tier');
  assert(Array.isArray(assessment.factors), 'Should have factors array');

  // 4b. Get intervention adjustments for high risk
  const highRiskAssessment = {
    riskScore: 0.75,
    riskTier: RISK_TIERS.HIGH,
    factors: [{ type: 'technical_mismatch' }],
  };

  const adjustments = engine.getInterventionAdjustments(highRiskAssessment);
  assert(adjustments.preferredFamilies.includes('QUALITY'), 'High risk should prefer QUALITY');
  assert(adjustments.preferredFamilies.includes('REASSURANCE'), 'High risk should prefer REASSURANCE');
  assert(adjustments.suppressedFamilies.includes('URGENCY'), 'High risk should suppress URGENCY');
  assert(adjustments.intensityMultiplier < 1, 'High risk should reduce intensity');
  assert(adjustments.urgencyMultiplier < 1, 'High risk should reduce urgency');
  assertEqual(adjustments.recommendedTone, 'reassuring', 'High risk should use reassuring tone');

  // 4c. Low risk adjustments
  const lowRiskAssessment = {
    riskScore: 0.15,
    riskTier: RISK_TIERS.LOW,
    factors: [],
  };

  const lowAdjustments = engine.getInterventionAdjustments(lowRiskAssessment);
  assertEqual(lowAdjustments.intensityMultiplier, 1.0, 'Low risk should not reduce intensity');
  assertEqual(lowAdjustments.recommendedTone, 'neutral', 'Low risk should use neutral tone');

  // 4d. Should allow family check
  const urgencyCheck = engine.shouldAllowFamily('URGENCY', highRiskAssessment);
  assertEqual(urgencyCheck.allowed, false, 'URGENCY should be blocked for high risk');

  const qualityCheck = engine.shouldAllowFamily('QUALITY', highRiskAssessment);
  assertEqual(qualityCheck.allowed, true, 'QUALITY should be allowed for high risk');

  // 4e. Intensity adjustment
  const adjustedIntensity = engine.adjustIntensity(0.8, highRiskAssessment);
  assert(adjustedIntensity < 0.8, 'Adjusted intensity should be lower than base');
  assertEqual(adjustedIntensity, 0.8 * adjustments.intensityMultiplier, 'Intensity calculation correct');

  engine.dispose();
  console.log('  Return-risk integration: OK');
}

// ============================================================================
// TEST 5: MEMORY CLEANUP (PHASE 5)
// ============================================================================

function testMemoryCleanup() {
  section('TEST 5: Memory Cleanup (Phase 5)');

  // Create test stores
  const negativeMemory = new NegativePreferenceMemory();
  const historicalMemory = new HistoricalPurchaseMemory();
  const completionEngine = new CompletionConfidenceEngine();

  const nowMs = 1000000;

  // 5a. Add some data to stores
  negativeMemory.recordDismissal({
    relationshipId: 'rel1',
    triggerProductId: 'p1',
    suggestedProductId: 'p2',
    relationshipType: 'complement',
    nowMs,
  });

  historicalMemory.recordPurchase({
    sessionId: 's1',
    products: [
      { productId: 'p1', canonicalType: 'dry_pasta' },
      { productId: 'p2', canonicalType: 'pasta_sauce' },
    ],
    nowMs,
  });

  completionEngine.computeConfidence({
    triggerProductId: 'p1',
    suggestedProductId: 'p2',
    signals: { relationshipStrength: 0.8, historicalPurchasePattern: 0.7 },
    dismissalCount: 0,
    nowMs,
  });

  // 5b. Run memory safety audit
  const audit = new MemorySafetyAudit({
    negativePreferenceMemory: negativeMemory,
    historicalPurchaseMemory: historicalMemory,
    completionConfidenceEngine: completionEngine,
  });

  const report = audit.runAudit(nowMs + 1000);

  assert(report.healthy === true, 'Audit should report healthy');
  assert(report.summary.fail === 0, 'Should have no failures');
  assert(report.checks.length > 0, 'Should have checks');

  // 5c. Check each store passes audit
  const negativeChecks = report.checks.filter(c => c.store === 'negativePreferenceMemory');
  assert(negativeChecks.every(c => c.severity !== SEVERITY.FAIL), 'negativePreferenceMemory should pass');

  const historicalChecks = report.checks.filter(c => c.store === 'historicalPurchaseMemory');
  assert(historicalChecks.every(c => c.severity !== SEVERITY.FAIL), 'historicalPurchaseMemory should pass');

  // 5d. Test cleanup
  const cleanupResult = negativeMemory.cleanup(nowMs + 1000);
  assert(typeof cleanupResult.dismissals === 'number', 'Cleanup should return dismissal count');
  assert(typeof cleanupResult.skips === 'number', 'Cleanup should return skip count');
  assert(typeof cleanupResult.patterns === 'number', 'Cleanup should return pattern count');

  const historicalCleanup = historicalMemory.cleanup(nowMs + 1000);
  assert(typeof historicalCleanup.purchases === 'number', 'Cleanup should return purchase count');
  assert(typeof historicalCleanup.relationships === 'number', 'Cleanup should return relationship count');

  // 5e. Test dispose
  negativeMemory.dispose();
  historicalMemory.dispose();
  completionEngine.dispose();

  console.log('  Memory cleanup: OK');
}

// ============================================================================
// TEST 6: REPLAY CONSISTENCY (PHASE 6)
// ============================================================================

function testReplayConsistency() {
  section('TEST 6: Replay Consistency (Phase 6)');

  // 6a. Test ontology normalizer determinism
  const normalizer1 = new ProductOntologyNormalizer();
  const normalizer2 = new ProductOntologyNormalizer();
  const nowMs = 1000000;

  const products = [
    { name: 'Spaghetti pasta' },
    { name: 'Tomato sauce' },
    { name: 'Parmesan cheese' },
    { name: 'Unknown product xyz' },
    { name: 'Hamburguesa de res' },
  ];

  for (const product of products) {
    const result1 = normalizer1.normalizeProduct(product, nowMs);
    const result2 = normalizer2.normalizeProduct(product, nowMs);

    assertEqual(result1.canonicalType, result2.canonicalType,
      `Determinism for ${product.name}: canonicalType`);
    assertEqual(result1.confidence, result2.confidence,
      `Determinism for ${product.name}: confidence`);
    assertEqual(result1.source, result2.source,
      `Determinism for ${product.name}: source`);
  }

  // 6b. Test thresholds determinism
  const thresholds1 = new AdaptiveConfidenceThresholds();
  const thresholds2 = new AdaptiveConfidenceThresholds();

  const configs = [
    { category: 'food', relationshipType: 'REQUIRED_COMPONENT' },
    { category: 'pharmacy', relationshipType: 'COMPLEMENTARY' },
    { category: 'electronics', relationshipType: 'STYLE_MATCH', historicalReliability: 0.8 },
    { category: 'fashion', relationshipType: 'ENHANCEMENT', confidenceVariance: 0.5 },
  ];

  for (const config of configs) {
    const result1 = thresholds1.getDynamicThreshold({ ...config, nowMs });
    const result2 = thresholds2.getDynamicThreshold({ ...config, nowMs });

    assertEqual(result1.threshold, result2.threshold,
      `Determinism for ${config.category}/${config.relationshipType}: threshold`);
    assertEqual(result1.allowsAutomaticIntervention, result2.allowsAutomaticIntervention,
      `Determinism for ${config.category}/${config.relationshipType}: allowsAutomaticIntervention`);
  }

  // 6c. Test snapshot/restore preserves state
  const memory = new HistoricalPurchaseMemory();

  memory.recordPurchase({
    sessionId: 's1',
    products: [
      { productId: 'p1', canonicalType: 'dry_pasta' },
      { productId: 'p2', canonicalType: 'pasta_sauce' },
    ],
    nowMs,
  });

  const snapshot = memory.snapshot();
  const restoredMemory = new HistoricalPurchaseMemory();
  restoredMemory.restore(snapshot);

  const originalPattern = memory.getRelationshipPattern('dry_pasta', 'pasta_sauce', nowMs + 1000);
  const restoredPattern = restoredMemory.getRelationshipPattern('dry_pasta', 'pasta_sauce', nowMs + 1000);

  assertEqual(originalPattern.presentCount, restoredPattern.presentCount,
    'Snapshot/restore preserves presentCount');
  assertEqual(originalPattern.affinity, restoredPattern.affinity,
    'Snapshot/restore preserves affinity');

  // 6d. Validate bidirectional dependencies
  const validator = new BidirectionalDependencyValidator();
  const modules = {
    'product-ontology-normalizer': normalizer1,
    'adaptive-confidence-thresholds': thresholds1,
    'historical-purchase-memory': memory,
  };

  const validationReport = validator.validate(modules, nowMs);
  assert(validationReport.valid === true, 'Bidirectional validation should pass');
  assert(validationReport.summary.fail === 0, 'Should have no validation failures');

  normalizer1.dispose();
  normalizer2.dispose();
  thresholds1.dispose();
  thresholds2.dispose();
  memory.dispose();
  restoredMemory.dispose();

  console.log('  Replay consistency: OK');
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

function runAllTests() {
  console.log('\n========================================');
  console.log('PRODUCT RELATIONSHIP INTELLIGENCE HARDENING TESTS');
  console.log('========================================');

  testOntologyNormalization();
  testHistoricalPurchaseMemory();
  testAdaptiveConfidenceThresholds();
  testReturnRiskIntegration();
  testMemoryCleanup();
  testReplayConsistency();

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`Total assertions: ${assertCount}`);
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);

  if (failCount > 0) {
    console.log('\nFailed tests:');
    for (const failure of failures) {
      console.log(`  - ${failure}`);
    }
    process.exit(1);
  } else {
    console.log('\nAll tests passed!');
    process.exit(0);
  }
}

// Run if executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  runAllTests,
  testOntologyNormalization,
  testHistoricalPurchaseMemory,
  testAdaptiveConfidenceThresholds,
  testReturnRiskIntegration,
  testMemoryCleanup,
  testReplayConsistency,
};
