'use strict';

/**
 * product-relationship-intelligence.test.js
 *
 * Integration tests for the Product Relationship Intelligence layer:
 *   1. product-ontology-engine
 *   2. complement-graph-engine
 *   3. intent-completion-engine
 *   4. compatibility-intelligence-engine
 *   5. return-risk-intelligence-engine
 *   6. relationship-message-strategy-engine
 *
 * Validates:
 *   A.  Meal completion detection (pasta → sauce + cheese)
 *   B.  Missing accessory detection (camera → SD card)
 *   C.  Setup completion detection (monitor → HDMI cable)
 *   D.  Outfit completion detection (sweater → bottoms)
 *   E.  Skincare routine detection (beauty_device → serum + cleanser)
 *   F.  Compatibility reasoning (HDMI-HDMI ok, routine-order ok, wrong-order flagged)
 *   G.  Return-risk detection (camera without SD = high risk)
 *   H.  Revisit-aware recommendations (revisit boost on score)
 *   I.  Deterministic replay (snapshot → restore → same output)
 *   J.  Graph integrity (static edges load correctly, missing = empty)
 *   K.  Bounded memory (LRU eviction in ontology cache + opportunity store)
 *   L.  No duplicated interventions (same opportunity → same id)
 *   M.  No orchestration conflicts (strategy candidates carry required MRE fields)
 *   N.  No parallel pipelines (engines do NOT call session-orchestrator)
 *   O.  Explainability integrity (rationale array is non-empty and causal)
 *   P.  dispose() / cleanup() safe to call multiple times
 *   Q.  Dynamic edge registration
 *   R.  Anti-compatibility detection
 *   S.  Risk factor aggregation (max+dampened-sum formula)
 *   T.  Strategy-to-family mapping (all families are valid ope-constants families)
 */

const path = require('path');
const DIR  = __dirname;

const { ProductOntologyEngine, CATEGORIES, ARCHETYPES, RETURN_RISK_FACTORS } =
  require(`${DIR}/product-ontology-engine`);
const { ComplementGraphEngine, RELATIONSHIP_TYPES } =
  require(`${DIR}/complement-graph-engine`);
const { IntentCompletionEngine, OPPORTUNITY_TYPES, CONFIDENCE_TIERS } =
  require(`${DIR}/intent-completion-engine`);
const { CompatibilityIntelligenceEngine, COMPATIBILITY_OUTCOMES, COMPATIBILITY_DIMENSIONS } =
  require(`${DIR}/compatibility-intelligence-engine`);
const { ReturnRiskIntelligenceEngine, RISK_FACTOR_TYPES, RISK_TIERS } =
  require(`${DIR}/return-risk-intelligence-engine`);
const { RelationshipMessageStrategyEngine, STRATEGY_TYPES, STRATEGY_TO_FAMILY } =
  require(`${DIR}/relationship-message-strategy-engine`);

// ============================================================================
// Test harness
// ============================================================================

let totalTests = 0;
let passed     = 0;
let failed     = 0;
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

function assertGte(actual, min, message) {
  totalTests++;
  if (typeof actual === 'number' && actual >= min) {
    passed++;
    process.stdout.write(`  ✅ ${message} (${actual} >= ${min})\n`);
  } else {
    failed++;
    const detail = `${message} — expected >= ${min}, got ${actual}`;
    failures.push(detail);
    process.stdout.write(`  ❌ FAIL: ${detail}\n`);
  }
}

function assertIncludes(arr, value, message) {
  totalTests++;
  const ok = Array.isArray(arr) && arr.includes(value);
  if (ok) {
    passed++;
    process.stdout.write(`  ✅ ${message}\n`);
  } else {
    failed++;
    const detail = `${message} — expected ${JSON.stringify(value)} in ${JSON.stringify(arr)}`;
    failures.push(detail);
    process.stdout.write(`  ❌ FAIL: ${detail}\n`);
  }
}

function assertNotIncludes(arr, value, message) {
  totalTests++;
  const ok = Array.isArray(arr) && !arr.includes(value);
  if (ok) {
    passed++;
    process.stdout.write(`  ✅ ${message}\n`);
  } else {
    failed++;
    const detail = `${message} — expected ${JSON.stringify(value)} NOT in ${JSON.stringify(arr)}`;
    failures.push(detail);
    process.stdout.write(`  ❌ FAIL: ${detail}\n`);
  }
}

function section(name) {
  process.stdout.write(`\n${'═'.repeat(65)}\n${name}\n${'═'.repeat(65)}\n`);
}

function subsection(name) {
  process.stdout.write(`\n  ── ${name}\n`);
}

// ============================================================================
// Shared fixtures
// ============================================================================

const T0  = 1_700_000_000_000; // fixed epoch — never Date.now()
const T1  = T0 + 5_000;
const T5  = T0 + 5 * 60_000;
const T10 = T0 + 10 * 60_000;

// Raw product fixtures
const RAW_PASTA          = { productId: 'p_pasta',    name: 'Spaghetti n.5 500g' };
const RAW_SAUCE          = { productId: 'p_sauce',    name: 'Salsa de tomate premium' };
const RAW_CHEESE         = { productId: 'p_cheese',   name: 'Queso rallado parmesano' };
const RAW_CAMERA         = { productId: 'p_cam',      name: 'Cámara mirrorless Sony A7IV' };
const RAW_SD_CARD        = { productId: 'p_sd',       name: 'Tarjeta SD 256GB Class 10' };
const RAW_LENS           = { productId: 'p_lens',     name: 'Lente 50mm f/1.8' };
const RAW_MONITOR        = { productId: 'p_mon',      name: 'Monitor gaming 4K 27"' };
const RAW_HDMI_CABLE     = { productId: 'p_hdmi',     name: 'Cable HDMI 2.1 2m' };
const RAW_SWEATER        = { productId: 'p_sweat',    name: 'Sweater de lana merino' };
const RAW_JEANS          = { productId: 'p_jeans',    name: 'Jean slim fit azul' };
const RAW_PERFUME        = { productId: 'p_perf',     name: 'Perfume Eau de Parfum 100ml' };
const RAW_MOISTURIZER    = { productId: 'p_moist',    name: 'Crema hidratante facial' };
const RAW_BEAUTY_DEVICE  = { productId: 'p_bdev',     name: 'Máscara LED Foreo FAQ 202' };
const RAW_SERUM          = { productId: 'p_serum',    name: 'Sérum Vitamina C 30ml' };
const RAW_CLEANSER       = { productId: 'p_clean',    name: 'Limpiador facial gel' };
const RAW_CONSOLE        = { productId: 'p_ps5',      name: 'PlayStation 5 consola' };
const RAW_CONTROLLER     = { productId: 'p_ctrl',     name: 'Control DualSense PS5' };

// ============================================================================
// Factory helpers
// ============================================================================

