/**
 * session-orchestrator.js (v2 — enterprise restructure)
 *
 * =====================================================================
 * SINGLE ORCHESTRATION AUTHORITY for the OPE behavioral intelligence system.
 *
 * Enterprise restructure changes:
 *   - This is the ONLY orchestrator. real-time-orchestrator and
 *     ope-intelligence-hub have been degraded to utility facades.
 *   - Uses unified-intent-engine instead of interaction-transition-layer
 *     for intent inference (single intent authority).
 *   - Uses cooldown-fatigue-engine exclusively (single fatigue authority).
 *   - Uses message-ranking-engine exclusively (single ranking authority).
 *   - Integrates funnel-stage-engine for funnel tracking.
 *   - Integrates signal-derivation-engine for signal computation.
 *   - contextual-message-ranker is NOT used for ranking. Its context-building
 *     utilities may be used internally but ranking delegates to MRE.
 * =====================================================================
 *
 * Orquesta la interaccion entre:
 *  - behavioral-state-store               (estado central)
 *  - unified-intent-engine                (intent inference — SINGLE AUTHORITY)
 *  - intervention-policy-engine           (politica de intervencion)
 *  - message-ranking-engine               (ranking de mensajes — SINGLE AUTHORITY)
 *  - cooldown-fatigue-engine              (control de fatiga — SINGLE AUTHORITY)
 *  - funnel-stage-engine                  (funnel tracking)
 *  - internal-behavioral-event-bus        (eventos internos)
 *  - signal-derivation-engine             (computa signals)                   [opcional, inyectable]
 *  - context-presence-engine              (presencia real del usuario)        [opcional, inyectable]
 *  - message-visibility-controller        (renderizado efectivo de mensajes)  [opcional, inyectable]
 *  - logger-v2                            (logging estructurado)              [opcional, inyectable]
 *  - candidate-provider                   (provee message candidates)         [opcional, inyectable]
 *  - exposure-history-provider            (historial de exposiciones)         [opcional, inyectable]
 *  - scheduler                            (programa evaluaciones deferred)    [opcional, inyectable]
 *
 * Garantias:
 *  - Determinismo total: NO se usa Date.now() en ningun camino.
 *  - Replay-safe: snapshots incluyen schema version + identity + locks.
 *  - Sin listeners huerfanos: terminate/reset/dispose limpian todo.
 *  - Sin loops indirectos: NO se suscribe a sus propias emisiones.
 *  - Idempotencia: eventos con `eventId` recientes se deduplican.
 *  - Backpressure: cola interna con cap y drop policy explicita.
 *  - Watchdog: si el lock queda atascado, se libera.
 *  - GC: `_lastContextEvaluation` es un Map LRU acotado.
 *  - dispose(): teardown total.
 */

'use strict';

const { BehavioralStateStore } = require('./behavioral-state-store');
const { VALID_INTENT_STATES, INTENT_STATES, VALID_CONTEXTS: OPE_VALID_CONTEXTS, OWNERSHIP_MAP } = require('./ope-constants');
const { UnifiedIntentEngine } = require('./unified-intent-engine');
const { evaluateInterventionPolicy } = require('./intervention-policy-engine');
const { rankInterventions } = require('./message-ranking-engine');
const FunnelEngine = require('./funnel-stage-engine');
const HumanMessageEngine = require('./human-message-engine');
const { CooldownFatigueEngine } = require('./cooldown-fatigue-engine');
const { InternalBehavioralEventBus } = require('./internal-behavioral-event-bus');
const { DecisionExplainabilityEngine, DECISION_OUTCOMES } = require('./decision-explainability-engine');
const { InterventionOutcomeTracker, OUTCOME_TYPES } = require('./intervention-outcome-tracker');
const { InterventionLearningStore } = require('./intervention-learning-store');

// ── Hardening engines (optional — injectable, null-safe throughout) ──────────
const { UserMemoryEngine }     = require('./user-memory-engine');
const { MobileBehaviorEngine } = require('./mobile-behavior-engine');
const { ObservabilityEngine, DECISION_TYPES: OBS_DECISION_TYPES }  = require('./observability-engine');

// ----------------------------------------------------------------------
// Schema / constantes
// ----------------------------------------------------------------------
const SNAPSHOT_SCHEMA_VERSION = 4;

const VALID_CONTEXTS = Object.freeze([
  'listing',
  'modal',
  'hover_cta',
  'product_detail',
  'cart',
  'checkout',
]);

const VALID_EVENT_TYPES = Object.freeze(new Set([
  'PRODUCT_CHANGED',
  'CONTEXT_CHANGED',
  'HOVER_START',
  'HOVER_END',
  'MODAL_OPENED',
  'MODAL_CLOSED',
  'USER_ACTION',
  'SCROLL',
  'CLICK',
  'IMPRESSION',
  'DWELL_TICK',
  'PRESENCE_CHANGED',
  'VISIBILITY_CHANGED',
]));

const SIGNIFICANT_EVENT_TYPES = Object.freeze(new Set([
  'PRODUCT_CHANGED',
  'CONTEXT_CHANGED',
  'MODAL_OPENED',
  'HOVER_START',
  'USER_ACTION',
  'PRESENCE_CHANGED',
]));

const DEFAULT_CONFIG = Object.freeze({
  // Throttling global de evaluate()
  evaluationThrottleMs: 500,
  // Cooldown por context:product (LRU acotado)
  contextEvaluationCooldownMs: 1000,
  // Tiempo sin actividad antes de considerar la sesion inactiva
  sessionInactiveTimeoutMs: 30 * 60 * 1000,
  // Logging diagnostico
  enableDiagnosticLogs: false,
  // Cambio rapido de producto (informativo, no bloqueante)
  rapidProductChangeThresholdMs: 2000,
  // Re-evaluar inmediatamente al cambiar contexto/producto
  forceEvaluationOnContextChange: true,

  // Capacidad maxima del Map de _lastContextEvaluation (LRU)
  maxContextEvaluationEntries: 256,

  // Cap maximo del backlog de eventos (backpressure)
  maxEventQueueSize: 1024,
  // Politica de drop cuando se excede el cap
  // 'drop-oldest' | 'drop-newest' | 'throw'
  eventDropPolicy: 'drop-oldest',

  // Watchdog del lock de evaluacion
  lockWatchdogMs: 5000,

  // P2-HARDEN: Circular trace log capacity
  traceLogCapacity: 512,

  // Ventana de deduplicacion por eventId
  idempotencyWindowMs: 30 * 1000,
  // Maximo de eventIds recientes recordados (cap LRU)
  maxRecentEventIds: 2048,

  // Sampling de eventos `INTERVENTION_BLOCKED` y `INTERVENTION_DENIED`
  // 1 = emitir siempre, 10 = uno de cada 10
  blockedDeniedSamplingRate: 5,

  // Si se debe rechazar candidates ficticios. Para tests forzar false.
  requireCandidateProvider: true,

  // Si se debe rechazar exposure history ficticio.
  requireExposureProvider: false,

  // Si se debe consultar context-presence-engine antes de evaluar
  requirePresenceCheck: false,

  // Si se debe consultar message-visibility-controller antes de showMessage
  requireVisibilityCheck: false,

  // Schema interno para validar `event.type` en processEvent
  strictEventTypeValidation: true,
});

// ----------------------------------------------------------------------
// Utils
// ----------------------------------------------------------------------

/**
 * Map LRU minimalista (insertion-order via Map de JS).
 * `set` mueve la key al final (mas reciente); cuando se excede `cap`,
 * se eliminan las keys mas viejas (al principio).
 */
class LRUMap {
  constructor(cap) {
    this._cap = cap;
    this._map = new Map();
  }
  get size() { return this._map.size; }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    // refresh recency
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this._cap) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
  has(key) { return this._map.has(key); }
  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
}

function safeArrayPush(arr, item, cap) {
  arr.push(item);
  while (arr.length > cap) arr.shift();
}

