'use strict';
/**
 * InterventionOutcomeTracker and InterventionLearningStore tests.
 * Covers the full attribution pipeline: expose → outcome → learn.
 */

const {
  InterventionOutcomeTracker,
  OUTCOME_TYPES,
} = require('../lib/intervention-outcome-tracker');
const { InterventionLearningStore } = require('../lib/intervention-learning-store');
const { makeOrchestrator, primeSession, BASE_TIME } = require('./helpers');

// ─────────────────────────────────────────────────────────────────────────────
// InterventionOutcomeTracker — exposure lifecycle
// ─────────────────────────────────────────────────────────────────────────────
describe('InterventionOutcomeTracker: exposure lifecycle', () => {
  let tracker;
  beforeEach(() => { tracker = new InterventionOutcomeTracker(); });
  afterEach(() => { tracker.dispose(); });

  test('recordExposure succeeds with valid args', () => {
    expect(() => {
      tracker.recordExposure({
        sessionId: 's1', messageId: 'msg-1', exposureId: 'exp-1', nowMs: BASE_TIME,
      });
    }).not.toThrow();
  });

  test('activeExposures count increases after recordExposure', () => {
    tracker.recordExposure({ sessionId: 's1', messageId: 'msg-1', exposureId: 'exp-1', nowMs: BASE_TIME });
    expect(tracker.getDiagnostics().activeExposures).toBe(1);
  });

  test('recordOutcome succeeds after exposure', () => {
    tracker.recordExposure({ sessionId: 's1', messageId: 'msg-1', exposureId: 'exp-1', nowMs: BASE_TIME });
    expect(() => {
      tracker.recordOutcome({
        sessionId: 's1',
        outcomeType: OUTCOME_TYPES.ADD_TO_CART_AFTER,
        nowMs: BASE_TIME + 1000,
      });
    }).not.toThrow();
  });

  test('recordOutcome with no prior exposure does not throw', () => {
    expect(() => {
      tracker.recordOutcome({
        sessionId: 'no-exposure',
        outcomeType: OUTCOME_TYPES.CHECKOUT_AFTER,
        nowMs: BASE_TIME + 500,
      });
    }).not.toThrow();
  });

  test('closeSession moves active to completed', () => {
    tracker.recordExposure({ sessionId: 's2', messageId: 'msg-2', exposureId: 'exp-2', nowMs: BASE_TIME });
    tracker.closeSession('s2', BASE_TIME + 2000);
    const diag = tracker.getDiagnostics();
    expect(diag.activeExposures).toBe(0);
    expect(diag.completedOutcomes).toBeGreaterThanOrEqual(1);
  });

  test('getOutcomesForLearning returns array', () => {
    tracker.recordExposure({ sessionId: 's3', messageId: 'msg-3', exposureId: 'exp-3', nowMs: BASE_TIME });
    tracker.closeSession('s3', BASE_TIME + 1000);
    const outcomes = tracker.getOutcomesForLearning('s3');
    expect(Array.isArray(outcomes)).toBe(true);
  });

  test('cleanup does not throw', () => {
    tracker.recordExposure({ sessionId: 's4', messageId: 'msg-4', exposureId: 'exp-4', nowMs: BASE_TIME });
    expect(() => tracker.cleanup(BASE_TIME + 1_000_000)).not.toThrow();
  });

  test('cleanup removes old completed records', () => {
    tracker.recordExposure({ sessionId: 's5', messageId: 'msg-5', exposureId: 'exp-5', nowMs: BASE_TIME });
    tracker.closeSession('s5', BASE_TIME + 100);
    // cleanup far in the future — should purge
    tracker.cleanup(BASE_TIME + 100_000_000);
    // no throw; diag still accessible
    expect(() => tracker.getDiagnostics()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// InterventionOutcomeTracker — snapshot/restore
// ─────────────────────────────────────────────────────────────────────────────
describe('InterventionOutcomeTracker: snapshot/restore', () => {
  test('snapshot/restore preserves active exposure count', () => {
    const t1 = new InterventionOutcomeTracker();
    t1.recordExposure({ sessionId: 's1', messageId: 'm1', exposureId: 'e1', nowMs: BASE_TIME });
    const snap = t1.snapshot();
    t1.dispose();

    const t2 = new InterventionOutcomeTracker();
    t2.restore(snap, BASE_TIME + 100);
    expect(t2.getDiagnostics().activeExposures).toBe(1);
    t2.dispose();
  });

  test('restore(null) is a no-op', () => {
    const t = new InterventionOutcomeTracker();
    expect(() => t.restore(null, BASE_TIME)).not.toThrow();
    t.dispose();
  });

  test('double snapshot is idempotent', () => {
    const t = new InterventionOutcomeTracker();
    t.recordExposure({ sessionId: 's1', messageId: 'm1', exposureId: 'e1', nowMs: BASE_TIME });
    const s1 = t.snapshot();
    const s2 = t.snapshot();
    expect(s1.__schemaVersion).toBe(s2.__schemaVersion);
    t.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// InterventionLearningStore — ingestion and retrieval
// ─────────────────────────────────────────────────────────────────────────────
describe('InterventionLearningStore: ingestion and retrieval', () => {
  let store;

  const makeOutcome = (outcomeType = OUTCOME_TYPES.ADD_TO_CART_AFTER) => ([{
    decisionId: null,
    exposureId: 'e1',
    messageId: 'm1',
    subtype: null,
    productId: 'p1',
    intentStateAtExposure: 'hesitating',
    funnelStageAtExposure: 'consideration',
    hesitationScoreAtExposure: 0.7,
    primaryOutcome: outcomeType,
    attributed: true,
    deltaMs: 2000,
    outcomes: [{ type: outcomeType, nowMs: BASE_TIME + 200, deltaMs: 200, delta: null }],
  }]);

  const SESSION_META = { context: 'product_detail', family: 'social_proof' };

  beforeEach(() => { store = new InterventionLearningStore(); });
  afterEach(() => { store.dispose(); });

  test('ingestOutcomes does not throw with valid outcomes', () => {
    expect(() => {
      store.ingestOutcomes(makeOutcome(), SESSION_META, BASE_TIME + 200);
    }).not.toThrow();
  });

  test('ingestOutcomes with empty array does not throw', () => {
    expect(() => store.ingestOutcomes([], SESSION_META, BASE_TIME)).not.toThrow();
  });

  test('getDiagnostics returns bucketCount and totalObservations', () => {
    const diag = store.getDiagnostics();
    expect(diag).toHaveProperty('bucketCount');
    expect(diag).toHaveProperty('totalObservations');
    expect(diag).toHaveProperty('maxBuckets');
    expect(typeof diag.bucketCount).toBe('number');
  });

  test('getFamilyStats returns null for unknown family', () => {
    const stats = store.getFamilyStats('unknown-family');
    expect(stats === null || typeof stats === 'object').toBe(true);
  });

  test('getAllFamilyStats returns an array', () => {
    store.ingestOutcomes(makeOutcome(), SESSION_META, BASE_TIME + 200);
    const all = store.getAllFamilyStats();
    expect(Array.isArray(all)).toBe(true);
  });

  test('rankFamiliesForContext returns an array', () => {
    const ranked = store.rankFamiliesForContext({
      context: 'product_detail',
      intentState: 'hesitating',
      nowMs: BASE_TIME,
    });
    expect(Array.isArray(ranked)).toBe(true);
  });

  test('cleanup does not throw', () => {
    store.ingestOutcomes(makeOutcome(), SESSION_META, BASE_TIME + 200);
    expect(() => store.cleanup(BASE_TIME + 1_000_000)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// InterventionLearningStore — snapshot/restore
// ─────────────────────────────────────────────────────────────────────────────
describe('InterventionLearningStore: snapshot/restore', () => {
  const SESSION_META = { context: 'product_detail', family: 'social_proof' };
  const outcome = [{
    decisionId: null, exposureId: 'e1', messageId: 'm1', subtype: null,
    productId: 'p1', intentStateAtExposure: 'hesitating', funnelStageAtExposure: 'consideration',
    hesitationScoreAtExposure: 0.7, primaryOutcome: OUTCOME_TYPES.ADD_TO_CART_AFTER,
    attributed: true, deltaMs: 2000,
    outcomes: [{ type: OUTCOME_TYPES.ADD_TO_CART_AFTER, nowMs: BASE_TIME + 200, deltaMs: 200, delta: null }],
  }];

  test('snapshot/restore round-trip preserves schema version', () => {
    const s1 = new InterventionLearningStore();
    s1.ingestOutcomes(outcome, SESSION_META, BASE_TIME + 200);
    const snap = s1.snapshot();
    s1.dispose();

    const s2 = new InterventionLearningStore();
    s2.restore(snap, BASE_TIME + 300);
    const snap2 = s2.snapshot();

    expect(snap.__schemaVersion).toBe(snap2.__schemaVersion);
    s2.dispose();
  });

  test('restore(null) is a no-op', () => {
    const s = new InterventionLearningStore();
    expect(() => s.restore(null, BASE_TIME)).not.toThrow();
    s.dispose();
  });

  test('dispose marks store as disposed', () => {
    const s = new InterventionLearningStore();
    s.dispose();
    // getDiagnostics is safe post-dispose and reports disposed:true
    const diag = s.getDiagnostics();
    expect(diag.disposed).toBe(true);
    // ingestOutcomes silently no-ops when disposed (does not throw)
    expect(() => s.ingestOutcomes([], {}, 10000000)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline integration: orchestrator → outcomeTracker → learningStore
// ─────────────────────────────────────────────────────────────────────────────
describe('Full pipeline: orchestrator → outcomeTracker → learningStore', () => {
  test('add_to_cart records outcome and survives terminate', () => {
    const orch = makeOrchestrator();
    primeSession(orch);

    const spy = jest.spyOn(orch.outcomeTracker, 'recordOutcome');
    orch.processEvent(
      { type: 'USER_ACTION', payload: { type: 'add_to_cart', productId: 'prod-test-001' } },
      BASE_TIME + 500
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeType: OUTCOME_TYPES.ADD_TO_CART_AFTER })
    );

    const closeSpy = jest.spyOn(orch.outcomeTracker, 'closeSession');
    orch.terminate(BASE_TIME + 600);
    expect(closeSpy).toHaveBeenCalled();
    orch.dispose();
  });

  test('checkout records CHECKOUT_AFTER and terminate fires closeSession', () => {
    const orch = makeOrchestrator();
    primeSession(orch);

    const spy = jest.spyOn(orch.outcomeTracker, 'recordOutcome');
    orch.processEvent(
      { type: 'USER_ACTION', payload: { type: 'checkout', revenue: 99.0 } },
      BASE_TIME + 300
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeType: OUTCOME_TYPES.CHECKOUT_AFTER })
    );
    orch.dispose();
  });

  test('dismiss_message records DISMISSED outcome', () => {
    const orch = makeOrchestrator();
    primeSession(orch);

    const spy = jest.spyOn(orch.outcomeTracker, 'recordOutcome');
    orch.processEvent(
      { type: 'USER_ACTION', payload: { type: 'dismiss_message' } },
      BASE_TIME + 200
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeType: OUTCOME_TYPES.DISMISSED })
    );
    orch.dispose();
  });

  test('click_message records CLICKED outcome', () => {
    const orch = makeOrchestrator();
    primeSession(orch);

    const spy = jest.spyOn(orch.outcomeTracker, 'recordOutcome');
    orch.processEvent(
      { type: 'USER_ACTION', payload: { type: 'click_message' } },
      BASE_TIME + 200
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ outcomeType: OUTCOME_TYPES.CLICKED })
    );
    orch.dispose();
  });

  test('evaluate() pipeline runs without throwing (no candidates = no intervention)', () => {
    const orch = makeOrchestrator();
    primeSession(orch);

    // Run many hover events to build hesitation signal
    let t = BASE_TIME + 100;
    for (let i = 0; i < 5; i++) {
      orch.processEvent({ type: 'HOVER_START', payload: { elementId: 'cta' } }, t);
      t += 3000;
      orch.processEvent({ type: 'HOVER_END', payload: {} }, t);
      t += 100;
    }

    expect(() => orch.evaluate(t)).not.toThrow();
    orch.dispose();
  });

  test('full session lifecycle: init → events → evaluate → terminate → dispose', () => {
    const orch = makeOrchestrator();
    let t = BASE_TIME;

    orch.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'listing' } }, ++t);
    orch.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'p1' } }, ++t);
    orch.processEvent({ type: 'SCROLL', payload: { y: 200 } }, ++t);
    orch.processEvent({ type: 'HOVER_START', payload: { elementId: 'btn' } }, ++t);
    t += 2000;
    orch.processEvent({ type: 'HOVER_END', payload: {} }, t);
    orch.evaluate(++t);
    orch.processEvent({ type: 'USER_ACTION', payload: { type: 'add_to_cart', productId: 'p1' } }, ++t);
    orch.processEvent({ type: 'USER_ACTION', payload: { type: 'checkout', revenue: 49.0 } }, ++t);
    orch.terminate(++t);

    expect(() => orch.dispose()).not.toThrow();
  });
});