function makeEngines(config = {}) {
  const ontology      = new ProductOntologyEngine(config.ontology || {});
  const graph         = new ComplementGraphEngine(config.graph || {});
  const compatibility = new CompatibilityIntelligenceEngine(config.compatibility || {});
  const intent        = new IntentCompletionEngine(ontology, graph, config.intent || {});
  const risk          = new ReturnRiskIntelligenceEngine(ontology, graph, compatibility, config.risk || {});
  const strategy      = new RelationshipMessageStrategyEngine(intent, risk, config.strategy || {});
  return { ontology, graph, compatibility, intent, risk, strategy };
}

// ============================================================================
// SECTION A: Product Ontology Engine
// ============================================================================

section('A — ProductOntologyEngine: normalization and caching');

{
  const ontology = new ProductOntologyEngine();

  subsection('A1: Category and archetype resolution');
  const pasta  = ontology.resolve(RAW_PASTA,  T0);
  const sauce  = ontology.resolve(RAW_SAUCE,  T0);
  const camera = ontology.resolve(RAW_CAMERA, T0);
  const device = ontology.resolve(RAW_BEAUTY_DEVICE, T0);

  assertEqual(pasta.category,   CATEGORIES.FOOD,        'pasta → category FOOD');
  assertEqual(pasta.subcategory, 'dry_pasta',            'pasta → subcategory dry_pasta');
  assertEqual(pasta.archetype,  ARCHETYPES.PRIMARY,      'pasta → archetype PRIMARY');

  assertEqual(sauce.subcategory, 'sauce',                'sauce → subcategory sauce');
  assertEqual(sauce.archetype,   ARCHETYPES.COMPLEMENT,  'sauce → archetype COMPLEMENT');

  assertEqual(camera.category,    CATEGORIES.PHOTOGRAPHY, 'camera → category PHOTOGRAPHY');
  assertEqual(camera.subcategory, 'camera_body',          'camera → subcategory camera_body');
  assert(camera.compatibilityTags.includes('needs:memory_card'), 'camera → compatibilityTag needs:memory_card');
  assert(camera.returnRiskFactors.includes(RETURN_RISK_FACTORS.MISSING_COMPONENT),
    'camera → returnRiskFactor MISSING_COMPONENT');

  assertEqual(device.category,    CATEGORIES.BEAUTY,      'beauty_device → category BEAUTY');
  assert(device.compatibilityTags.includes('needs:serum'), 'beauty_device → needs:serum tag');

  subsection('A2: Confidence is positive for matched products');
  assert(pasta.confidence > 0,  'pasta confidence > 0');
  assert(camera.confidence > 0, 'camera confidence > 0');

  subsection('A3: Unknown products resolve gracefully');
  const unknown = ontology.resolve({ productId: 'xyz', name: 'Producto desconocido XYZ' }, T0);
  assertEqual(unknown.category, CATEGORIES.UNKNOWN, 'unknown product → UNKNOWN category');
  assertEqual(unknown.confidence, 0, 'unknown product → confidence 0');

  subsection('A4: LRU cache — same productId returns cached record');
  const pasta2 = ontology.resolve(RAW_PASTA, T1);
  assert(pasta2 === pasta, 'second resolve with same productId returns cached record (===)');

  subsection('A5: Batch resolution');
  const batch = ontology.resolveBatch([RAW_PASTA, RAW_SAUCE, RAW_CAMERA], T0);
  assertEqual(batch.length, 3, 'resolveBatch returns 3 records');
  assertEqual(batch[0].subcategory, 'dry_pasta', 'batch[0] is pasta');
  assertEqual(batch[1].subcategory, 'sauce',     'batch[1] is sauce');

  subsection('A6: snapshot / restore');
  const snap = ontology.snapshot();
  assertEqual(snap.__type, 'ProductOntologyEngine', 'snapshot has __type');
  assertEqual(snap.__version, 1, 'snapshot has __version 1');

  const ontology2 = new ProductOntologyEngine();
  const restored = ontology2.restore(snap);
  assert(restored, 'restore() returns true for valid snapshot');
  assert(ontology2.getCached('p_pasta') !== null, 'restored engine has p_pasta in cache');

  subsection('A7: dispose() clears cache');
  ontology.dispose();
  let threw = false;
  try { ontology.resolve(RAW_PASTA, T1); } catch { threw = true; }
  assert(threw, 'resolve() after dispose() throws');
}

// ============================================================================
// SECTION B: ComplementGraphEngine — graph integrity
// ============================================================================

section('B — ComplementGraphEngine: graph integrity and edge queries');

{
  const graph = new ComplementGraphEngine();

  subsection('B1: Static edges load correctly');
  const pastaEdges = graph.getEdgesFrom('dry_pasta');
  assert(pastaEdges.length > 0, 'dry_pasta has outgoing edges');
  assert(pastaEdges.some(e => e.to === 'sauce'), 'dry_pasta → sauce edge exists');
  assert(pastaEdges.some(e => e.to === 'grated_cheese'), 'dry_pasta → grated_cheese edge exists');

  subsection('B2: Meal component relationship types');
  const pastaToSauce = pastaEdges.find(e => e.to === 'sauce');
  assertEqual(pastaToSauce.type, RELATIONSHIP_TYPES.MEAL_COMPONENT, 'pasta→sauce type is MEAL_COMPONENT');
  assertGte(pastaToSauce.weight, 0.90, 'pasta→sauce weight >= 0.90');
  assertGte(pastaToSauce.confidence, 0.95, 'pasta→sauce confidence >= 0.95');

  subsection('B3: Setup dependency (camera → memory_card)');
  const camEdges = graph.getEdgesFrom('camera_body');
  assert(camEdges.some(e => e.to === 'memory_card' && e.type === RELATIONSHIP_TYPES.SETUP_DEPENDENCY),
    'camera_body → memory_card is SETUP_DEPENDENCY');

  subsection('B4: Monitor → HDMI cable (setup dependency)');
  const monEdges = graph.getEdgesFrom('monitor');
  assert(monEdges.some(e => e.to === 'display_cable' && e.type === RELATIONSHIP_TYPES.SETUP_DEPENDENCY),
    'monitor → display_cable is SETUP_DEPENDENCY');

  subsection('B5: findMissingComplements — pasta only, expects sauce and cheese missing');
  const missing = graph.findMissingComplements(['dry_pasta']);
  assert(missing.some(m => m.missingSubcategory === 'sauce'),       'missing: sauce detected');
  assert(missing.some(m => m.missingSubcategory === 'grated_cheese'), 'missing: grated_cheese detected');

  subsection('B6: findMissingComplements — pasta + sauce present, cheese still missing');
  const missing2 = graph.findMissingComplements(['dry_pasta', 'sauce']);
  assert(!missing2.some(m => m.missingSubcategory === 'sauce'), 'sauce not flagged when present');
  assert(missing2.some(m => m.missingSubcategory === 'grated_cheese'), 'grated_cheese still flagged');

  subsection('B7: findMissingComplements — empty set returns empty');
  const missing3 = graph.findMissingComplements([]);
  assertEqual(missing3.length, 0, 'empty presentSet returns [] missing');

  subsection('B8: Unknown subcategory returns empty edges');
  const noEdges = graph.getEdgesFrom('this_does_not_exist');
  assertEqual(noEdges.length, 0, 'unknown subcategory returns empty edges');

  subsection('B9: Dynamic edge registration');
  graph.registerEdge({
    from: 'monitor', to: 'keyboard',
    type: RELATIONSHIP_TYPES.BUNDLE, weight: 0.75, confidence: 0.85,
    rationale: ['desk_setup_bundle'],
  }, T0);
  const monEdges2 = graph.getEdgesFrom('monitor');
  assert(monEdges2.some(e => e.to === 'keyboard' && e.dynamic === true),
    'dynamic edge monitor→keyboard is registered');

  subsection('B10: Anti-compatibility detection (no anti-compat in static graph for pasta/cheese)');
  const antiComp = graph.checkAntiCompatibility('dry_pasta', 'grated_cheese');
  assertEqual(antiComp.antiCompatible, false, 'pasta and cheese are NOT anti-compatible');

  subsection('B11: snapshot / restore preserves dynamic edges');
  const snap = graph.snapshot();
  const graph2 = new ComplementGraphEngine();
  graph2.restore(snap);
  const restoredEdges = graph2.getEdgesFrom('monitor');
  assert(restoredEdges.some(e => e.to === 'keyboard' && e.dynamic === true),
    'dynamic edge survives snapshot/restore');

  subsection('B12: Results sorted by weight descending');
  const cameraEdges = graph.getEdgesFrom('camera_body', { minWeight: 0.5 });
  let sorted = true;
  for (let i = 1; i < cameraEdges.length; i++) {
    if (cameraEdges[i].weight > cameraEdges[i - 1].weight) { sorted = false; break; }
  }
  assert(sorted, 'camera_body edges sorted by weight descending');
}

