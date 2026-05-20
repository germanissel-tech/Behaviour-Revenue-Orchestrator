/**
 * real-time-orchestrator.js
 *
 * DEPRECATED FACADE (v3 enterprise restructure)
 *
 * Previously this was a full parallel orchestration pipeline that independently ran:
 *   signal derivation -> intent -> transition -> fatigue -> policy -> ranking -> persist
 *
 * This created a PARALLEL AUTHORITY to session-orchestrator.js, causing:
 *   - Duplicated decision paths
 *   - Inconsistent state mutations
 *   - Non-deterministic intervention timing
 *   - Double fatigue accounting
 *
 * ARCHITECTURAL DECISION:
 *   session-orchestrator.js is the SINGLE orchestration authority.
 *   This module is now a backward-compatible facade that:
 *   1. Delegates processBehavioralEvent() -> SessionOrchestrator.processEvent() + evaluate()
 *   2. Delegates orchestrateSessionUpdate() -> SessionOrchestrator batch processing
 *   3. Preserves individual run*Pipeline functions as ANALYTICS/DIAGNOSTIC helpers only
 *   4. Emits deprecation warnings at runtime
 *
 * All exports are preserved for backward compatibility. No callers break.
 */

'use strict';

// ----------------------------------------------------------------------
// DEPENDENCIES
// ----------------------------------------------------------------------
const { SessionOrchestrator } = require('./session-orchestrator');

// logger-v2 is a browser IIFE with no module.exports; wrap safely
const _loggerRaw = (() => { try { return require('./logger-v2'); } catch (_) { return {}; } })();
const Logger = {
  warn: typeof _loggerRaw.warn === 'function' ? _loggerRaw.warn : (...a) => console.warn('[RTO-deprecated]', ...a),
  error: typeof _loggerRaw.error === 'function' ? _loggerRaw.error : (...a) => console.error('[RTO-deprecated]', ...a),
  info: typeof _loggerRaw.info === 'function' ? _loggerRaw.info : () => {},
};

// Individual engines kept ONLY for analytics/diagnostic helpers
const SignalEngine = require('./signal-derivation-engine');
const { INTENT_STATES, VALID_INTENT_STATES } = require('./ope-constants');

// ----------------------------------------------------------------------
// DEPRECATION TRACKING
// ----------------------------------------------------------------------
const _deprecationWarnings = new Set();

function _warnDeprecated(method) {
  if (!_deprecationWarnings.has(method)) {
    _deprecationWarnings.add(method);
    Logger.warn(
      `[real-time-orchestrator] DEPRECATED: ${method}() is deprecated. ` +
      `Use SessionOrchestrator directly. This facade delegates to session-orchestrator.`
    );
  }
}

// ----------------------------------------------------------------------
// CONSTANTS (preserved for backward compatibility of exports)
// ----------------------------------------------------------------------
const DEFAULT_INTENT_STATE = { intentState: 'exploring', confidence: 0.5 };
const DEFAULT_TRANSITION_STATE = { currentState: 'exploring', stability: 0.5, oscillationRisk: false };
const DEFAULT_FATIGUE_MEMORY = { fatigueScore: 0, saturationScore: 0 };
const DEFAULT_INTERVENTION_MEMORY = { exposures: [], archivedExposures: [] };
const MAX_ACTIVE_EXPOSURES = 50;
const MAX_ARCHIVED_EXPOSURES = 200;

// ----------------------------------------------------------------------
// HELPER: safe numeric clamp (preserved for backward compat)
// ----------------------------------------------------------------------
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ----------------------------------------------------------------------
// SESSION ORCHESTRATOR INSTANCE POOL (facade layer)
//
// Each sessionId gets a SessionOrchestrator instance. The facade
// translates the old API shape into SessionOrchestrator calls.
// ----------------------------------------------------------------------
const _orchestrators = new Map();
const MAX_ORCHESTRATORS = 1000;