// ----------------------------------------------------------------------
// Clase principal
// ----------------------------------------------------------------------
class SessionOrchestrator {
  /**
   * @param {object} config       Configuracion (sobrescribe DEFAULT_CONFIG)
   * @param {object} dependencies Dependencias inyectables
   *
   * dependencies = {
   *   stateStore, transitionLayer, fatigueEngine, eventBus,
   *   presenceEngine, visibilityController, signalDerivationEngine,
   *   candidateProvider, exposureHistoryProvider,
   *   logger, scheduler
   * }
   */
  constructor(config = {}, dependencies = {}) {
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    // Core (obligatorios; default a implementaciones internas si no se pasan)
    this.stateStore       = dependencies.stateStore       || new BehavioralStateStore(this.config);
    this.intentEngine     = dependencies.intentEngine     || new UnifiedIntentEngine(this.config);
    this.fatigueEngine    = dependencies.fatigueEngine    || new CooldownFatigueEngine(this.config);
    this.eventBus         = dependencies.eventBus         || new InternalBehavioralEventBus(this.config);
    this.funnelEngine     = dependencies.funnelEngine     || FunnelEngine;

    // Opcionales (sin defaults: ausencia = no-op)
    this.presenceEngine          = dependencies.presenceEngine          || null;
    this.visibilityController    = dependencies.visibilityController    || null;
    this.signalDerivationEngine  = dependencies.signalDerivationEngine  || null;
    this.candidateProvider       = dependencies.candidateProvider       || null;
    this.exposureHistoryProvider = dependencies.exposureHistoryProvider || null;
    this.logger                  = dependencies.logger                  || null;
    // scheduler.schedule(fn, now) -> handle, scheduler.cancel(handle)
    // Si no se inyecta, las evaluaciones deferred se procesan en el proximo
    // processEvent/evaluate (cooperativo, sin timers globales).
    this.scheduler = dependencies.scheduler || null;

    // Explainability / outcome / learning layers (injectable, default to internal instances)
    this.explainabilityEngine = dependencies.explainabilityEngine || new DecisionExplainabilityEngine();
    this.outcomeTracker       = dependencies.outcomeTracker       || new InterventionOutcomeTracker();
    this.learningStore        = dependencies.learningStore        || new InterventionLearningStore();

    // ── Optional hardening engines (default to internal singletons if not injected) ──
    this.userMemoryEngine    = dependencies.userMemoryEngine    || new UserMemoryEngine();
    this.mobileBehaviorEngine = dependencies.mobileBehaviorEngine || new MobileBehaviorEngine();
    this.observabilityEngine  = dependencies.observabilityEngine  || new ObservabilityEngine();

    // ----- Estado interno del orchestrator -----
    this._sessionId = null;
    this._storeId = null;
    this._initialized = false;
    this._disposed = false;

    this._lastEvaluationTime = 0;
    this._lastContextEvaluation = new LRUMap(this.config.maxContextEvaluationEntries);

    this._evaluationLock = false;
    this._lockAcquiredAt = 0;
    this._pendingEvaluation = false;
    this._pendingEvaluationNow = 0;

    // Cola interna de eventos (backpressure)
    this._eventQueue = [];
    this._processingQueue = false;

    // Idempotencia
    this._recentEventIds = new LRUMap(this.config.maxRecentEventIds);

    // Sampling counters
    this._blockedEmitCounter = 0;
    this._deniedEmitCounter = 0;

    // Diagnostico
    this._stats = {
      eventsProcessed: 0,
      eventsDeduped: 0,
      eventsDropped: 0,
      eventsRejectedInvalid: 0,
      evaluationsAttempted: 0,
      evaluationsCompleted: 0,
      evaluationsBlockedByFatigue: 0,
      evaluationsDeniedByPolicy: 0,
      evaluationsThrottled: 0,
      evaluationsContextCooled: 0,
      interventionsTriggered: 0,
      lockStuckIncidents: 0,
      handlerErrors: 0,
    };

    this._version = 1;

    // Listeners externos registrados por el orchestrator (para teardown).
    // NOTA: NO nos suscribimos a CONTEXT_CHANGED ni a ningun evento que
    // nosotros mismos emitamos (evita loops indirectos). Si en el futuro
    // se agregan listeners, deben ir aca via _registerBusListener para
    // garantizar cleanup en terminate/reset/dispose.
    this._busListeners = [];

    // Handle del scheduler (si se inyecto uno)
    this._deferredHandle = null;

    // P2-HARDEN: Circular trace log for orchestration debugging.
    // Each entry: { type, payload, now, seq }
    this._traceLog = [];
    this._traceSeq = 0;

    // P2-HARDEN: Decision history for deterministic replay validation.
    // Stores hashes of { event_sequence -> decision_outcome } for comparison.
    this._decisionHistory = [];
  }

  // ====================================================================
  // Lifecycle
  // ====================================================================

  /**
   * Inicializa la orquestacion para una sesion.
   * @param {string} sessionId
   * @param {string} storeId
   * @param {number} now
   * @param {object} [snapshot]
   */
  initialize(sessionId, storeId, now, snapshot = null) {
    this._assertAlive();
    if (this._initialized) {
      this._log('warn', 'initialize() called twice on the same instance; ignoring');
      return;
    }
    this._validateNow(now);

    this._sessionId = sessionId;
    this._storeId = storeId;

    this.stateStore.initialize(now);
    this.intentEngine.initialize('exploring', now);
    this.fatigueEngine.reset(now);

    if (snapshot) this.restore(snapshot, now);

    this._lastEvaluationTime = now;
    this._initialized = true;

    this._log('info', `Session initialized: ${sessionId} (store ${storeId})`);
    this._safeEmit('SESSION_STARTED', { sessionId, storeId }, now, 'HIGH');
  }

  /**
   * Termina la sesion: emite evento, limpia listeners, cancela deferred,
   * libera referencias mutables. NO destruye la instancia: para eso usar
   * dispose(). El uso tipico es terminate -> snapshot -> dispose.
   */
  terminate(now) {
    if (this._disposed) return;
    this._validateNow(now);

    this._safeEmit('SESSION_ENDED', { sessionId: this._sessionId }, now, 'HIGH');
    this._log('info', `Session terminated: ${this._sessionId}`);

    // Flush outcomes to learning store before clearing sessionId
    if (this._sessionId && this.outcomeTracker && this.learningStore) {
      try {
        this.outcomeTracker.closeSession(this._sessionId, now);
        const outcomes = this.outcomeTracker.getOutcomesForLearning(this._sessionId);
        if (outcomes.length > 0) {
          this.learningStore.ingestOutcomes(outcomes, {}, now);
        }
        this.outcomeTracker.cleanup(now);
        this.explainabilityEngine.cleanup(now);
        this.learningStore.cleanup(now);
      } catch (err) {
        this._reportError(err, 'learning_store_flush', now);
      }
    }

    this._cancelDeferred();
    this._cleanupEventListeners();

    this._sessionId = null;
    this._storeId = null;
    this._initialized = false;

    this._evaluationLock = false;
    this._pendingEvaluation = false;
    this._eventQueue.length = 0;
    this._processingQueue = false;
    this._lastContextEvaluation.clear();
    this._recentEventIds.clear();
    // P2-HARDEN: Clear trace state on terminate
    this._traceLog.length = 0;
    this._traceSeq = 0;
    this._decisionHistory.length = 0;
  }

  /**
   * Teardown total. Tras dispose() la instancia es inservible y cualquier
   * metodo publico lanza una excepcion via _assertAlive.
   */
  dispose() {
    if (this._disposed) return;
    this._cancelDeferred();
    this._cleanupEventListeners();
    this._eventQueue.length = 0;
    this._processingQueue = false;
    this._lastContextEvaluation.clear();
    this._recentEventIds.clear();
    // P2-HARDEN: Clear trace state on dispose
    this._traceLog.length = 0;
    this._traceSeq = 0;
    this._decisionHistory.length = 0;
    this._sessionId = null;
    this._storeId = null;
    this._initialized = false;
    this._disposed = true;
  }

  /**
   * Reinicia el orquestador conservando los listeners registrados.
   * Util para reiniciar una sesion sin recrear la instancia.
   */
  reset(now) {
    this._assertAlive();
    this._validateNow(now);

    this._cancelDeferred();
    this.stateStore.reset(now);
    this.intentEngine.reset(now);
    this.fatigueEngine.reset(now);

    this._lastEvaluationTime = now;
    this._lastContextEvaluation.clear();
    this._evaluationLock = false;
    this._lockAcquiredAt = 0;
    this._pendingEvaluation = false;
    this._pendingEvaluationNow = 0;
    this._eventQueue.length = 0;
    this._processingQueue = false;
    this._recentEventIds.clear();
    this._blockedEmitCounter = 0;
    this._deniedEmitCounter = 0;
    this._version++;
    // P2-HARDEN: Clear trace state on reset
    this._traceLog.length = 0;
    this._traceSeq = 0;
    this._decisionHistory.length = 0;

    this._safeEmit('SESSION_RESET', { sessionId: this._sessionId }, now, 'HIGH');
    this._log('info', 'Session orchestrator reset');
  }