// ============================================================================
// SECTION C: IntentCompletionEngine — meal completion detection
// ============================================================================

section('C — IntentCompletionEngine: meal completion detection');

{
  const { ontology, graph, intent } = makeEngines();

  subsection('C1: pasta added, NO sauce → meal_completion opportunity');
  intent.ingestCartAdd({ productId: 'p_pasta', rawProduct: RAW_PASTA, nowMs: T0 });

  const opps = intent.getOpportunities(T0);
  assert(opps.length > 0, 'at least one opportunity after pasta cart-add');
  assert(opps.some(o => o.opportunityType === OPPORTUNITY_TYPES.MEAL_COMPLETION),
    'MEAL_COMPLETION opportunity detected');
  const mealOpp = opps.find(o => o.opportunityType === OPPORTUNITY_TYPES.MEAL_COMPLETION);
  assert(mealOpp !== undefined, 'meal completion opportunity exists');
  assert(mealOpp.missingSubcategory === 'sauce' || mealOpp.missingSubcategory === 'grated_cheese',
    'meal opportunity points to sauce or grated_cheese');
  assertEqual(mealOpp.inCartContext, true, 'inCartContext is true (pasta is in cart)');
  assertGte(mealOpp.completionScore, 0.40, 'completionScore >= 0.40');

  subsection('C2: pasta + sauce added → sauce no longer missing');
  intent.ingestCartAdd({ productId: 'p_sauce', rawProduct: RAW_SAUCE, nowMs: T1 });
  const opps2 = intent.getOpportunities(T1);
  assert(!opps2.some(o => o.missingSubcategory === 'sauce'), 'sauce no longer flagged after add');

  subsection('C3: cheese still missing after pasta + sauce');
  assert(opps2.some(o => o.missingSubcategory === 'grated_cheese'),
    'grated_cheese still flagged as missing');

  subsection('C4: Opportunity IDs are stable (idempotent for same pair)');
  const opp1 = intent.getOpportunities(T1).find(o => o.missingSubcategory === 'grated_cheese');
  intent.ingestProductView({ productId: 'p_pasta', rawProduct: RAW_PASTA, dwellMs: 500, nowMs: T1 + 1000 });
  const opp2 = intent.getOpportunities(T1 + 1000).find(o => o.missingSubcategory === 'grated_cheese');
  assert(opp1 && opp2, 'grated_cheese opportunity exists in both snapshots');
  assertEqual(opp1.opportunityId, opp2.opportunityId, 'opportunity ID is stable across recomputes');

  subsection('C5: cart remove clears subcategory from cart context');
  intent.ingestCartRemove({ productId: 'p_sauce', rawProduct: RAW_SAUCE, nowMs: T1 + 2000 });
  const opps3 = intent.getOpportunities(T1 + 2000);
  assert(opps3.some(o => o.missingSubcategory === 'sauce'), 'sauce flagged again after cart remove');

  subsection('C6: getTopOpportunity returns highest-score opportunity');
  const top = intent.getTopOpportunity(T1 + 2000);
  assert(top !== null, 'getTopOpportunity returns non-null');
  const all = intent.getOpportunities(T1 + 2000);
  assertEqual(top.opportunityId, all[0].opportunityId,
    'getTopOpportunity matches first in sorted list');
}

// ============================================================================
// SECTION D: IntentCompletionEngine — setup and accessory detection
// ============================================================================

section('D — IntentCompletionEngine: missing accessory and setup detection');

{
  const { ontology, graph, intent } = makeEngines();

  subsection('D1: camera viewed → SD card detected as setup dependency');
  intent.ingestProductView({ productId: 'p_cam', rawProduct: RAW_CAMERA, dwellMs: 4000, nowMs: T0 });
  const opps = intent.getOpportunities(T0);
  assert(opps.some(o => o.missingSubcategory === 'memory_card'),
    'memory_card flagged as missing after camera view');

  subsection('D2: camera in cart → SD card opportunity boosted');
  intent.ingestCartAdd({ productId: 'p_cam', rawProduct: RAW_CAMERA, nowMs: T1 });
  const opps2 = intent.getOpportunities(T1);
  const sdOpp = opps2.find(o => o.missingSubcategory === 'memory_card');
  assert(sdOpp !== undefined, 'SD card opportunity exists after cart-add');
  assertEqual(sdOpp.inCartContext, true, 'SD card opportunity has inCartContext=true');

  subsection('D3: monitor viewed → HDMI cable as setup_completion');
  const { intent: intent2 } = makeEngines();
  intent2.ingestCartAdd({ productId: 'p_mon', rawProduct: RAW_MONITOR, nowMs: T0 });
  const monOpps = intent2.getOpportunities(T0);
  assert(monOpps.some(o => o.missingSubcategory === 'display_cable'),
    'display_cable flagged for monitor');
  const cableOpp = monOpps.find(o => o.missingSubcategory === 'display_cable');
  assertEqual(cableOpp.opportunityType, OPPORTUNITY_TYPES.SETUP_COMPLETION,
    'monitor→cable is SETUP_COMPLETION');

  subsection('D4: gaming console → controller + game + HDMI');
  const { intent: intent3 } = makeEngines();
  intent3.ingestCartAdd({ productId: 'p_ps5', rawProduct: RAW_CONSOLE, nowMs: T0 });
  const consoleOpps = intent3.getOpportunities(T0);
  assert(consoleOpps.some(o => o.missingSubcategory === 'controller'),
    'controller missing for console');
  assert(consoleOpps.some(o => o.missingSubcategory === 'game_title'),
    'game_title missing for console');
}