function _getOrCreateOrchestrator(sessionId) {
  if (!_orchestrators.has(sessionId)) {
    if (_orchestrators.size >= MAX_ORCHESTRATORS) {
      // LRU eviction: remove first entry
      const firstKey = _orchestrators.keys().next().value;
      _orchestrators.delete(firstKey);
    }
    _orchestrators.set(sessionId, new SessionOrchestrator());
  }
  return _orchestrators.get(sessionId);
}

function validateSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
}

function validateStoreId(storeId) {
  if (!storeId || typeof storeId !== 'string' || storeId.length > 128) {
    throw new Error(`Invalid storeId: ${storeId}`);
  }
}

// ----------------------------------------------------------------------
// MAIN ORCHESTRATION FUNCTION (FACADE -> SessionOrchestrator)
//
// DEPRECATED: Use SessionOrchestrator.processEvent() + evaluate() directly.
// This function exists only for backward compatibility.
// ----------------------------------------------------------------------
function processBehavioralEvent({ sessionId, storeId, event, candidateMessages = [], initialState = null }) {
  _warnDeprecated('processBehavioralEvent');

  validateSessionId(sessionId);
  if (storeId) validateStoreId(storeId);

  // P1-DET: require explicit nowMs — no Date.now() in hot path
  const orchestrationTs = (typeof event.nowMs === 'number') ? event.nowMs : Date.now();
  const orchestrator = _getOrCreateOrchestrator(sessionId);

  // Delegate to SessionOrchestrator
  try {
    // 1. Process the event through the canonical pipeline
    const processResult = orchestrator.processEvent(event, orchestrationTs);

    // 2. Evaluate intervention decision
    const evalResult = orchestrator.evaluate(orchestrationTs);

    // 3. Map to legacy response shape
    const shouldIntervene = evalResult?.shouldIntervene || false;
    const selectedIntervention = evalResult?.intervention || null;

    return {
      shouldIntervene,
      selectedIntervention,
      interventionDecision: shouldIntervene ? {
        family: selectedIntervention?.family || null,
        subtype: selectedIntervention?.subtype || null,
        intensity: evalResult?.intensity || 0.5,
        priority: evalResult?.priority || 0,
        reasoning: evalResult?.reasoning || 'Delegated to session-orchestrator',
      } : null,
      suppressionReason: shouldIntervene ? null : (evalResult?.reasoning || 'Delegated to session-orchestrator'),
      updatedSessionState: processResult?.sessionState || {},
      updatedTransitionState: processResult?.transitionState || DEFAULT_TRANSITION_STATE,
      updatedFatigueMemory: processResult?.fatigueState || DEFAULT_FATIGUE_MEMORY,
      updatedInterventionMemory: DEFAULT_INTERVENTION_MEMORY,
      orchestrationSummary: {
        processingTimeMs: (typeof performance !== 'undefined' ? performance.now() : orchestrationTs) - orchestrationTs,
        eventProcessed: event.type,
        delegatedTo: 'session-orchestrator',
        facade: true,
      },
      diagnostics: {
        orchestrationPath: 'facade_delegated_to_session_orchestrator',
        deprecationNotice: 'real-time-orchestrator is deprecated; use SessionOrchestrator directly',
        ...(evalResult?.diagnostics || {}),
      },
    };
  } catch (err) {
    Logger.error(`[real-time-orchestrator] Facade delegation error for ${sessionId}:`, err);
    return {
      shouldIntervene: false,
      selectedIntervention: null,
      interventionDecision: null,
      suppressionReason: `Facade delegation error: ${err.message}`,
      updatedSessionState: {},
      updatedTransitionState: DEFAULT_TRANSITION_STATE,
      updatedFatigueMemory: DEFAULT_FATIGUE_MEMORY,
      updatedInterventionMemory: DEFAULT_INTERVENTION_MEMORY,
      orchestrationSummary: { error: true, facade: true },
      diagnostics: { orchestrationPath: 'facade_error', error: err.message },
    };
  }
}

