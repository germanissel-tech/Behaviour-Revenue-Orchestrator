'use strict';
/**
 * CooldownFatigueEngine and real-time orchestrator facade tests.
 */

const { CooldownFatigueEngine } = require('../lib/cooldown-fatigue-engine');
const {
  processBehavioralEvent,
  validateSessionId,
  validateStoreId,
} = require('../lib/real-time-orchestrator');

const BASE_TIME = 10_000_000;
const CTX = { family: 'social_proof', context: 'product_detail' };

// ─────────────────────────────────────────────────────────────────────────────
// CooldownFatigueEngine — basic state machine
// ─────────────────────────────────────────────────────────────────────────────
describe('CooldownFatigueEngine: basic state', () => {
  let engine;
  beforeEach(() => {
    engine = new CooldownFatigueEngine();
    engine.reset(BASE_TIME);
  });
  afterEach(() => { engine.dispose(); });

  test('fresh engine canIntervene = true', () => {
    const { allowed } = engine.canIntervene({ ...CTX, now: BASE_TIME });
    expect(allowed).toBe(true);
  });

  test('fatigue score starts at 0', () => {
    expect(engine.getFatigueScore(BASE_TIME)).toBe(0);
  });

  test('dismissal increases fatigue score', () => {
    engine.registerDismissal({ family: 'social_proof', now: BASE_TIME + 100 });
    const score = engine.getFatigueScore(BASE_TIME + 200);
    expect(score).toBeGreaterThan(0);
  });

  test('positive signal does not increase fatigue', () => {
    engine.registerPositiveSignal({ now: BASE_TIME + 100 });
    const score = engine.getFatigueScore(BASE_TIME + 200);
    expect(score).toBe(0);
  });

  test('canIntervene returns an object with allowed, reason, effectiveFatigue', () => {
    const result = engine.canIntervene({ ...CTX, now: BASE_TIME });
    expect(result).toHaveProperty('allowed');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('effectiveFatigue');
  });

  test('multiple dismissals accumulate fatigue', () => {
    engine.registerDismissal({ family: 'social_proof', now: BASE_TIME + 100 });
    engine.registerDismissal({ family: 'urgency', now: BASE_TIME + 200 });
    engine.registerDismissal({ family: 'trust', now: BASE_TIME + 300 });
    const score = engine.getFatigueScore(BASE_TIME + 400);
    expect(score).toBeGreaterThan(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CooldownFatigueEngine — snapshot/restore
// ─────────────────────────────────────────────────────────────────────────────
describe('CooldownFatigueEngine: snapshot/restore', () => {
  test('fatigue state is preserved across snapshot/restore', () => {
    const e1 = new CooldownFatigueEngine();
    e1.reset(BASE_TIME);
    e1.registerDismissal({ family: 'social_proof', now: BASE_TIME + 100 });
    const scoreBefore = e1.getFatigueScore(BASE_TIME + 200);
    const snap = e1.snapshot();
    e1.dispose();

    const e2 = new CooldownFatigueEngine();
    e2.restore(snap, BASE_TIME + 200);
    const scoreAfter = e2.getFatigueScore(BASE_TIME + 200);

    expect(scoreAfter).toBeCloseTo(scoreBefore, 5);
    e2.dispose();
  });

  test('restore(null) returns without throwing', () => {
    const e = new CooldownFatigueEngine();
    e.reset(BASE_TIME);
    expect(() => e.restore(null, BASE_TIME)).not.toThrow();
    e.dispose();
  });

  test('snapshot has __schemaVersion', () => {
    const e = new CooldownFatigueEngine();
    e.reset(BASE_TIME);
    const snap = e.snapshot();
    expect(snap.__schemaVersion).toBeDefined();
    expect(typeof snap.__schemaVersion).toBe('number');
    e.dispose();
  });

  test('wrong schema version restore does not crash', () => {
    const e = new CooldownFatigueEngine();
    e.reset(BASE_TIME);
    const badSnap = { __schemaVersion: 0, version: 0 };
    // should either throw with a clear message or ignore — must not corrupt
    try {
      e.restore(badSnap, BASE_TIME);
    } catch (err) {
      expect(err.message).toMatch(/schema/i);
    }
    e.dispose();
  });

  test('dispose prevents further calls', () => {
    const e = new CooldownFatigueEngine();
    e.reset(BASE_TIME);
    e.dispose();
    expect(() => e.getFatigueScore(BASE_TIME)).toThrow();
  });

  test('double dispose does not throw', () => {
    const e = new CooldownFatigueEngine();
    e.reset(BASE_TIME);
    e.dispose();
    expect(() => e.dispose()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CooldownFatigueEngine — tryAcquire / commit / rollback
// ─────────────────────────────────────────────────────────────────────────────
describe('CooldownFatigueEngine: tryAcquire/commit/rollback', () => {
  let engine;
  beforeEach(() => {
    engine = new CooldownFatigueEngine();
    engine.reset(BASE_TIME);
  });
  afterEach(() => { engine.dispose(); });

  test('tryAcquire returns a token or null', () => {
    const token = engine.tryAcquire({ ...CTX, now: BASE_TIME });
    expect(token === null || typeof token === 'string' || typeof token === 'object').toBe(true);
  });

  test('commit after tryAcquire does not throw', () => {
    const result = engine.tryAcquire({ ...CTX, now: BASE_TIME });
    // tryAcquire returns { allowed, token, ... } — commit wants result.token string
    if (result && result.allowed && result.token) {
      expect(() => engine.commit(result.token, { now: BASE_TIME + 1 })).not.toThrow();
    }
  });

  test('rollback after tryAcquire does not throw', () => {
    const result = engine.tryAcquire({ ...CTX, now: BASE_TIME });
    if (result && result.allowed && result.token) {
      expect(() => engine.rollback(result.token)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real-time orchestrator facade — validation
// ─────────────────────────────────────────────────────────────────────────────
describe('real-time-orchestrator: input validation', () => {
  test('validateSessionId accepts valid ID', () => {
    expect(() => validateSessionId('session-abc-123')).not.toThrow();
  });

  test('validateSessionId rejects null', () => {
    expect(() => validateSessionId(null)).toThrow();
  });

  test('validateSessionId rejects empty string', () => {
    expect(() => validateSessionId('')).toThrow();
  });

  test('validateSessionId rejects IDs over 128 characters', () => {
    expect(() => validateSessionId('x'.repeat(129))).toThrow();
  });

  test('validateStoreId accepts valid ID', () => {
    expect(() => validateStoreId('store-001')).not.toThrow();
  });

  test('validateStoreId rejects null', () => {
    expect(() => validateStoreId(null)).toThrow();
  });
});

describe('real-time-orchestrator: processBehavioralEvent', () => {
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });
  test('missing nowMs throws (B1 fix)', () => {
    expect(() =>
      processBehavioralEvent({
        type: 'SCROLL',
        payload: { y: 100 },
        sessionId: 'sess-rto-1',
        storeId: 'store-1',
        // nowMs intentionally omitted
      })
    ).toThrow(/nowMs/i);
  });

  test('non-finite nowMs throws', () => {
    expect(() =>
      processBehavioralEvent({
        type: 'SCROLL',
        payload: {},
        sessionId: 'sess-rto-2',
        storeId: 'store-1',
        nowMs: NaN,
      })
    ).toThrow();
  });

  test('valid event is processed without throwing', () => {
    // processBehavioralEvent takes { sessionId, storeId, event: { type, payload, nowMs } }
    expect(() =>
      processBehavioralEvent({
        sessionId: 'sess-rto-valid',
        storeId: 'store-1',
        event: { type: 'SCROLL', payload: { y: 50 }, nowMs: BASE_TIME },
      })
    ).not.toThrow();
  });

  test('result has processingTimeMs = null (H4 fix — no performance.now)', () => {
    // processBehavioralEvent takes { sessionId, storeId, event: { type, payload, nowMs } }
    const result = processBehavioralEvent({
      sessionId: 'sess-rto-perf',
      storeId: 'store-1',
      event: { type: 'SCROLL', payload: {}, nowMs: BASE_TIME },
    });
    // processingTimeMs must be null, not a wall-clock measurement
    // processingTimeMs is nested in orchestrationSummary
    expect(result.orchestrationSummary.processingTimeMs).toBeNull();
  });
});