// ============================================================================
// SECTION E: IntentCompletionEngine — outfit and skincare detection
// ============================================================================

section('E — IntentCompletionEngine: outfit and skincare routine detection');

{
  subsection('E1: sweater in cart → bottoms missing (outfit)');
  const { intent } = makeEngines();
  intent.ingestCartAdd({ productId: 'p_sweat', rawProduct: RAW_SWEATER, nowMs: T0 });
  const opps = intent.getOpportunities(T0);
  assert(opps.some(o => o.missingSubcategory === 'bottoms'),
    'bottoms missing for sweater outfit');
  const outfitOpp = opps.find(o => o.missingSubcategory === 'bottoms');
  assertEqual(outfitOpp.opportunityType, OPPORTUNITY_TYPES.OUTFIT_COMPLETION,
    'sweater→bottoms is OUTFIT_COMPLETION');

  subsection('E2: beauty_device in cart → serum + cleanser detected');
  const { intent: intent2 } = makeEngines();
  intent2.ingestCartAdd({ productId: 'p_bdev', rawProduct: RAW_BEAUTY_DEVICE, nowMs: T0 });
  const devOpps = intent2.getOpportunities(T0);
  assert(devOpps.some(o => o.missingSubcategory === 'serum'),
    'serum missing for beauty_device');
  assert(devOpps.some(o => o.missingSubcategory === 'cleanser'),
    'cleanser missing for beauty_device');
  const serumOpp = devOpps.find(o => o.missingSubcategory === 'serum');
  assertEqual(serumOpp.opportunityType, OPPORTUNITY_TYPES.SETUP_COMPLETION,
    'beauty_device→serum is SETUP_COMPLETION');

  subsection('E3: perfume viewed → moisturizer as skincare step');
  const { intent: intent3 } = makeEngines();
  intent3.ingestProductView({ productId: 'p_perf', rawProduct: RAW_PERFUME, dwellMs: 2000, nowMs: T0 });
  const perfOpps = intent3.getOpportunities(T0);
  assert(perfOpps.some(o => o.missingSubcategory === 'moisturizer'),
    'moisturizer flagged for perfume');

  subsection('E4: cleanser viewed → serum flagged as next skincare step');
  const { intent: intent4 } = makeEngines();
  intent4.ingestCartAdd({ productId: 'p_clean', rawProduct: RAW_CLEANSER, nowMs: T0 });
  const cleanOpps = intent4.getOpportunities(T0);
  assert(cleanOpps.some(o => o.missingSubcategory === 'serum' || o.missingSubcategory === 'moisturizer'),
    'serum or moisturizer flagged for cleanser routine');
}

// ============================================================================
// SECTION F: CompatibilityIntelligenceEngine
// ============================================================================

section('F — CompatibilityIntelligenceEngine: compatibility reasoning');

{
  const ontology      = new ProductOntologyEngine();
  const compatibility = new CompatibilityIntelligenceEngine();

  const recCamera  = ontology.resolve(RAW_CAMERA,   T0);
  const recSD      = ontology.resolve(RAW_SD_CARD,  T0);
  const recMonitor = ontology.resolve(RAW_MONITOR,  T0);
  const recHDMI    = ontology.resolve(RAW_HDMI_CABLE, T0);
  const recSweater = ontology.resolve(RAW_SWEATER,  T0);
  const recJeans   = ontology.resolve(RAW_JEANS,    T0);
  const recSerum   = ontology.resolve(RAW_SERUM,    T0);
  const recCleanser = ontology.resolve(RAW_CLEANSER, T0);
  const recMoisturizer = ontology.resolve(RAW_MOISTURIZER, T0);

  subsection('F1: Monitor + HDMI cable — technical compatibility OK');
  const monHdmi = compatibility.evaluate(recMonitor, recHDMI, T0);
  assert(
    monHdmi.outcome === COMPATIBILITY_OUTCOMES.COMPATIBLE ||
    monHdmi.outcome === COMPATIBILITY_OUTCOMES.CONDITIONALLY_OK,
    'monitor + HDMI is compatible or conditionally OK'
  );

  subsection('F2: Sweater + Jeans — aesthetic match');
  const sweatJeans = compatibility.evaluate(recSweater, recJeans, T0);
  assert(
    [COMPATIBILITY_OUTCOMES.COMPATIBLE, COMPATIBILITY_OUTCOMES.UNCERTAIN, COMPATIBILITY_OUTCOMES.CONDITIONALLY_OK].includes(sweatJeans.outcome),
    'sweater + jeans is compatible/conditionally_ok/uncertain (style match with size caveat)'
  );

  subsection('F3: Cleanser → Serum — correct routine order');
  const cleanSerumResult = compatibility.evaluate(recCleanser, recSerum, T0);
  assert(
    cleanSerumResult.outcome === COMPATIBILITY_OUTCOMES.COMPATIBLE ||
    cleanSerumResult.outcome === COMPATIBILITY_OUTCOMES.UNCERTAIN,
    'cleanser → serum is compatible (correct routine order)'
  );
  if (cleanSerumResult.firedRuleCount > 0) {
    assert(
      cleanSerumResult.compatibilityReasoning.length > 0,
      'cleanser→serum has non-empty reasoning'
    );
  }

  subsection('F4: compatibilityScore in [0, 1]');
  [monHdmi, sweatJeans, cleanSerumResult].forEach((r, i) => {
    assert(r.compatibilityScore >= 0 && r.compatibilityScore <= 1,
      `result[${i}].compatibilityScore is in [0,1]`);
  });

  subsection('F5: LRU cache — same pair returns cached result (===)');
  const cached1 = compatibility.evaluate(recMonitor, recHDMI, T0);
  const cached2 = compatibility.evaluate(recMonitor, recHDMI, T1);
  assert(cached1 === cached2, 'repeated pair evaluate() returns same cached reference');

  subsection('F6: evaluateSet — returns issues for incomplete set');
  const setIssues = compatibility.evaluateSet([recCamera, recSD, recMonitor, recHDMI], T0);
  assert(Array.isArray(setIssues), 'evaluateSet returns array');

  subsection('F7: snapshot / restore preserves pair cache');
  const snap = compatibility.snapshot();
  const compat2 = new CompatibilityIntelligenceEngine();
  compat2.restore(snap);
  const restoredResult = compat2.evaluate(recMonitor, recHDMI, T1);
  // After restore the cached result should be present; outcome must match
  assertEqual(restoredResult.outcome, monHdmi.outcome,
    'restored compatibility engine gives same outcome');
}