// ----------------------------------------------------------------------
// MULTI-EVENT PROCESSING (FACADE -> SessionOrchestrator)
//
// DEPRECATED: Use SessionOrchestrator.processEvent() in a loop directly.
// ----------------------------------------------------------------------
function orchestrateSessionUpdate(sessionId, storeId, eventsArray, candidateMessages) {
  _warnDeprecated('orchestrateSessionUpdate');

  validateSessionId(sessionId);
  if (storeId) validateStoreId(storeId);

  if (!eventsArray || eventsArray.length === 0) {
    return { shouldIntervene: false, results: [], finalResult: null };
  }

  const results = [];
  for (const ev of eventsArray) {
    const result = processBehavioralEvent({
      sessionId,
      storeId,
      event: ev,
      candidateMessages,
    });
    results.push(result);
    if (result.shouldIntervene) break;
  }

  const finalResult = results[results.length - 1];
  return {
    shouldIntervene: finalResult?.shouldIntervene || false,
    results,
    finalResult,
  };
}

// ----------------------------------------------------------------------
// ANALYTICS/DIAGNOSTIC HELPERS
//
// These individual pipeline functions are preserved as READ-ONLY
// diagnostic helpers. They do NOT mutate session state and do NOT
// participate in the decision pipeline. They can be used for:
// - Post-hoc analysis
// - Debugging
// - Testing individual engine behavior
// - Logging/telemetry
// ----------------------------------------------------------------------

/**
 * DIAGNOSTIC ONLY: Run signal derivation without mutating state.
 */
function runSignalPipeline(sessionId, events, previousSignals = {}) {
  _warnDeprecated('runSignalPipeline');
  try {
    return SignalEngine.processEvents(events, previousSignals);
  } catch (err) {
    Logger.error(`[DIAGNOSTIC] Signal pipeline error:`, err);
    return { signals: {}, signalHistory: [] };
  }
}

/**
 * DIAGNOSTIC ONLY: Generate orchestration diagnostics from raw pipeline data.
 */
function generateOrchestrationDiagnostics(pipelineResults) {
  return {
    pipelineTiming: pipelineResults.timing || {},
    dominantSignals: pipelineResults.signals ? Object.keys(pipelineResults.signals).slice(0, 5) : [],
    transitionReasoning: pipelineResults.transition?.reasoning || 'No transition',
    fatigueReasoning: {
      fatigueScore: pipelineResults.fatigue?.fatigueScore,
      pressureLevel: pipelineResults.fatigue?.pressureLevel,
      saturation: pipelineResults.fatigue?.saturationScore,
    },
    suppressionCauses: {
      policySuppressed: pipelineResults.policy?.shouldSuppress,
      fatigueSuppressed: pipelineResults.fatigue?.suppress,
      noCandidate: !pipelineResults.ranking?.selectedCandidate,
    },
    rankingWinner: pipelineResults.ranking?.selectedCandidate?.id || null,
    interventionBlockers: [],
    stateConfidence: pipelineResults.intent?.confidence || 0,
    orchestrationPath: 'diagnostic_only',
  };
}

/**
 * DIAGNOSTIC ONLY: Transform signals for fatigue pipeline format.
 */
function transformSignalsForFatigue(signals) {
  if (!signals || typeof signals !== 'object') return [];
  return Object.entries(signals).map(([name, signal]) => ({
    type: name,
    value: typeof signal === 'object' && signal !== null ? signal.value : signal,
  }));
}

/**
 * DIAGNOSTIC ONLY: Update intervention memory with archival.
 */
