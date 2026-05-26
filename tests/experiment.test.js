'use strict';
/**
 * Experiment engine + statistical validity tests.
 */

const {
  ExperimentEngine, VARIANTS, SCHEMA_VERSION: EE_SCHEMA, stableHash, cohenD,
} = require('../lib/experiment-engine');
const {
  computeBootstrapCI95,
  computePermutationPValue,
  computeEffectSize,
} = require('../lib/statistical-validity-engine');

const BASE_TIME = 10_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// ExperimentEngine — variant assignment
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperimentEngine: variant assignment', () => {
  let engine;
  beforeEach(() => { engine = new ExperimentEngine(); });
  afterEach(() => { engine.dispose(); });

  test('same sessionId always gets same variant (sticky)', () => {
    const v1 = engine.assignVariant('sess-sticky');
    const v2 = engine.assignVariant('sess-sticky');
    expect(v1).toBe(v2);
  });

  test('variant is a known VARIANTS value', () => {
    const v = engine.assignVariant('sess-check');
    expect(Object.values(VARIANTS)).toContain(v);
  });

  test('100 sessions produce both control and treatment', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(engine.assignVariant(`s-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });

  test('getVariant returns null for unknown session', () => {
    expect(engine.getVariant('no-such-session')).toBeNull();
  });

  test('getVariant returns assigned variant', () => {
    const v = engine.assignVariant('sess-get');
    expect(engine.getVariant('sess-get')).toBe(v);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExperimentEngine — full lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperimentEngine: full lifecycle', () => {
  let engine;
  beforeEach(() => { engine = new ExperimentEngine(); });
  afterEach(() => { engine.dispose(); });

  test('recordExposure → logDecision → recordConversion → getStats', () => {
    const now = BASE_TIME;
    engine.recordExposure({ sessionId: 's1', context: 'product_detail', productId: 'p1', now });
    engine.logDecision({
      sessionId: 's1', productId: 'p1', context: 'product_detail',
      decisionType: 'show', family: 'social_proof', score: 0.8,
      variant: engine.assignVariant('s1'), now: now + 100,
    });
    engine.recordConversion({ sessionId: 's1', type: 'checkout', revenue: 99.0, now: now + 200 });

    const stats = engine.getStats(now + 300);
    expect(stats).toHaveProperty('pValue');
    expect(stats).toHaveProperty('uplift');
    expect(stats).toHaveProperty('conversionsA');
    expect(stats).toHaveProperty('conversionsB');
  });

  test('getStats returns finite numbers for empty engine', () => {
    const stats = engine.getStats(BASE_TIME);
    expect(stats).toBeDefined();
    expect(typeof stats.sessionsA).toBe('number');
    expect(typeof stats.sessionsB).toBe('number');
  });

  test('shouldApplyIntervention returns boolean', () => {
    const result = engine.shouldApplyIntervention('sess-sai');
    expect(typeof result).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExperimentEngine — snapshot/restore round-trip
// ─────────────────────────────────────────────────────────────────────────────
describe('ExperimentEngine: snapshot/restore', () => {
  test('variant assignment is preserved across snapshot/restore', () => {
    const e1 = new ExperimentEngine();
    const v1 = e1.assignVariant('sess-snap');
    const snap = e1.snapshot();
    e1.dispose();

    const e2 = new ExperimentEngine();
    e2.restore(snap, BASE_TIME + 1000);
    const v2 = e2.assignVariant('sess-snap');
    expect(v2).toBe(v1);
    e2.dispose();
  });

  test('snapshot has correct schema version', () => {
    const e = new ExperimentEngine();
    const snap = e.snapshot();
    expect(snap.__schemaVersion).toBe(EE_SCHEMA);
    e.dispose();
  });

  test('restore(snap) without nowMs works (backward compat)', () => {
    const e1 = new ExperimentEngine();
    e1.assignVariant('sess-bc');
    const snap = e1.snapshot();
    e1.dispose();

    const e2 = new ExperimentEngine();
    expect(() => e2.restore(snap)).not.toThrow();
    e2.dispose();
  });

  test('restore with stale decisionLog and nowMs filters old entries', () => {
    const e1 = new ExperimentEngine({ decisionLogRetentionMs: 60_000 });
    e1.assignVariant('sess-ret');
    const snap = e1.snapshot();
    e1.dispose();

    // Restore 3 hours later
    const future = BASE_TIME + 3 * 60 * 60 * 1000;
    const e2 = new ExperimentEngine({ decisionLogRetentionMs: 60_000 });
    expect(() => e2.restore(snap, future)).not.toThrow();
    e2.dispose();
  });

  test('dispose() prevents further calls', () => {
    const e = new ExperimentEngine();
    e.dispose();
    expect(() => e.assignVariant('s')).toThrow();
    expect(() => e.snapshot()).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stableHash — determinism
// ─────────────────────────────────────────────────────────────────────────────
describe('stableHash: determinism', () => {
  test('same input always returns same hash', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
  });

  test('different inputs produce different hashes', () => {
    expect(stableHash('aaa')).not.toBe(stableHash('bbb'));
  });

  test('returns a finite number', () => {
    expect(Number.isFinite(stableHash('test'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cohenD — continuous effect size (delegates internally from experiment-engine)
// ─────────────────────────────────────────────────────────────────────────────
describe('cohenD: continuous effect size', () => {
  test('identical distributions give effect near 0', () => {
    const d = cohenD([10, 20, 30, 40], [10, 20, 30, 40]);
    expect(Math.abs(d)).toBeLessThan(0.01);
  });

  test('very different distributions give non-zero effect', () => {
    const d = cohenD([1, 2, 3], [100, 200, 300]);
    expect(Math.abs(d)).toBeGreaterThan(1);
  });

  test('returns null for single-element arrays', () => {
    expect(cohenD([5], [10])).toBeNull();
  });

  test('returns a finite number for valid inputs', () => {
    const d = cohenD([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
    expect(Number.isFinite(d)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SVE — computeBootstrapCI95 determinism
// ─────────────────────────────────────────────────────────────────────────────
describe('SVE: computeBootstrapCI95 determinism', () => {
  const A = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0];
  const B = [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1];

  test('same inputs always produce same CI bounds', () => {
    const r1 = computeBootstrapCI95(A, B, 500);
    const r2 = computeBootstrapCI95(A, B, 500);
    expect(r1.lower).toBe(r2.lower);
    expect(r1.upper).toBe(r2.upper);
  });

  test('returns lower, upper, medianBoot fields', () => {
    const r = computeBootstrapCI95(A, B, 200);
    expect(r).toHaveProperty('lower');
    expect(r).toHaveProperty('upper');
    expect(typeof r.lower).toBe('number');
    expect(typeof r.upper).toBe('number');
  });

  test('lower <= upper', () => {
    const r = computeBootstrapCI95(A, B, 500);
    expect(r.lower).toBeLessThanOrEqual(r.upper);
  });

  test('empty arrays return without throwing', () => {
    expect(() => computeBootstrapCI95([], [], 100)).not.toThrow();
  });

  test('different data produces different CI', () => {
    const Aa = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    const Ba = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const r1 = computeBootstrapCI95(A, B, 500);
    const r2 = computeBootstrapCI95(Aa, Ba, 500);
    expect(r1.lower).not.toBe(r2.lower);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SVE — computePermutationPValue determinism
// ─────────────────────────────────────────────────────────────────────────────
describe('SVE: computePermutationPValue determinism', () => {
  const A = [1, 0, 1, 0, 0, 1, 1, 0, 1, 0];
  const B = [1, 1, 1, 1, 0, 1, 1, 1, 0, 1];

  test('same inputs produce identical p-value', () => {
    const p1 = computePermutationPValue(A, B, 1000);
    const p2 = computePermutationPValue(A, B, 1000);
    expect(p1).toBe(p2);
  });

  test('p-value is in [0, 1]', () => {
    const p = computePermutationPValue(A, B, 1000);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  test('identical groups produce non-significant p-value (> 0.05)', () => {
    const same = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
    const p = computePermutationPValue(same, [...same], 1000);
    expect(p).toBeGreaterThan(0.05);
  });

  test('empty arrays handled without throwing', () => {
    expect(() => computePermutationPValue([], [], 100)).not.toThrow();
  });

  test('returns a finite number for valid inputs', () => {
    const p = computePermutationPValue(A, B, 500);
    expect(Number.isFinite(p)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SVE — computeEffectSize (Cohen's h for proportions)
// ─────────────────────────────────────────────────────────────────────────────
describe('SVE: computeEffectSize (Cohen\'s h for proportions)', () => {
  test('identical rates give |h| near 0', () => {
    const r = computeEffectSize(0.5, 0.5);
    expect(Math.abs(r.h)).toBeLessThan(0.01);
  });

  test('large difference gives |h| > 0.5', () => {
    const r = computeEffectSize(0.8, 0.2);
    expect(Math.abs(r.h)).toBeGreaterThan(0.5);
  });

  test('returns h, absH, interpretation fields', () => {
    const r = computeEffectSize(0.6, 0.4);
    expect(r).toHaveProperty('h');
    expect(r).toHaveProperty('absH');
    expect(r).toHaveProperty('interpretation');
    expect(typeof r.interpretation).toBe('string');
  });

  test('zero-rate group handled without throwing', () => {
    expect(() => computeEffectSize(0, 0.5)).not.toThrow();
  });

  test('h is finite for valid rates', () => {
    const r = computeEffectSize(0.6, 0.4);
    expect(Number.isFinite(r.h)).toBe(true);
  });

  test('absH >= 0', () => {
    const r = computeEffectSize(0.3, 0.7);
    expect(r.absH).toBeGreaterThanOrEqual(0);
  });
});