  // ====================================================================
  // Entrada de eventos
  // ====================================================================

  /**
   * Procesa un evento externo.
   * @param {object} event { type, payload, eventId?, ts? }
   * @param {number} now
   * @returns {object} { accepted, reason? }
   */
  processEvent(event, now) {
    this._assertAlive();
    this._validateNow(now);

    if (!this._initialized) {
      this._log('warn', 'Cannot process event: session not initialized');
      return { accepted: false, reason: 'not_initialized' };
    }

    // 1. Validacion estructural
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      this._stats.eventsRejectedInvalid++;
      this._log('warn', 'Invalid event shape');
      return { accepted: false, reason: 'invalid_event_shape' };
    }
    if (this.config.strictEventTypeValidation && !VALID_EVENT_TYPES.has(event.type)) {
      this._stats.eventsRejectedInvalid++;
      this._log('warn', `Unknown event type: ${event.type}`);
      this._safeEmit('__orchestrator:unknown_event', { type: event.type }, now, 'LOW');
      return { accepted: false, reason: 'unknown_event_type' };
    }

    // 2. Idempotencia
    if (event.eventId) {
      const seenAt = this._recentEventIds.get(event.eventId);
      if (seenAt !== undefined && now - seenAt < this.config.idempotencyWindowMs) {
        this._stats.eventsDeduped++;
        this._safeEmit('EVENT_DEDUPED', { eventId: event.eventId, type: event.type }, now, 'LOW');
        return { accepted: false, reason: 'duplicate' };
      }
      this._recentEventIds.set(event.eventId, now);
    }

    // 3. Backpressure
    if (this._eventQueue.length >= this.config.maxEventQueueSize) {
      const policy = this.config.eventDropPolicy;
      if (policy === 'throw') {
        throw new Error('SessionOrchestrator: event queue overflow');
      }
      if (policy === 'drop-newest') {
        this._stats.eventsDropped++;
        this._safeEmit('__orchestrator:event_dropped', { type: event.type, policy }, now, 'LOW');
        return { accepted: false, reason: 'queue_full_drop_newest' };
      }
      // drop-oldest (default)
      this._eventQueue.shift();
      this._stats.eventsDropped++;
      this._safeEmit('__orchestrator:event_dropped', { policy }, now, 'LOW');
    }

    // ── Mobile behavior recording (null-safe; no-op on desktop) ──────────────
    if (this.mobileBehaviorEngine && this._sessionId) {
      const pl = event.payload || {};
      if (event.type === 'SCROLL') {
        try {
          this.mobileBehaviorEngine.recordScroll({
            sessionId: this._sessionId,
            deltaY:      typeof pl.deltaY      === 'number' ? pl.deltaY      : 0,
            deltaX:      typeof pl.deltaX      === 'number' ? pl.deltaX      : 0,
            velocityPxMs: typeof pl.velocityPxMs === 'number' ? pl.velocityPxMs : undefined,
            nowMs: now,
          });
        } catch (_) {}
      }
    }