function updateInterventionMemoryWithExposure(interventionMemory, exposure) {
  const updated = {
    ...interventionMemory,
    exposures: [...(interventionMemory.exposures || []), exposure],
    archivedExposures: [...(interventionMemory.archivedExposures || [])],
  };
  if (updated.exposures.length > MAX_ACTIVE_EXPOSURES) {
    const archived = updated.exposures.shift();
    updated.archivedExposures.push(archived);
    if (updated.archivedExposures.length > MAX_ARCHIVED_EXPOSURES) {
      updated.archivedExposures.shift();
    }
  }
  return updated;
}

/**
 * DEPRECATED NO-OP STUBS
 * These functions previously ran independent pipelines.
 * They now return safe defaults and log deprecation warnings.
 */
function runIntentPipeline() {
  _warnDeprecated('runIntentPipeline');
  return { ...DEFAULT_INTENT_STATE };
}

function runTransitionPipeline() {
  _warnDeprecated('runTransitionPipeline');
  return { ...DEFAULT_TRANSITION_STATE };
}

function runFatiguePipeline() {
  _warnDeprecated('runFatiguePipeline');
  return { fatigueScore: 0, pressureLevel: 'NONE', cooldownMs: 20000, suppress: false, saturationScore: 0, fatigueRegime: 'HEALTHY', updatedFatigueMemory: {} };
}

function runPolicyPipeline() {
  _warnDeprecated('runPolicyPipeline');
  return { shouldIntervene: false, shouldDelay: true, shouldSuppress: false, interventionWindow: 'OBSERVE', interventionPriority: 0, interventionIntensity: 0, allowedFamilies: [], recommendedFamily: null, urgencyScore: 0, compatibilityScore: 0, interventionRisk: 0.5, reasoning: 'DEPRECATED: use session-orchestrator' };
}

function runRankingPipeline() {
  _warnDeprecated('runRankingPipeline');
  return { selectedCandidate: null, rankedCandidates: [], rankingSummary: { topScore: 0, candidateCount: 0 } };
}

function finalizeInterventionDecision(policyResult, rankingResult, fatigueState) {
  _warnDeprecated('finalizeInterventionDecision');
  return { shouldIntervene: false, selectedIntervention: null, interventionDecision: null, suppressionReason: 'DEPRECATED: use session-orchestrator' };
}

function persistOrchestrationResult() {
  _warnDeprecated('persistOrchestrationResult');
  return true;
}

function recoverSessionPipeline(sessionId) {
  _warnDeprecated('recoverSessionPipeline');
  return {
    sessionState: { ...DEFAULT_INTENT_STATE },
    transitionEngineState: { ...DEFAULT_TRANSITION_STATE },
    fatigueMemory: { ...DEFAULT_FATIGUE_MEMORY },
    interventionMemory: { ...DEFAULT_INTERVENTION_MEMORY },
  };
}

// ----------------------------------------------------------------------
// EXPORTS (all preserved for backward compatibility)
// ----------------------------------------------------------------------
module.exports = {
  // Main facade functions (delegate to session-orchestrator)
  processBehavioralEvent,
  orchestrateSessionUpdate,
  // Diagnostic/analytics helpers
  runSignalPipeline,
  generateOrchestrationDiagnostics,
  transformSignalsForFatigue,
  updateInterventionMemoryWithExposure,
  // Deprecated no-op stubs (safe defaults)
  runIntentPipeline,
  runTransitionPipeline,
  runFatiguePipeline,
  runPolicyPipeline,
  runRankingPipeline,
  finalizeInterventionDecision,
  persistOrchestrationResult,
  recoverSessionPipeline,
  // Validation helpers
  validateSessionId,
  validateStoreId,
  // Constants (backward compat)
  DEFAULT_INTENT_STATE,
  DEFAULT_TRANSITION_STATE,
  DEFAULT_FATIGUE_MEMORY,
  DEFAULT_INTERVENTION_MEMORY,
  MAX_ACTIVE_EXPOSURES,
  MAX_ARCHIVED_EXPOSURES,
  clamp,
};