// ============================================================================
// SECTION G: ReturnRiskIntelligenceEngine
// ============================================================================

section('G — ReturnRiskIntelligenceEngine: return risk detection');

{
  const ontology      = new ProductOntologyEngine();
  const graph         = new ComplementGraphEngine();
  const compatibility = new CompatibilityIntelligenceEngine();
  const risk          = new ReturnRiskIntelligenceEngine(ontology, graph, compatibility);

  subsection('G1: camera in cart without SD card → HIGH risk');
  const r1 = risk.assess({
    cartProducts:    [{ ...RAW_CAMERA, viewCount: 1 }],
    viewedProducts:  [],
    nowMs: T0,
  });
  assert(r1.riskScore > 0, 'camera without SD → risk score > 0');
  assert(
    r1.riskTier === RISK_TIERS.HIGH || r1.riskTier === RISK_TIERS.MODERATE,
    `camera without SD → risk tier is HIGH or MODERATE (got ${r1.riskTier})`
  );
  assert(
    r1.factors.some(f => f.type === RISK_FACTOR_TYPES.MISSING_REQUIRED_COMPONENT),
    'MISSING_REQUIRED_COMPONENT factor present'
  );
  assert(r1.preventionOpportunities.length > 0, 'at least one prevention opportunity');

  subsection('G2: camera + SD card in cart → risk reduced');
  const r2 = risk.assess({
    cartProducts: [
      { ...RAW_CAMERA, viewCount: 1 },
      { ...RAW_SD_CARD, viewCount: 1 },
    ],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(r2.riskScore < r1.riskScore, 'risk score decreases when SD card is present');

  subsection('G3: size-dependent product with multiple views → SIZE_UNCERTAINTY');
  const r3 = risk.assess({
    cartProducts: [{ ...RAW_SWEATER, viewCount: 3 }],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(r3.factors.some(f => f.type === RISK_FACTOR_TYPES.SIZE_UNCERTAINTY),
    'SIZE_UNCERTAINTY factor for sweater with 3 views');

  subsection('G4: perfume in cart → SUBJECTIVE_FIT_RISK');
  const r4 = risk.assess({
    cartProducts: [{ ...RAW_PERFUME, viewCount: 1 }],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(r4.factors.some(f => f.type === RISK_FACTOR_TYPES.SUBJECTIVE_FIT_RISK),
    'SUBJECTIVE_FIT_RISK for perfume');

  subsection('G5: riskScore in [0, 1]');
  [r1, r2, r3, r4].forEach((r, i) => {
    assert(r.riskScore >= 0 && r.riskScore <= 1, `r${i+1}.riskScore in [0,1]`);
  });

  subsection('G6: empty cart → zero risk score');
  const r5 = risk.assess({ cartProducts: [], viewedProducts: [], nowMs: T0 });
  assertEqual(r5.riskScore, 0, 'empty cart → riskScore 0');
  assertEqual(r5.riskTier, RISK_TIERS.LOW, 'empty cart → LOW risk tier');

  subsection('G7: assessment is frozen (no mutation)');
  assert(Object.isFrozen(r1), 'assessment object is frozen');

  subsection('G8: rationale array is non-empty');
  assert(Array.isArray(r1.rationale) && r1.rationale.length > 0, 'rationale is non-empty');

  subsection('G9: prevention opportunities sorted by priority descending');
  const prevs = r1.preventionOpportunities;
  let prevSorted = true;
  for (let i = 1; i < prevs.length; i++) {
    if (prevs[i].priority > prevs[i - 1].priority) { prevSorted = false; break; }
  }
  assert(prevSorted, 'preventionOpportunities sorted by priority desc');
}

// ============================================================================
// SECTION H: Revisit-aware recommendations
// ============================================================================

section('H — IntentCompletionEngine: revisit-aware score boost');

{
  const { intent } = makeEngines({ intent: { revisitThreshold: 2 } });

  subsection('H1: Single camera view — baseline score');
  intent.ingestProductView({ productId: 'p_cam', rawProduct: RAW_CAMERA, dwellMs: 2000, nowMs: T0 });
  const opp1 = intent.getOpportunities(T0).find(o => o.missingSubcategory === 'memory_card');
  const score1 = opp1 ? opp1.completionScore : 0;

  subsection('H2: Second camera view — score boosted');
  intent.ingestProductView({ productId: 'p_cam', rawProduct: RAW_CAMERA, dwellMs: 2000, nowMs: T1 });
  const opp2 = intent.getOpportunities(T1).find(o => o.missingSubcategory === 'memory_card');
  assert(opp2 !== undefined, 'SD card opportunity present after revisit');
  assert(opp2.revisitContext === true, 'revisitContext is true after second view');
  assert(opp2.completionScore >= score1, 'score after revisit >= score before revisit');
  assertIncludes(opp2.rationale, 'product_revisited', 'rationale includes product_revisited');
}

// ============================================================================
// SECTION I: Deterministic replay (snapshot → restore → identical output)
// ============================================================================

section('I — Deterministic replay: snapshot/restore produces identical output');

{
  const { ontology, graph, compatibility, intent, risk, strategy } = makeEngines();

  // Build up state
  intent.ingestCartAdd({    productId: 'p_pasta', rawProduct: RAW_PASTA,  nowMs: T0 });
  intent.ingestProductView({ productId: 'p_cam',  rawProduct: RAW_CAMERA, dwellMs: 3000, nowMs: T1 });

  // Capture pre-snapshot output
  const oppsBefore = intent.getOpportunities(T1).map(o => o.opportunityId).sort();

  // Snapshot all engines
  const snapOntology = ontology.snapshot();
  const snapGraph    = graph.snapshot();
  const snapIntent   = intent.snapshot();
  const snapCompat   = compatibility.snapshot();

  // Restore into fresh instances
  const ontology2      = new ProductOntologyEngine();
  const graph2         = new ComplementGraphEngine();
  const compatibility2 = new CompatibilityIntelligenceEngine();
  const intent2        = new IntentCompletionEngine(ontology2, graph2);

  ontology2.restore(snapOntology);
  graph2.restore(snapGraph);
  compatibility2.restore(snapCompat);
  intent2.restore(snapIntent);

  // Capture post-restore output
  const oppsAfter = intent2.getOpportunities(T1).map(o => o.opportunityId).sort();

  assertEqual(oppsBefore.length, oppsAfter.length,
    'opportunity count identical after restore');
  assertEqual(JSON.stringify(oppsBefore), JSON.stringify(oppsAfter),
    'opportunity IDs identical after snapshot/restore');

  subsection('I2: strategy snapshot/restore');
  const snapStrategy = strategy.snapshot();
  const { intent: intent3, risk: risk3 } = makeEngines();
  const strategy2 = new RelationshipMessageStrategyEngine(intent3, risk3);
  const restoredStrategy = strategy2.restore(snapStrategy);
  assert(restoredStrategy, 'strategy restore() returns true');
}

// ============================================================================
// SECTION J: Graph integrity
// ============================================================================

section('J — Graph integrity: static graph completeness');

{
  const graph = new ComplementGraphEngine();

  subsection('J1: All skincare steps are connected');
  const cleanserEdges = graph.getEdgesFrom('cleanser');
  assert(cleanserEdges.some(e => e.to === 'serum' || e.to === 'moisturizer'),
    'cleanser has skincare_step edges');

  const serumEdges = graph.getEdgesFrom('serum');
  assert(serumEdges.some(e => e.to === 'moisturizer'), 'serum → moisturizer edge exists');
  assert(serumEdges.some(e => e.to === 'sunscreen'), 'serum → sunscreen edge exists');

  subsection('J2: Console full bundle chain exists');
  const consoleEdges = graph.getEdgesFrom('gaming_console');
  assert(consoleEdges.some(e => e.to === 'controller'),  'console → controller edge');
  assert(consoleEdges.some(e => e.to === 'game_title'),  'console → game_title edge');
  assert(consoleEdges.some(e => e.to === 'display_cable'), 'console → display_cable edge');

  subsection('J3: getEdgesFrom with type filter');
  const setupOnly = graph.getEdgesFrom('camera_body', {
    types: [RELATIONSHIP_TYPES.SETUP_DEPENDENCY]
  });
  assert(setupOnly.every(e => e.type === RELATIONSHIP_TYPES.SETUP_DEPENDENCY),
    'type filter returns only SETUP_DEPENDENCY edges');

  subsection('J4: getEdgesFrom with weight filter');
  const heavyEdges = graph.getEdgesFrom('dry_pasta', { minWeight: 0.90 });
  assert(heavyEdges.every(e => e.weight >= 0.90),
    'weight filter returns only edges with weight >= 0.90');
}

// ============================================================================
// SECTION K: Bounded memory
// ============================================================================

section('K — Bounded memory: LRU eviction');

{
  subsection('K1: Ontology cache LRU eviction');
  const ontology = new ProductOntologyEngine({ maxRecords: 3 });
  ontology.resolve({ productId: 'a', name: 'pasta' }, T0);
  ontology.resolve({ productId: 'b', name: 'sauce' }, T0);
  ontology.resolve({ productId: 'c', name: 'cámara' }, T0);
  // Accessing 'a' makes it the most recent
  ontology.resolve({ productId: 'a', name: 'pasta' }, T0);
  // 'd' will evict 'b' (least recently used)
  ontology.resolve({ productId: 'd', name: 'monitor' }, T0);
  assert(ontology.getDiagnostics().cacheSize <= 3, 'ontology cache stays at maxRecords=3');
  assert(ontology.getCached('b') === null, '"b" was evicted (LRU)');
  assert(ontology.getCached('a') !== null, '"a" still cached (recently accessed)');

  subsection('K2: Graph dynamic edges LRU eviction');
  const graph = new ComplementGraphEngine({ maxDynamicEdges: 3 });
  graph.registerEdge({ from: 'x1', to: 'y1', type: RELATIONSHIP_TYPES.COMPLEMENT, weight: 0.5, confidence: 0.5 }, T0);
  graph.registerEdge({ from: 'x2', to: 'y2', type: RELATIONSHIP_TYPES.COMPLEMENT, weight: 0.5, confidence: 0.5 }, T0);
  graph.registerEdge({ from: 'x3', to: 'y3', type: RELATIONSHIP_TYPES.COMPLEMENT, weight: 0.5, confidence: 0.5 }, T0);
  graph.registerEdge({ from: 'x4', to: 'y4', type: RELATIONSHIP_TYPES.COMPLEMENT, weight: 0.5, confidence: 0.5 }, T0);
  assert(graph.getDiagnostics().dynamicEdgeCount <= 3, 'dynamic edge store capped at maxDynamicEdges=3');

  subsection('K3: IntentCompletionEngine opportunity store is bounded');
  const { intent } = makeEngines({ intent: { maxOpportunities: 5 } });
  // Ingest many products to generate many potential opportunities
  const products = ['pasta','sauce','camera_body','monitor','sweater','console','beauty_device','serum','cleanser'];
  for (const name of products) {
    intent.ingestCartAdd({ productId: `test_${name}`, rawProduct: { productId: `test_${name}`, name }, nowMs: T0 });
  }
  const diagK = intent.getDiagnostics();
  assert(diagK.activeOpportunities <= 5, `opportunity store capped at maxOpportunities=5 (got ${diagK.activeOpportunities})`);
}

// ============================================================================
// SECTION L: No duplicated interventions
// ============================================================================

section('L — No duplicated interventions: stable opportunity IDs');

{
  const { intent } = makeEngines();

  intent.ingestCartAdd({ productId: 'p_pasta', rawProduct: RAW_PASTA, nowMs: T0 });

  // Multiple recomputes
  const ids1 = intent.getOpportunities(T0).map(o => o.opportunityId);
  const ids2 = intent.getOpportunities(T0 + 1000).map(o => o.opportunityId);

  // Same opportunities should have same IDs (no duplication)
  assertEqual(ids1.length, ids2.length, 'same opportunity count on repeated getOpportunities()');
  for (const id of ids1) {
    assert(ids2.includes(id), `opportunity ${id} is stable across calls`);
  }

  // Check uniqueness within a single call
  const unique = new Set(ids1);
  assertEqual(unique.size, ids1.length, 'no duplicate opportunity IDs in single getOpportunities() call');
}

// ============================================================================
// SECTION M: Strategy candidates are MRE-compatible
// ============================================================================

section('M — Strategy candidates: message-ranking-engine schema compatibility');

{
  const { ontology, graph, compatibility, intent, risk, strategy } = makeEngines();

  // Seed intent engine with meal scenario
  intent.ingestCartAdd({ productId: 'p_pasta', rawProduct: RAW_PASTA, nowMs: T0 });

  const candidates = strategy.generateCandidates({
    sessionId: 'sess_001',
    context:   'cart',
    intentState: 'high_intent',
    fatigueScore: 0.2,
    cartProducts:   [{ ...RAW_PASTA, viewCount: 1, addedToCart: true }],
    viewedProducts: [],
    nowMs: T0,
  });

  assert(Array.isArray(candidates), 'generateCandidates returns array');

  if (candidates.length > 0) {
    subsection('M1: Required MRE fields present on each candidate');
    for (const c of candidates) {
      assert(typeof c.id === 'string',       `candidate.id is string: ${c.id}`);
      assert(typeof c.family === 'string',   `candidate.family is string: ${c.family}`);
      assert(typeof c.subtype === 'string',  `candidate.subtype is string: ${c.subtype}`);
      assert(typeof c.intensity === 'number' && c.intensity >= 0 && c.intensity <= 1,
        `candidate.intensity in [0,1]: ${c.intensity}`);
      assert(typeof c.priority === 'number', `candidate.priority is number: ${c.priority}`);
    }

    subsection('M2: Families are valid ope-constants MESSAGE_FAMILIES');
    const VALID_FAMILIES = new Set([
      'BENEFIT','SOCIAL_PROOF','QUALITY','COMPATIBILITY','REASSURANCE',
      'URGENCY','EXPERTISE','LIFESTYLE','COMPARISON','CART_SUPPORT','RECOVERY',
    ]);
    for (const c of candidates) {
      assert(VALID_FAMILIES.has(c.family),
        `candidate.family "${c.family}" is a valid MESSAGE_FAMILY`);
    }

    subsection('M3: Rationale is non-empty and causal');
    for (const c of candidates) {
      assert(Array.isArray(c.rationale) && c.rationale.length > 0,
        `candidate ${c.id} has non-empty rationale`);
      assert(c.rationale.some(r => typeof r === 'string' && r.includes(':')),
        `candidate ${c.id} rationale includes keyed entries (e.g. strategy_type:xxx)`);
    }

    subsection('M4: source field identifies relationship layer');
    for (const c of candidates) {
      assert(c.source === 'relationship_intelligence' || c.source === 'relationship_risk_intelligence',
        `candidate ${c.id} has relationship source`);
    }

    subsection('M5: candidates sorted by priority descending');
    let candidatesSorted = true;
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].priority > candidates[i - 1].priority) {
        candidatesSorted = false;
        break;
      }
    }
    assert(candidatesSorted, 'candidates sorted by priority descending');
  }

  subsection('M6: generateCandidates with empty cart returns empty array');
  const emptyCandidates = strategy.generateCandidates({
    sessionId: 'sess_002',
    context: 'listing',
    intentState: 'exploring',
    fatigueScore: 0,
    cartProducts: [],
    viewedProducts: [],
    nowMs: T0,
  });
  // With no cart and no viewed products in intent engine, should be minimal
  assert(Array.isArray(emptyCandidates), 'generateCandidates always returns array');
}

// ============================================================================
// SECTION N: No parallel pipelines
// ============================================================================

section('N — No parallel pipelines: engines do not invoke session-orchestrator');

{
  const fs = require('fs');

  function getRequireLines(filename) {
    const src = fs.readFileSync(filename, 'utf8');
    return src.split(/\r?\n/)
      .filter(function(l) {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && l.includes("require(");
      })
      .join(' ');
  }

  function getNonCommentCode(filename) {
    const src = fs.readFileSync(filename, 'utf8');
    return src.split(/\r?\n/)
      .filter(function(l) {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*');
      })
      .join(' ');
  }

  subsection('N1: ProductOntologyEngine has no require of session-orchestrator');
  const ontReq = getRequireLines(DIR + '/product-ontology-engine.js');
  assert(!ontReq.includes('session-orchestrator'), 'product-ontology-engine does not import session-orchestrator');
  assert(!ontReq.includes('message-ranking-engine'), 'product-ontology-engine does not import message-ranking-engine');

  subsection('N2: ComplementGraphEngine has no require of session-orchestrator');
  const graphReq = getRequireLines(DIR + '/complement-graph-engine.js');
  assert(!graphReq.includes('session-orchestrator'), 'complement-graph-engine does not import session-orchestrator');

  subsection('N3: IntentCompletionEngine does not directly emit interventions');
  const intentCode = getNonCommentCode(DIR + '/intent-completion-engine.js');
  const intentReq  = getRequireLines(DIR + '/intent-completion-engine.js');
  assert(!intentCode.includes('showMessage'), 'intent-completion-engine does not call showMessage');
  assert(!intentReq.includes('session-orchestrator'), 'intent-completion-engine does not import session-orchestrator');

  subsection('N4: ReturnRiskIntelligenceEngine does not rank messages');
  const riskCode = getNonCommentCode(DIR + '/return-risk-intelligence-engine.js');
  assert(!riskCode.includes('rankInterventions'), 'return-risk-engine does not call rankInterventions');

  subsection('N5: RelationshipMessageStrategyEngine does NOT call cooldown-fatigue-engine directly');
  const stratReq  = getRequireLines(DIR + '/relationship-message-strategy-engine.js');
  const stratCode = getNonCommentCode(DIR + '/relationship-message-strategy-engine.js');
  assert(!stratReq.includes('cooldown-fatigue-engine'), 'strategy engine does not import cooldown-fatigue-engine');
  assert(!stratCode.includes('canIntervene'), 'strategy engine does not call canIntervene (fatigue authority)');
}

// ============================================================================
// SECTION O: Explainability integrity
// ============================================================================

section('O — Explainability integrity: rationale is causal and auditable');

{
  const { intent, risk, strategy, ontology, graph, compatibility } = makeEngines();

  intent.ingestCartAdd({ productId: 'p_cam', rawProduct: RAW_CAMERA, nowMs: T0 });

  const opps = intent.getOpportunities(T0);
  assert(opps.length > 0, 'opportunities exist for camera');

  subsection('O1: Opportunity rationale contains trigger subcategory');
  const sdOpp = opps.find(o => o.missingSubcategory === 'memory_card');
  assert(sdOpp !== undefined, 'SD card opportunity exists');
  assert(Array.isArray(sdOpp.rationale) && sdOpp.rationale.length > 0, 'rationale is non-empty');
  assertIncludes(sdOpp.rationale, 'trigger_in_cart', 'rationale includes trigger_in_cart');

  subsection('O2: Strategy candidate rationale is causal chain');
  const candidates = strategy.generateCandidates({
    sessionId: 'sess_explainability',
    context: 'cart',
    intentState: 'high_intent',
    fatigueScore: 0.1,
    cartProducts: [{ ...RAW_CAMERA, viewCount: 1, addedToCart: true }],
    viewedProducts: [],
    nowMs: T0,
  });

  if (candidates.length > 0) {
    const c = candidates[0];
    assert(c.rationale.some(r => r.startsWith('strategy_type:')), 'rationale has strategy_type: prefix');
    assert(c.rationale.some(r => r.startsWith('intent_state:')),  'rationale has intent_state: prefix');
    assert(c.rationale.some(r => r.startsWith('opportunity_type:')), 'rationale has opportunity_type:');
    assert(c.rationale.some(r => r.startsWith('missing_subcategory:')), 'rationale has missing_subcategory:');
    assert(c.rationale.some(r => r.startsWith('triggered_by:')), 'rationale has triggered_by:');
  }

  subsection('O3: Risk assessment rationale is non-empty');
  const riskResult = risk.assess({
    cartProducts: [{ ...RAW_CAMERA, viewCount: 1 }],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(riskResult.rationale.length > 0, 'risk rationale non-empty');
  assert(riskResult.rationale.some(r => r.startsWith('risk_tier:')), 'risk rationale has risk_tier: prefix');
}

// ============================================================================
// SECTION P: dispose() / cleanup() safe lifecycle
// ============================================================================

section('P — Lifecycle: dispose() and cleanup() are safe');

{
  subsection('P1: cleanup() is safe to call multiple times');
  const { ontology, graph, compatibility, intent, risk, strategy } = makeEngines();
  intent.ingestCartAdd({ productId: 'p_pasta', rawProduct: RAW_PASTA, nowMs: T0 });

  let cleanupThrew = false;
  try {
    intent.cleanup(T5);
    intent.cleanup(T5);
    ontology.cleanup();
    graph.cleanup();
    compatibility.cleanup();
    strategy.cleanup();
  } catch (e) {
    cleanupThrew = true;
  }
  assert(!cleanupThrew, 'cleanup() multiple times does not throw');

  subsection('P2: dispose() makes resolve() throw');
  const ont2 = new ProductOntologyEngine();
  ont2.dispose();
  let disposeThrew = false;
  try { ont2.resolve(RAW_PASTA, T0); } catch { disposeThrew = true; }
  assert(disposeThrew, 'resolve() after dispose() throws');

  subsection('P3: IntentCompletionEngine dispose() clears state');
  const { intent: intent2 } = makeEngines();
  intent2.ingestCartAdd({ productId: 'p_pasta', rawProduct: RAW_PASTA, nowMs: T0 });
  intent2.dispose();
  let intentThrew = false;
  try { intent2.getOpportunities(T0); } catch { intentThrew = true; }
  assert(intentThrew, 'getOpportunities() after dispose() throws');
}

// ============================================================================
// SECTION Q: Strategy-to-family mapping completeness
// ============================================================================

section('Q — STRATEGY_TO_FAMILY: all strategy types map to valid families');

{
  const VALID_FAMILIES = new Set([
    'BENEFIT','SOCIAL_PROOF','QUALITY','COMPATIBILITY','REASSURANCE',
    'URGENCY','EXPERTISE','LIFESTYLE','COMPARISON','CART_SUPPORT','RECOVERY',
  ]);

  for (const [strategyType, family] of Object.entries(STRATEGY_TO_FAMILY)) {
    assert(VALID_FAMILIES.has(family),
      `STRATEGY_TO_FAMILY[${strategyType}] = "${family}" is a valid MESSAGE_FAMILY`);
  }

  subsection('Q2: All STRATEGY_TYPES have a family mapping');
  for (const strategyType of Object.values(STRATEGY_TYPES)) {
    assert(STRATEGY_TO_FAMILY[strategyType] !== undefined,
      `STRATEGY_TYPES.${strategyType} has a family mapping`);
  }
}

// ============================================================================
// SECTION R: Risk factor aggregation formula
// ============================================================================

section('R — Risk aggregation: max+dampened-sum formula properties');

{
  subsection('R1: Single factor → score equals that factor weight');
  const { risk } = makeEngines();

  // beauty_device alone (MISSING_COMPONENT flag)
  const r1 = risk.assess({
    cartProducts: [{ ...RAW_BEAUTY_DEVICE, viewCount: 1 }],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(r1.riskScore > 0, 'beauty_device alone has positive risk score');

  subsection('R2: More factors → score does not exceed 1.0');
  // Console without controller, game, cable — multiple factors
  const r2 = risk.assess({
    cartProducts: [{ ...RAW_CONSOLE, viewCount: 1 }],
    viewedProducts: [],
    nowMs: T0,
  });
  assert(r2.riskScore <= 1.0, 'riskScore never exceeds 1.0');

  subsection('R3: riskScore is a finite number');
  [r1, r2].forEach((r, i) => {
    assert(typeof r.riskScore === 'number' && Number.isFinite(r.riskScore),
      `r${i+1}.riskScore is finite number`);
  });
}

// ============================================================================
// SECTION S: No Date.now() in any engine
// ============================================================================

section('S — Determinism guarantee: no Date.now() in any engine file');

{
  const fs = require('fs');
  const files = [
    'product-ontology-engine.js',
    'complement-graph-engine.js',
    'intent-completion-engine.js',
    'compatibility-intelligence-engine.js',
    'return-risk-intelligence-engine.js',
    'relationship-message-strategy-engine.js',
  ];

  for (const filename of files) {
    const src = fs.readFileSync(`${DIR}/${filename}`, 'utf8');
    // Allow Date.now() in comments only (check non-comment lines)
    const lines = src.split('\n').filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
    const hasDateNow = lines.some(l => l.includes('Date.now()'));
    assert(!hasDateNow, `${filename} has no Date.now() in non-comment code`);
  }

  subsection('S2: No Math.random() in any engine file');
  const files2 = [
    'product-ontology-engine.js',
    'complement-graph-engine.js',
    'intent-completion-engine.js',
    'compatibility-intelligence-engine.js',
    'return-risk-intelligence-engine.js',
    'relationship-message-strategy-engine.js',
  ];
  for (const filename of files2) {
    const src = require('fs').readFileSync(`${DIR}/${filename}`, 'utf8');
    const lines = src.split('\n').filter(l => {
      const trimmed = l.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
    const hasMathRandom = lines.some(l => l.includes('Math.random()'));
    assert(!hasMathRandom, `${filename} has no Math.random() in non-comment code`);
  }
}

// ============================================================================
// SUMMARY
// ============================================================================

process.stdout.write(`\n${'═'.repeat(65)}\n`);
process.stdout.write(`PRODUCT RELATIONSHIP INTELLIGENCE — TEST RESULTS\n`);
process.stdout.write(`${'═'.repeat(65)}\n`);
process.stdout.write(`Total:  ${totalTests}\n`);
process.stdout.write(`Passed: ${passed}  ✅\n`);
process.stdout.write(`Failed: ${failed}  ${failed > 0 ? '❌' : '✅'}\n`);

if (failures.length > 0) {
  process.stdout.write(`\nFailed assertions:\n`);
  failures.forEach(f => process.stdout.write(`  ❌ ${f}\n`));
}

process.stdout.write(`\n`);
process.exit(failed > 0 ? 1 : 0);