    this._eventQueue.push({ event, now });
    this._drainEventQueue();
    return { accepted: true };
  }

  // ----- Internal: drena la cola serialmente -----
  _drainEventQueue() {
    if (this._processingQueue) return;
    this._processingQueue = true;
    try {
      while (this._eventQueue.length > 0) {
        const { event, now } = this._eventQueue.shift();
        this._handleEventInternal(event, now);
      }
    } finally {
      this._processingQueue = false;
    }
  }

  _handleEventInternal(event, now) {
    this._stats.eventsProcessed++;
    // P2-HARDEN: Trace every processed event
    this._trace('event', { type: event.type, payload: event.payload }, now);

    // Trazabilidad: re-emitimos al bus para que otros engines escuchen.
    // NOTA: nosotros NO escuchamos esta misma emision (evita loops).
    this._safeEmit(event.type, event.payload, now, 'NORMAL', 'external');

    try {
      switch (event.type) {
        case 'PRODUCT_CHANGED':
          this._handleProductChange(event.payload && event.payload.productId, now);
          break;
        case 'CONTEXT_CHANGED':
          this._handleContextChange(event.payload && event.payload.context, now);
          break;
        case 'HOVER_START':
          this._handleHoverStart(
            event.payload && event.payload.elementId,
            event.payload && event.payload.productId,
            now,
          );
          break;
        case 'HOVER_END':
          this._handleHoverEnd(now);
          break;
        case 'MODAL_OPENED':
          this._handleModalOpen(event.payload && event.payload.productId, now);
          break;
        case 'MODAL_CLOSED':
          this._handleModalClose(now);
          break;
        case 'USER_ACTION':
          this._handleUserAction(event.payload || {}, now);
          break;
        case 'PRESENCE_CHANGED':
          // Solo informativo; presenceEngine ya recibe directamente sus eventos.
          break;
        default:
          // Otros eventos validos: trigger evaluacion si son significativos
          break;
      }
    } catch (err) {
      this._stats.handlerErrors++;
      this._reportError(err, `handler:${event.type}`, now);
    }

    // Una sola programacion de evaluacion por evento (antes habia doble).
    if (SIGNIFICANT_EVENT_TYPES.has(event.type)) {
      this._scheduleEvaluation(now, /* immediate */ false);
    }
  }

  // ====================================================================
  // Evaluacion principal
  // ====================================================================

  /**
   * Ejecuta la evaluacion completa con side-effects.
   * Devuelve la decision o null.
   */
  evaluate(now) {
    this._assertAlive();
    this._validateNow(now);
    if (!this._initialized) return null;
    this._stats.evaluationsAttempted++;

    // Watchdog: si el lock lleva atascado demasiado, lo liberamos
    if (this._evaluationLock && (now - this._lockAcquiredAt) > this.config.lockWatchdogMs) {
      this._stats.lockStuckIncidents++;
      this._evaluationLock = false;
      this._safeEmit('__orchestrator:lock_stuck', {
        ageMs: now - this._lockAcquiredAt,
      }, now, 'HIGH');
    }

    if (this._evaluationLock) {
      this._pendingEvaluation = true;
      this._pendingEvaluationNow = now;
      return null;
    }

    this._evaluationLock = true;
    this._lockAcquiredAt = now;

    const _perfStart = now; // deterministic: no Date.now()
    try {
      const decision = this._evaluateCore(now, /* dryRun */ false);

      // ── Observability: record decision outcome ───────────────────────────
      if (this.observabilityEngine && this._sessionId) {
        try {
          const state       = this.stateStore.getState();
          const obsDecision = decision
            ? OBS_DECISION_TYPES.INTERVENE
            : OBS_DECISION_TYPES.DO_NOTHING;
          this.observabilityEngine.recordDecision({
            sessionId:      this._sessionId,
            decision:       obsDecision,
            confidence:     state.intentConfidence || 0,
            reason:         decision ? 'all_gates_passed' : 'gate_blocked_or_no_candidates',
            context:        state.currentContext,
            signals:        null, // avoid serializing large object on every eval
            selectedFamily: decision && decision.selectedIntervention
              ? decision.selectedIntervention.family
              : null,
            nowMs: now,
          });
        } catch (_) {}
      }

      return decision;
    } catch (err) {
      // ── Observability: record error ──────────────────────────────────────
      if (this.observabilityEngine) {
        try {
          this.observabilityEngine.recordError({
            sessionId: this._sessionId,
            errorCode: 'EVALUATE_ERROR',
            message:   err && err.message,
            severity:  'high',
            context:   'evaluate',
            nowMs:     now,
          });
        } catch (_) {}
      }
      this._reportError(err, 'evaluate', now);
      return null;
    } finally {
      this._evaluationLock = false;
      this._lockAcquiredAt = 0;

      // Si hubo evaluacion pendiente, reprogramar (sin recursion sincrona profunda)
      if (this._pendingEvaluation) {
        const nextNow = Math.max(this._pendingEvaluationNow || 0, now);
        this._pendingEvaluation = false;
        this._pendingEvaluationNow = 0;
        // Encolar como evaluacion deferred (no recursion sincrona)
        this._scheduleEvaluation(nextNow, /* immediate */ false);
      }
    }
  }

  /**
   * Variante pura: ejecuta la misma logica de decision SIN tocar el store,
   * sin emitir eventos, sin registrar intervenciones ni mover contadores.
   * Ideal para tests, dry-runs y session-simulator-runner.
   */
  evaluatePreview(now) {
    this._assertAlive();
    this._validateNow(now);
    if (!this._initialized) return null;
    return this._evaluateCore(now, /* dryRun */ true);
  }

  _evaluateCore(now, dryRun) {
    // Gates 1..N. Throttle se aplica DESPUES de los gates para no consumir
    // el budget de throttling con evaluaciones que fueron descartadas por
    // cooldown/fatiga/policy.
    if (!dryRun && (now - this._lastEvaluationTime) < this.config.evaluationThrottleMs) {
      this._stats.evaluationsThrottled++;
      return null;
    }

    // ---- 1. State actual (read-only snapshot, deep-frozen por el store) ----
    const state = this.stateStore.getState();
    const context = state.currentContext;
    const productId = state.activeProductId;

    // ---- EXPLAINABILITY: open a decision record for this evaluation ----
    const decisionBuilder = this.explainabilityEngine.openDecision({
      sessionId: this._sessionId,
      storeId: this._storeId,
      context,
      productId,
      nowMs: now,
    });
    if (dryRun) decisionBuilder.asDryRun();

    // ---- 2. Presencia (opcional) ----
    if (this.config.requirePresenceCheck && this.presenceEngine) {
      const present = !!this.presenceEngine.isPresent(now);
      if (!present) {
        decisionBuilder.gateReject('presence', 'not_present').suppress('not_present');
        this._sampledEmit('INTERVENTION_BLOCKED',
          { reason: 'not_present' }, now, 'NORMAL', '_blockedEmitCounter');
        return null;
      }
    }
    decisionBuilder.gatePass('presence');

    // ---- 3. Cooldown por context:product ----
    const contextKey = `${context}:${productId || 'global'}`;
    const lastEval = this._lastContextEvaluation.get(contextKey) || 0;
    if (lastEval && (now - lastEval) < this.config.contextEvaluationCooldownMs) {
      this._stats.evaluationsContextCooled++;
      decisionBuilder.gateReject('context_cooldown', 'context_cooldown_active').commit(DECISION_OUTCOMES.BLOCKED, 'context_cooldown');
      return null;
    }
    decisionBuilder.gatePass('context_cooldown');

    // ---- 4. Update intent engine (unified-intent-engine — SINGLE AUTHORITY) ----
    let signals = {};
    if (this.signalDerivationEngine && typeof this.signalDerivationEngine.deriveSignals === 'function') {
      try {
        signals = this.signalDerivationEngine.deriveSignals(state, now) || {};
      } catch (err) {
        this._reportError(err, 'signal_derivation', now);
        signals = {};
      }
    }

    // ── User memory: enrich signals (read-only, non-forcing) ────────────────
    let userMemorySignals = null;
    if (this.userMemoryEngine && this._sessionId) {
      try {
        const mem = this.userMemoryEngine.getUserMemory(this._sessionId, this._userId || null, now);
        if (mem.shortTerm) {
          const patterns = mem.shortTerm.sessionPatterns;
          userMemorySignals = {
            sessionDismissals:   patterns.dismissals,
            sessionHesitations:  patterns.hesitations,
            sessionRevisits:     patterns.revisits,
            sessionCartAdds:     patterns.cartAdds,
            sessionExits:        patterns.exits,
            // Only advise; never force block or force intervene
            memoryAdvises:       patterns.dismissals >= 2 ? 'reduce_frequency' : null,
          };
          // Merge into signals (non-destructive: signals values take precedence)
          signals = Object.assign({ userMemory: userMemorySignals }, signals);
        }
      } catch (_) {}
    }

    // ── Mobile intent: enrich signals when on mobile ──────────────────────────
    let mobileIntentResult = null;
    if (this.mobileBehaviorEngine && this._sessionId) {
      try {
        mobileIntentResult = this.mobileBehaviorEngine.inferMobileIntent({
          sessionId:       this._sessionId,
          nowMs:           now,
          currentElement:  context || null,
        });
        if (mobileIntentResult.confidence > 0) {
          signals = Object.assign({ mobileIntent: mobileIntentResult }, signals);
        }
      } catch (_) {}
    }

    const intentResult = this.intentEngine.update(now);
    if (!dryRun && intentResult && intentResult.transitionOccurred) {
      this.stateStore.setIntentState(intentResult.currentState, intentResult.stateConfidence, now);
      this._safeEmit('INTENT_CHANGED', {
        from: intentResult.previousState,
        to: intentResult.currentState,
        confidence: intentResult.stateConfidence,
      }, now, 'HIGH');
    }

    // ---- 4b. Funnel stage tracking (feeds into ranking context) ----
    let funnelResult = null;
    if (this.funnelEngine && typeof this.funnelEngine.getCurrentStage === 'function') {
      try {
        funnelResult = {
          currentStage: this.funnelEngine.getCurrentStage(this._sessionId, now),
          messagePriorities: this.funnelEngine.getMessagePriorities(this._sessionId, now),
        };
      } catch (err) {
        this._reportError(err, 'funnel_engine', now);
      }
    }

    // ---- 5. Fatiga y cooldowns ----
    const fatigueScore = this.fatigueEngine.getFatigueScore(now);
    const canIntervene = this.fatigueEngine.canIntervene(context, productId, null, now);
    decisionBuilder.withFatigueSnapshot({ fatigueScore, canIntervene: canIntervene.allowed, reason: canIntervene.reason || null });
    if (!canIntervene.allowed) {
      this._stats.evaluationsBlockedByFatigue++;
      decisionBuilder.gateReject('fatigue', canIntervene.reason || 'fatigue_blocked').commit(DECISION_OUTCOMES.BLOCKED, canIntervene.reason);
      this._sampledEmit('INTERVENTION_BLOCKED', {
        reason: canIntervene.reason,
        fatigueScore,
      }, now, 'NORMAL', '_blockedEmitCounter');
      return null;
    }
    decisionBuilder.gatePass('fatigue');

    // ---- 6. Politica ----
    const saturationScore = (this.fatigueEngine.getSaturationScore
      && this.fatigueEngine.getSaturationScore(now)) || 0;
    const recentDismissals = (this.fatigueEngine.getRecentDismissals
      && this.fatigueEngine.getRecentDismissals(now)) || 0;
    const frictionLevel = (signals && typeof signals.frictionLevel === 'number')
      ? signals.frictionLevel : 0;
    const emotionalState = (signals && typeof signals.emotionalState === 'string')
      ? signals.emotionalState : 'neutral';

    const sessionState = {
      intentState: state.stableIntentState,
      confidence: state.intentConfidence,
      frictionLevel,
      momentumScore: (intentResult && intentResult.momentumScore) || 0,
      emotionalState,
      currentPage: context,
    };

    const policyResult = evaluateInterventionPolicy({
      sessionState,
      signals,
      fatigueState: { fatigueScore, saturationScore },
      transitionState: {
        oscillationRisk: intentResult && intentResult.oscillationRisk,
        stability: intentResult && intentResult.stateStability,
      },
      recentDismissals,
      now,
    });

    if (!policyResult.shouldIntervene || policyResult.shouldSuppress || policyResult.shouldDelay) {
      this._stats.evaluationsDeniedByPolicy++;
      const policyDenyReason = policyResult.shouldSuppress ? 'policy_suppress'
        : policyResult.shouldDelay ? 'policy_delay' : 'policy_no_intervene';
      const policyOutcome = policyResult.shouldDelay ? DECISION_OUTCOMES.DELAYED : DECISION_OUTCOMES.DENIED;
      decisionBuilder.gateReject('policy', policyDenyReason).commit(policyOutcome, policyDenyReason);
      const sanitized = {
        shouldIntervene: policyResult.shouldIntervene,
        shouldSuppress: policyResult.shouldSuppress,
        shouldDelay: policyResult.shouldDelay,
        reasoning: policyResult.reasoning,
        interventionRisk: policyResult.interventionRisk,
      };
      this._sampledEmit('INTERVENTION_DENIED', sanitized, now, 'NORMAL', '_deniedEmitCounter');
      return null;
    }
    decisionBuilder.gatePass('policy');

    // ---- 7. Candidatos (provider obligatorio si requireCandidateProvider=true) ----
    const candidates = this._getMessageCandidates(context, productId, state, now);
    if (!candidates || candidates.length === 0) {
      decisionBuilder.commit(DECISION_OUTCOMES.NO_CANDIDATES, 'no_candidates_available');
      return null;
    }
    decisionBuilder.gatePass('candidates');

    // ---- 8. Ranking (message-ranking-engine — SINGLE AUTHORITY) ----
    const rankingResult = rankInterventions(candidates, {
      sessionState,
      signals,
      fatigueState: { fatigueScore },
      transitionState: { stability: intentResult && intentResult.stateStability },
      funnelState: funnelResult,
      exposureHistory: this._getExposureHistory(now),
      interventionRisk: policyResult.interventionRisk,
      now,
    });
    if (!rankingResult || !rankingResult.selectedCandidate) {
      decisionBuilder.commit(DECISION_OUTCOMES.NO_CANDIDATES, 'ranking_returned_no_candidate');
      return null;
    }
    const selected = rankingResult.selectedCandidate;
    // Capture ranking scores for explainability
    const rejectedFamilies = (rankingResult.rankedCandidates || [])
      .filter(c => c !== selected)
      .map(c => c.family || c.subtype || 'unknown');
    decisionBuilder.withRankingResult({
      selected,
      rejected: rejectedFamilies,
      scores: rankingResult.rankingSummary || null,
    });
    decisionBuilder.gatePass('ranking');

    // ---- 9. Visibility check (opcional) ----
    if (this.config.requireVisibilityCheck && this.visibilityController) {
      const canRender = !!this.visibilityController.canRender({
        context,
        productId,
        family: selected.family,
        subtype: selected.subtype,
        now,
      });
      if (!canRender) {
        decisionBuilder.gateReject('visibility', 'not_visible').suppress('not_visible');
        this._sampledEmit('INTERVENTION_BLOCKED',
          { reason: 'not_visible' }, now, 'NORMAL', '_blockedEmitCounter');
        return null;
      }
    }
    decisionBuilder.gatePass('visibility');

    // Hasta aca todos los gates pasaron.
    if (dryRun) {
      decisionBuilder.commit(DECISION_OUTCOMES.DRY_RUN, 'dry_run_evaluation');
      return {
        selectedIntervention: selected,
        policyResult,
        rankingResult,
        intentResult,
        funnelResult,
        fatigueScore,
      };
    }

    // ---- 10. Side-effects (solo en modo real) ----
    this._lastEvaluationTime = now;
    this._lastContextEvaluation.set(contextKey, now);

    this.fatigueEngine.registerIntervention({
      context,
      productId,
      family: selected.family,
      hoverElementId: (state.hoverState && state.hoverState.elementId) || null,
      now,
    });

    this.stateStore.showMessage(
      { id: selected.id, family: selected.family, subtype: selected.subtype },
      context,
      now,
    );

    this._stats.evaluationsCompleted++;
    this._stats.interventionsTriggered++;

    // Approve and commit the explainability record
    const decisionId = decisionBuilder.approve('all_gates_passed');

    // Register exposure in outcome tracker (linked to decisionId)
    const intentState = state.stableIntentState || null;
    const funnelStage = funnelResult && funnelResult.currentStage ? funnelResult.currentStage : null;
    this.outcomeTracker.recordExposure({
      decisionId,
      messageId: selected.id,
      sessionId: this._sessionId,
      storeId: this._storeId,
      productId,
      context,
      family: selected.family,
      subtype: selected.subtype || null,
      intentStateAtExposure: intentState,
      funnelStageAtExposure: funnelStage,
      hesitationScoreAtExposure: (intentResult && typeof intentResult.hesitationScore === 'number') ? intentResult.hesitationScore : null,
      revenueAtExposure: 0,
      nowMs: now,
    });

    // P2-HARDEN: Trace the decision
    const decisionResult = {
      selectedIntervention: selected,
      policyResult,
      rankingResult,
      intentResult,
      funnelResult,
      fatigueScore,
    };
    this._trace('decision', {
      family: selected.family,
      subtype: selected.subtype,
      id: selected.id,
      context,
      productId,
    }, now);
    this._recordDecisionForReplay(this._traceSeq, decisionResult, now);

    const decision = {
      candidate: selected,
      policy: {
        shouldIntervene: policyResult.shouldIntervene,
        reasoning: policyResult.reasoning,
        interventionRisk: policyResult.interventionRisk,
      },
      ranking: rankingResult.rankingSummary,
      context,
      productId,
      timestamp: now,
    };
    this._safeEmit('INTERVENTION_TRIGGERED', decision, now, 'HIGH');
    this._log('info', `Intervention triggered: ${selected.family} (${selected.subtype}) in ${context}`);

    return {
      selectedIntervention: selected,
      policyResult,
      rankingResult,
      intentResult,
      funnelResult,
      fatigueScore,
    };
  }

  // ====================================================================
  // Handlers de contexto / producto / hover / modal
  // ====================================================================

  _handleProductChange(productId, now) {
    if (productId === undefined || productId === null) return;
    const oldProduct = this.stateStore.getState().activeProductId;
    if (oldProduct === productId) return;

    this.stateStore.setActiveProduct(productId, now);

    // Invariante: cambiar de producto invalida hover_cta para el producto previo.
    // El store ya limpia hover/dwell/cooldowns del producto previo en
    // setActiveProduct, asi que no llamamos resetContextState aca para evitar
    // double-clear y bumps de version redundantes.

    this._safeEmit('PRODUCT_CHANGED', { oldProduct, newProduct: productId }, now, 'HIGH');
    this._log('info', `Product changed from ${oldProduct} to ${productId}`);

    if (this.config.forceEvaluationOnContextChange) {
      this._scheduleEvaluation(now, /* immediate */ true);
    }
  }

  _handleContextChange(context, now) {
    if (!context || typeof context !== 'string') return;
    if (!VALID_CONTEXTS.includes(context)) {
      this._log('warn', `Rejected invalid context: ${context}`);
      this._safeEmit('__orchestrator:invalid_context', { context }, now, 'LOW');
      return;
    }
    const oldContext = this.stateStore.getState().currentContext;
    if (oldContext === context) return;

    this.stateStore.setContext(context, now);

    // El cleanup contextual ahora vive en el store (cobertura completa).
    // Aca solo decidimos si el mensaje visible sigue siendo coherente con el
    // nuevo contexto. El store ya limpia mensajes huerfanos en contextos
    // no-presentables (cart, checkout, product_detail) en su _cleanupOnContextChange.

    this._safeEmit('CONTEXT_CHANGED', { from: oldContext, to: context }, now, 'HIGH');
    this._log('info', `Context changed from ${oldContext} to ${context}`);

    if (this.config.forceEvaluationOnContextChange) {
      this._scheduleEvaluation(now, /* immediate */ true);
    }
  }

  _handleHoverStart(elementId, productId, now) {
    if (!elementId || !productId) return;
    const state = this.stateStore.getState();

    // Si habia hover abierto sobre otro elemento, cerrarlo primero para evitar
    // hover-zombie (HOVER_START sin HOVER_END previo).
    if (state.hoverState && state.hoverState.active &&
        state.hoverState.elementId !== elementId) {
      this.stateStore.setHoverState(
        { active: false, elementId: null, productId: null, startedAt: null },
        now,
      );
      this._safeEmit('HOVER_ENDED', { reason: 'replaced' }, now, 'LOW');
    }

    this.stateStore.setHoverState(
      { active: true, elementId, productId, startedAt: now },
      now,
    );
    this.stateStore.incrementHoverCount(productId, now);

    this._safeEmit('HOVER_STARTED', { elementId, productId }, now, 'NORMAL');
    this._scheduleEvaluation(now, /* immediate */ false);
  }

  _handleHoverEnd(now) {
    const state = this.stateStore.getState();
    if (!state.hoverState || !state.hoverState.active) return;
    this.stateStore.setHoverState(
      { active: false, elementId: null, productId: null, startedAt: null },
      now,
    );
    this._safeEmit('HOVER_ENDED', {}, now, 'NORMAL');
  }

  _handleModalOpen(productId, now) {
    if (!productId) return;
    const state = this.stateStore.getState();

    // Invariante: si el modal abre sobre un producto distinto del activo,
    // sincronizamos activeProductId con el producto del modal.
    if (state.activeProductId !== productId) {
      this.stateStore.setActiveProduct(productId, now);
    }

    // Una sola fuente de verdad: el store se encarga de mantener
    // modalState.reopenCount como campo derivado de sessionMemory.modalReopens.
    this.stateStore.setModalState({ isOpen: true, productId, openedAt: now }, now);
    this.stateStore.incrementModalReopen(now);

    this._safeEmit('MODAL_OPENED', { productId }, now, 'HIGH');
    this._scheduleEvaluation(now, /* immediate */ false);
  }

  _handleModalClose(now) {
    const state = this.stateStore.getState();
    if (!state.modalState || !state.modalState.isOpen) return;
    this.stateStore.setModalState(
      { isOpen: false, productId: null, openedAt: null },
      now,
    );
    this._safeEmit('MODAL_CLOSED', {}, now, 'NORMAL');
  }

  _handleUserAction(payload, now) {
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type;

    if (type === 'add_to_cart') {
      if (typeof this.fatigueEngine.registerPositiveSignal === 'function') {
        this.fatigueEngine.registerPositiveSignal(now);
      }
      // Track positive behavioral outcomes in the outcome tracker
      if (this.outcomeTracker && this._sessionId) {
        const evType = event && event.type;
        let outcomeType = null;
        if (evType === 'USER_ACTION' && event.payload && event.payload.action === 'add_to_cart') {
          outcomeType = OUTCOME_TYPES.ADD_TO_CART_AFTER;
        } else if (evType === 'USER_ACTION' && event.payload && event.payload.action === 'checkout') {
          outcomeType = OUTCOME_TYPES.CHECKOUT_AFTER;
        } else if (evType === 'USER_ACTION' && event.payload && event.payload.action === 'dismiss_message') {
          outcomeType = OUTCOME_TYPES.DISMISSED;
        } else if (evType === 'USER_ACTION' && event.payload && event.payload.action === 'click_message') {
          outcomeType = OUTCOME_TYPES.CLICKED;
        } else if (evType === 'PRODUCT_CHANGED') {
          outcomeType = OUTCOME_TYPES.REVISIT_AFTER;
        }
        if (outcomeType) {
          this.outcomeTracker.recordOutcome({
            sessionId: this._sessionId,
            outcomeType,
            nowMs: now,
          });
        }
      }
      if (payload.productId) {
        this.stateStore.addViewedProduct(payload.productId, now);
      }
    }

    // ── User memory recording ────────────────────────────────────────────────
    if (this.userMemoryEngine && this._sessionId) {
      try {
        const category = payload.category || null;
        const productId = payload.productId || null;
        const context   = this.stateStore.getState().currentContext;

        // Record all interactions as behavior
        this.userMemoryEngine.recordBehavior({
          sessionId: this._sessionId,
          productId,
          context,
          category,
          eventType: type,
          nowMs: now,
        });

        // Record explicit rejections / dismissals
        if (type === 'dismiss_message' || type === 'message_dismiss') {
          const entityId = payload.messageFamily || payload.messageId || productId || 'unknown';
          this.userMemoryEngine.recordIgnoredSuggestion({
            sessionId: this._sessionId,
            productId:  productId || entityId,
            reason:     'user_dismissed',
            nowMs:      now,
          });
          this.userMemoryEngine.recordRejection({
            sessionId:  this._sessionId,
            userId:     this._userId || null,
            entityId,
            entityType: payload.messageFamily ? 'family' : 'product',
            nowMs:      now,
          });
        }

        // Record purchases
        if (type === 'checkout' || type === 'purchase') {
          const userId = this._userId || null;
          if (userId) {
            this.userMemoryEngine.recordPurchase({
              sessionId: this._sessionId,
              userId,
              products:  Array.isArray(payload.products) ? payload.products : [],
              revenue:   typeof payload.revenue === 'number' ? payload.revenue : 0,
              nowMs:     now,
            });
          }
        }
      } catch (_) {}
    }

    if (typeof this.intentEngine.recordSignal === 'function') {
      this.intentEngine.recordSignal(type, payload.weight || 0.2, now);
    }

    // Forward cart events to funnel engine
    if (this.funnelEngine && typeof this.funnelEngine.processEvent === 'function') {
      try {
        this.funnelEngine.processEvent(this._sessionId, {
          type: type === 'add_to_cart' ? 'cart_add' : type === 'remove_from_cart' ? 'cart_remove' : type,
          productId: payload.productId,
          context: this.stateStore.getState().currentContext,
          metadata: payload,
        }, now);
      } catch (err) {
        this._reportError(err, 'funnel_event', now);
      }
    }

    this._safeEmit('USER_ACTION', payload, now, 'NORMAL');
  }

  // ====================================================================
  // Scheduling (sin Date.now, sin timers globales)
  // ====================================================================

  /**
   * Programa una evaluacion. Si `immediate=true`, se ejecuta sincronicamente
   * respetando el lock (si esta tomado, se marca pendiente para que el finally
   * del lock la dispare). Si `immediate=false`, se delega al scheduler
   * inyectado; si no hay scheduler, se marca pendiente y se ejecutara
   * cooperativamente en el proximo punto de entrada (processEvent / evaluate).
   */
  _scheduleEvaluation(now, immediate) {
    if (this._disposed) return;

    if (immediate) {
      if (!this._evaluationLock) {
        this.evaluate(now);
      } else {
        this._pendingEvaluation = true;
        this._pendingEvaluationNow = Math.max(this._pendingEvaluationNow, now);
      }
      return;
    }

    if (this._evaluationLock) {
      this._pendingEvaluation = true;
      this._pendingEvaluationNow = Math.max(this._pendingEvaluationNow, now);
      return;
    }

    if (this.scheduler && typeof this.scheduler.schedule === 'function') {
      // El scheduler es responsable de pasar `now` deterministico cuando
      // ejecute el callback. Esto preserva replay-safety.
      this._cancelDeferred();
      this._deferredHandle = this.scheduler.schedule((scheduledNow) => {
        this._deferredHandle = null;
        if (this._disposed || !this._initialized) return;
        this.evaluate(typeof scheduledNow === 'number' ? scheduledNow : now);
      }, now);
      return;
    }

    // Sin scheduler: se ejecuta sincronicamente. Throttle/cooldown gates
    // dentro de evaluate filtran las llamadas redundantes.
    this.evaluate(now);
  }

  _cancelDeferred() {
    if (this._deferredHandle && this.scheduler && typeof this.scheduler.cancel === 'function') {
      try { this.scheduler.cancel(this._deferredHandle); }
      catch (_) { /* swallow */ }
    }
    this._deferredHandle = null;
  }

  // ====================================================================
  // Helpers
  // ====================================================================

  /**
   * Provider de candidatos. Si requireCandidateProvider=true y no se inyecto
   * candidateProvider, retornamos null (impide intervenir con datos ficticios).
   */
  _getMessageCandidates(context, productId, state, now) {
    if (this.candidateProvider && typeof this.candidateProvider.getCandidates === 'function') {
      try {
        const out = this.candidateProvider.getCandidates({ context, productId, state, now });
        return Array.isArray(out) ? out : [];
      } catch (err) {
        this._reportError(err, 'candidate_provider', now);
        return [];
      }
    }
    if (this.config.requireCandidateProvider) {
      // No fallback ficticio: si no hay provider, no hay candidatos.
      return null;
    }
    return [];
  }

  _getExposureHistory(now) {
    if (this.exposureHistoryProvider && typeof this.exposureHistoryProvider.getHistory === 'function') {
      try {
        const out = this.exposureHistoryProvider.getHistory(now);
        return Array.isArray(out) ? out : [];
      } catch (err) {
        this._reportError(err, 'exposure_history_provider', now);
        return [];
      }
    }
    if (this.config.requireExposureProvider) {
      return null;
    }
    return [];
  }

  /**
   * Registro de listeners externos del bus. Cualquier listener que el
   * orchestrator quiera adjuntar al bus DEBE pasar por aca para que terminate
   * y dispose los limpien.
   *
   * IMPORTANTE: el orchestrator NO se suscribe a sus propias emisiones (ej.
   * CONTEXT_CHANGED) para evitar loops indirectos.
   */
  _registerBusListener(eventName, handler, options) {
    if (this._disposed) return;
    this.eventBus.on(eventName, handler, options);
    this._busListeners.push({ eventName, handler });
  }

  _cleanupEventListeners() {
    for (const { eventName, handler } of this._busListeners) {
      try { this.eventBus.off(eventName, handler); }
      catch (_) { /* swallow: bus puede estar disposed */ }
    }
    this._busListeners.length = 0;
  }

  _safeEmit(eventName, payload, now, priority, source) {
    try {
      this.eventBus.emit(eventName, payload, now, priority || 'NORMAL', source || 'orchestrator');
    } catch (err) {
      this._stats.handlerErrors++;
      // No re-emit: evitar loops si el bus esta caido
      if (this.logger && typeof this.logger.error === 'function') {
        this.logger.error('orchestrator.emit_failed', {
          sessionId: this._sessionId,
          eventName,
          error: err && err.message,
        });
      }
    }
  }

  _sampledEmit(eventName, payload, now, priority, counterField) {
    const rate = this.config.blockedDeniedSamplingRate || 1;
    this[counterField] = (this[counterField] || 0) + 1;
    if (this[counterField] % rate !== 0) return;
    this._safeEmit(eventName, payload, now, priority);
  }

  _reportError(err, where, now) {
    this._stats.handlerErrors++;
    if (this.logger && typeof this.logger.error === 'function') {
      this.logger.error('orchestrator.handler_error', {
        sessionId: this._sessionId,
        where,
        message: err && err.message,
        stack: err && err.stack,
      });
    }
    this._safeEmit('__orchestrator:handler_error', {
      where,
      message: err && err.message,
    }, now, 'HIGH');
  }

  _log(level, message) {
    // Si hay logger inyectado, lo usamos exclusivamente.
    if (this.logger && typeof this.logger[level] === 'function') {
      this.logger[level]('orchestrator', {
        sessionId: this._sessionId,
        storeId: this._storeId,
        message,
      });
      return;
    }
    // Sin logger, solo emitimos eventos de tipo `debug` cuando esta habilitado.
    if (level === 'debug' && !this.config.enableDiagnosticLogs) return;
    // Sin logger inyectado y log no-debug: silencioso por defecto para no
    // ensuciar stdout de simuladores masivos. Tracing severo va por el bus.
    if (level === 'error' || level === 'warn') {
      this._safeEmit('__orchestrator:log', {
        level,
        message,
        sessionId: this._sessionId,
      }, this._lastEvaluationTime, 'LOW');
    }
  }

  _assertAlive() {
    if (this._disposed) {
      throw new Error('SessionOrchestrator: instance has been disposed');
    }
  }

  _validateNow(now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new TypeError('SessionOrchestrator: `now` must be a finite number');
    }
  }

  // ====================================================================
  // P2-HARDEN: Trace Log (circular buffer for orchestration debugging)
  // ====================================================================

  /**
   * Appends an entry to the circular trace log.
   * @param {string} type  Trace event type (e.g. 'evaluate', 'event', 'decision')
   * @param {object} payload  Minimal trace data (must be serializable)
   * @param {number} now
   */
  _trace(type, payload, now) {
    this._traceSeq++;
    const entry = { seq: this._traceSeq, type, payload, now };
    this._traceLog.push(entry);
    if (this._traceLog.length > this.config.traceLogCapacity) {
      this._traceLog.shift();
    }
  }

  /**
   * Returns the trace log contents (copy).
   */
  getTraceLog() {
    this._assertAlive();
    return this._traceLog.slice();
  }

  // ====================================================================
  // P2-HARDEN: Deterministic Replay Validation
  // ====================================================================

  /**
   * Records a decision outcome for later replay comparison.
   * Called internally after each successful evaluation.
   */
  _recordDecisionForReplay(eventSeq, decision, now) {
    const record = {
      eventSeq,
      now,
      decisionHash: this._hashDecision(decision),
      decision: decision ? {
        family: decision.selectedIntervention ? decision.selectedIntervention.family : null,
        subtype: decision.selectedIntervention ? decision.selectedIntervention.subtype : null,
        shouldIntervene: !!(decision.policyResult && decision.policyResult.shouldIntervene),
        fatigueScore: decision.fatigueScore,
      } : null,
    };
    this._decisionHistory.push(record);
    // Cap decision history at 2x trace log capacity
    if (this._decisionHistory.length > this.config.traceLogCapacity * 2) {
      this._decisionHistory.shift();
    }
  }

  /**
   * Simple deterministic hash of a decision for replay comparison.
   * Uses JSON serialization of the key decision fields to produce a
   * stable string fingerprint.
   */
  _hashDecision(decision) {
    if (!decision) return 'null';
    const key = {
      f: decision.selectedIntervention ? decision.selectedIntervention.family : null,
      s: decision.selectedIntervention ? decision.selectedIntervention.subtype : null,
      i: decision.selectedIntervention ? decision.selectedIntervention.id : null,
      p: decision.policyResult ? decision.policyResult.shouldIntervene : null,
      fs: typeof decision.fatigueScore === 'number' ? Math.round(decision.fatigueScore * 1000) : null,
    };
    return JSON.stringify(key);
  }

  /**
   * Validates that a replayed session produces identical decisions.
   * @param {Array} replayDecisionHistory  Decision history from a replayed session
   * @returns {{ valid: boolean, mismatches: Array, totalCompared: number }}
   */
  validateReplay(replayDecisionHistory) {
    this._assertAlive();
    if (!Array.isArray(replayDecisionHistory)) {
      return { valid: false, mismatches: [{ error: 'invalid_input' }], totalCompared: 0 };
    }
    const minLen = Math.min(this._decisionHistory.length, replayDecisionHistory.length);
    const mismatches = [];
    for (let i = 0; i < minLen; i++) {
      const original = this._decisionHistory[i];
      const replayed = replayDecisionHistory[i];
      if (original.decisionHash !== replayed.decisionHash) {
        mismatches.push({
          index: i,
          eventSeq: original.eventSeq,
          original: original.decision,
          replayed: replayed.decision,
          originalHash: original.decisionHash,
          replayedHash: replayed.decisionHash,
        });
      }
    }
    if (this._decisionHistory.length !== replayDecisionHistory.length) {
      mismatches.push({
        error: 'length_mismatch',
        originalLength: this._decisionHistory.length,
        replayedLength: replayDecisionHistory.length,
      });
    }
    return {
      valid: mismatches.length === 0,
      mismatches,
      totalCompared: minLen,
    };
  }

  /**
   * Returns the decision history for replay comparison.
   */
  getDecisionHistory() {
    this._assertAlive();
    return this._decisionHistory.slice();
  }

  // ====================================================================
  // Snapshot / Restore
  // ====================================================================

  snapshot() {
    this._assertAlive();
    return {
      __schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: this._sessionId,
      storeId: this._storeId,
      initialized: this._initialized,
      // No serializamos config (es frozen y debe venir del constructor)

      // --- Core engines (always present) ---
      stateStore: this.stateStore.snapshot(),
      intentEngine: this.intentEngine.snapshot(),
      fatigueEngine: this.fatigueEngine.snapshot(),
      explainabilityEngine: this.explainabilityEngine ? this.explainabilityEngine.snapshot() : null,
      outcomeTracker:       this.outcomeTracker ? this.outcomeTracker.snapshot() : null,
      learningStore:        this.learningStore ? this.learningStore.snapshot() : null,

      // --- P3-SNAP: Full state serialization ---
      // Funnel stage (authoritative: funnel-stage-engine)
      funnelEngine: this.funnelEngine && typeof this.funnelEngine.snapshot === 'function'
        ? this.funnelEngine.snapshot()
        : null,

      // Visibility state (authoritative: message-visibility-controller)
      visibilityController: this.visibilityController && typeof this.visibilityController.snapshot === 'function'
        ? this.visibilityController.snapshot()
        : null,

      // Signal derivation engine (computed signals)
      signalDerivationEngine: this.signalDerivationEngine && typeof this.signalDerivationEngine.snapshot === 'function'
        ? this.signalDerivationEngine.snapshot()
        : null,

      // Event bus state (replay-relevant subscriptions + history)
      eventBus: this.eventBus && typeof this.eventBus.snapshot === 'function'
        ? this.eventBus.snapshot()
        : null,

      // Presence engine (user presence tracking)
      presenceEngine: this.presenceEngine && typeof this.presenceEngine.snapshot === 'function'
        ? this.presenceEngine.snapshot()
        : null,

      // --- Orchestrator internal state ---
      lastEvaluationTime: this._lastEvaluationTime,
      lastContextEvaluation: Array.from(this._lastContextEvaluation.entries()),
      evaluationLock: this._evaluationLock,
      lockAcquiredAt: this._lockAcquiredAt,
      pendingEvaluation: this._pendingEvaluation,
      pendingEvaluationNow: this._pendingEvaluationNow,
      recentEventIds: Array.from(this._recentEventIds.entries()),
      version: this._version,
      stats: { ...this._stats },

      // ── Hardening engines snapshot (optional; null-safe) ────────────────────
      userMemoryEngine:     this.userMemoryEngine     ? this.userMemoryEngine.snapshot()     : null,
      mobileBehaviorEngine: this.mobileBehaviorEngine ? this.mobileBehaviorEngine.snapshot() : null,
      observabilityEngine:  this.observabilityEngine  ? this.observabilityEngine.snapshot()  : null,

      // P2-HARDEN: Trace log and decision history for replay validation
      traceLog: this._traceLog.slice(),
      traceSeq: this._traceSeq,
      decisionHistory: this._decisionHistory.slice(),
    };
  }

  restore(snapshot, now) {
    this._assertAlive();
    this._validateNow(now);
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.__schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      this._log('warn', `Snapshot schema mismatch: got ${snapshot.__schemaVersion}, expected ${SNAPSHOT_SCHEMA_VERSION}`);
      return;
    }

    this._sessionId = snapshot.sessionId || this._sessionId;
    this._storeId = snapshot.storeId || this._storeId;
    this._initialized = !!snapshot.initialized;

    // --- Core engines (always present) ---
    this.stateStore.restore(snapshot.stateStore, now);
    this.intentEngine.restore(snapshot.intentEngine || snapshot.transitionLayer, now);
    this.fatigueEngine.restore(snapshot.fatigueEngine, now);
    if (snapshot.explainabilityEngine && this.explainabilityEngine) {
      this.explainabilityEngine.restore(snapshot.explainabilityEngine);
    }
    if (snapshot.outcomeTracker && this.outcomeTracker) {
      this.outcomeTracker.restore(snapshot.outcomeTracker);
    }
    if (snapshot.learningStore && this.learningStore) {
      this.learningStore.restore(snapshot.learningStore);
    }

    // --- P3-SNAP: Restore optional engines ---
    // Funnel stage
    if (snapshot.funnelEngine && this.funnelEngine && typeof this.funnelEngine.restore === 'function') {
      this.funnelEngine.restore(snapshot.funnelEngine);
    }

    // Visibility controller
    if (snapshot.visibilityController && this.visibilityController && typeof this.visibilityController.restore === 'function') {
      this.visibilityController.restore(snapshot.visibilityController, now);
    }

    // Signal derivation engine
    if (snapshot.signalDerivationEngine && this.signalDerivationEngine && typeof this.signalDerivationEngine.restore === 'function') {
      this.signalDerivationEngine.restore(snapshot.signalDerivationEngine);
    }

    // Event bus
    if (snapshot.eventBus && this.eventBus && typeof this.eventBus.restore === 'function') {
      this.eventBus.restore(snapshot.eventBus);
    }

    // Presence engine
    if (snapshot.presenceEngine && this.presenceEngine && typeof this.presenceEngine.restore === 'function') {
      this.presenceEngine.restore(snapshot.presenceEngine, now);
    }

    // --- Orchestrator internal state ---
    this._lastEvaluationTime = snapshot.lastEvaluationTime || now;

    this._lastContextEvaluation = new LRUMap(this.config.maxContextEvaluationEntries);
    if (Array.isArray(snapshot.lastContextEvaluation)) {
      for (const [k, v] of snapshot.lastContextEvaluation) {
        this._lastContextEvaluation.set(k, v);
      }
    }

    this._recentEventIds = new LRUMap(this.config.maxRecentEventIds);
    if (Array.isArray(snapshot.recentEventIds)) {
      for (const [k, v] of snapshot.recentEventIds) {
        this._recentEventIds.set(k, v);
      }
    }

    // Locks NO se restauran activos: si el snapshot fue tomado mid-eval, lo
    // tratamos como evaluacion abortada y dejamos el lock libre. Esto evita
    // deadlocks post-restore.
    this._evaluationLock = false;
    this._lockAcquiredAt = 0;
    this._pendingEvaluation = !!snapshot.pendingEvaluation;
    this._pendingEvaluationNow = snapshot.pendingEvaluationNow || 0;

    this._version = snapshot.version || 1;
    if (snapshot.stats && typeof snapshot.stats === 'object') {
      this._stats = { ...this._stats, ...snapshot.stats };
    }

    // ── Hardening engines restore ─────────────────────────────────────────────
    if (snapshot.userMemoryEngine && this.userMemoryEngine) {
      try { this.userMemoryEngine.restore(snapshot.userMemoryEngine); } catch (_) {}
    }
    if (snapshot.mobileBehaviorEngine && this.mobileBehaviorEngine) {
      try { this.mobileBehaviorEngine.restore(snapshot.mobileBehaviorEngine); } catch (_) {}
    }
    if (snapshot.observabilityEngine && this.observabilityEngine) {
      try { this.observabilityEngine.restore(snapshot.observabilityEngine); } catch (_) {}
    }

    // P2-HARDEN: Restore trace log and decision history
    if (Array.isArray(snapshot.traceLog)) {
      this._traceLog = snapshot.traceLog.slice();
    }
    if (typeof snapshot.traceSeq === 'number') {
      this._traceSeq = snapshot.traceSeq;
    }
    if (Array.isArray(snapshot.decisionHistory)) {
      this._decisionHistory = snapshot.decisionHistory.slice();
    }

    this._log('info', 'Session restored from snapshot (full state serialization)');
  }

  // ====================================================================
  // Diagnostico
  // ====================================================================

  getDiagnostics(now) {
    this._assertAlive();
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: this._sessionId,
      storeId: this._storeId,
      initialized: this._initialized,
      disposed: this._disposed,
      lastEvaluationTime: this._lastEvaluationTime,
      evaluationLock: this._evaluationLock,
      lockAgeMs: this._evaluationLock ? (now - this._lockAcquiredAt) : 0,
      pendingEvaluation: this._pendingEvaluation,
      eventQueueSize: this._eventQueue.length,
      contextEvaluationEntries: this._lastContextEvaluation.size,
      recentEventIdsSize: this._recentEventIds.size,
      stats: { ...this._stats },
      stateStore: this.stateStore.getDiagnostics ? this.stateStore.getDiagnostics(now) : null,
      intentEngine: this.intentEngine.getDiagnostics ? this.intentEngine.getDiagnostics() : null,
      fatigueEngine: this.fatigueEngine.getDiagnostics ? this.fatigueEngine.getDiagnostics(now) : null,
      explainabilityEngine: this.explainabilityEngine ? this.explainabilityEngine.getDiagnostics() : null,
      outcomeTracker:       this.outcomeTracker ? this.outcomeTracker.getDiagnostics() : null,
      learningStore:        this.learningStore ? this.learningStore.getDiagnostics() : null,
      eventBus: this.eventBus.getDiagnostics ? this.eventBus.getDiagnostics(now) : null,
      userMemoryEngine:     this.userMemoryEngine     ? this.userMemoryEngine.getDiagnostics()     : null,
      mobileBehaviorEngine: this.mobileBehaviorEngine ? this.mobileBehaviorEngine.getDiagnostics() : null,
      observabilityEngine:  this.observabilityEngine  ? this.observabilityEngine.getDiagnostics()  : null,
      version: this._version,
    };
  }
}

module.exports = {
  SessionOrchestrator,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
  VALID_CONTEXTS,
  VALID_EVENT_TYPES,
};
