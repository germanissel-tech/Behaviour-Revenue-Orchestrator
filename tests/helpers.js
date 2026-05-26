'use strict';
/**
 * Test helpers — shared factory functions and constants.
 * All nowMs values use a fixed base so tests are deterministic.
 */

const { SessionOrchestrator } = require('../lib/session-orchestrator');

const BASE_TIME = 10_000_000; // fixed epoch, well above 0

/**
 * Create an initialized orchestrator with sensible test defaults.
 * requireCandidateProvider/requirePresenceCheck disabled so evaluate()
 * can proceed without external providers.
 */
function makeOrchestrator(configOverrides = {}, sessionId = 'test-session', storeId = 'test-store', snapshot = null) {
  const orch = new SessionOrchestrator({
    requireCandidateProvider: false,
    requirePresenceCheck: false,
    requireVisibilityCheck: false,
    enableDiagnosticLogs: false,
    ...configOverrides,
  });
  orch.initialize(sessionId, storeId, BASE_TIME, snapshot);
  return orch;
}

/**
 * Fire a product view + context so the session has minimal state for evaluate().
 */
function primeSession(orch, nowOffset = 0) {
  const t = BASE_TIME + nowOffset;
  orch.processEvent({ type: 'CONTEXT_CHANGED', payload: { context: 'product_detail' } }, t + 1);
  orch.processEvent({ type: 'PRODUCT_CHANGED', payload: { productId: 'prod-test-001' } }, t + 2);
  return t + 2;
}

module.exports = { makeOrchestrator, primeSession, BASE_TIME };
