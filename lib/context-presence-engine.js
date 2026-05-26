/**
 * context-presence-engine.js
 *
 * Modela la presencia contextual real de la atención del usuario.
 * Diferencia entre visibilidad técnica y atención humana.
 *
 * Determina:
 *  - qué entidad contextual está realmente presente (producto, modal, lista, etc.)
 *  - nivel de confianza en la presencia (basado en evidencia temporal e interacción)
 *  - persistencia contextual después de pérdida breve de visibilidad
 *  - dominancia entre contextos concurrentes
 *  - promoción de contextos candidatos a activo con hysteresis real
 *
 * Garantías:
 *  - Determinista: `now` siempre se pasa como parámetro.
 *  - Replay-safe: input idempotente vía `consumed` flags sobre interacciones.
 *  - Sin acumuladores ocultos: `visibleDuration` se recomputa por transición.
 *  - Sin contextos zombi: contextos fuera de `candidateContexts` se marcan
 *    automáticamente como `visible=false, hover=false, modal=false`.
 *  - Sin flicker: refractory period real tras cada switch.
 *  - Hysteresis dual: `promotionThreshold` + `demotionThreshold` aplicados.
 *  - Cleanup correcto: invalidation se decide tras recomputar scores.
 *  - API pública alineada con el orchestrator: `isPresent`, `getPresenceLevel`,
 *    `getActiveContextKey`.
 *  - Integración con bus, logger, visibility-controller, fatigue (inyectables).
 *  - Snapshot con `__schemaVersion`.
 */

'use strict';

// ----------------------------------------------------------------------
// Schema version
// ----------------------------------------------------------------------
const SNAPSHOT_SCHEMA_VERSION = 1;

// ----------------------------------------------------------------------
// Configuración por defecto (frozen)
// ----------------------------------------------------------------------
const DEFAULT_CONFIG = Object.freeze({
  // ---- Ventanas de tiempo (ms) ----
  minPresenceTimeMs: 500,
  visibilityConfidenceWindowMs: 3000,
  interactionConfidenceWindowMs: 10000,

  // ---- Decaimiento exponencial (half-life en ms) ----
  presenceDecayHalfLifeMs: 8000,
  interactionDecayHalfLifeMs: 15000,

  // ---- Pesos para score combinado ----
  weightVisibility: 0.4,
  weightInteraction: 0.4,
  weightPersistence: 0.2,

  // ---- Umbrales de promoción/democión ----
  // Mínimo dominance que un candidato debe tener para poder convertirse en activo.
  promotionThreshold: 0.5,
  // Si el active baja por debajo de esto, queda elegible para ser desplazado.
  demotionThreshold: 0.3,
  // Diferencia mínima de dominance entre challenger y activo (anti-flicker).
  hysteresisMargin: 0.1,

  // ---- Refractory period real tras switch ----
  switchRefractoryMs: 1500,
  // Penalización de gap si llega un challenger dentro del refractory.
  rapidContextSwitchPenalty: 0.2,

  // ---- Boosts por tipo de contexto ----
  modalDominanceBoost: 0.25,
  hoverBoost: 0.15,
  listingStabilityBoost: 0.05,

  // ---- Dwell mínimo para validar interacciones ----
  hoverMinDwellMs: 300,        // hover menor a esto no aplica boost
  modalMinDwellMs: 200,        // modal menor a esto se descarta (mistap)
  transitionMinDwellMs: 250,   // transición debe sobrevivir esto para registrarse

  // ---- Persistencia ----
  persistenceFloorAgeMs: 60000, // tiempo que satura persistencia base
  persistenceMaxBase: 0.7,
  visibilityResumeGapMs: 5000,  // gap máximo para sumar visibleDuration on resume

  // ---- Cleanup ----
  maxContextMemory: 20,
  invalidationIdleMs: 30000,
  invalidationPresenceFloor: 0.1,

  // ---- Bidireccionalidad con fatigue ----
  // Penalty aplicado al dominance de un contexto saturado.
  saturatedContextPenalty: 0.3,

  // ---- Bidireccionalidad con visibility-controller ----
  // Si viewportCoverage está disponible, escalar visibilityConfidence por él.
  viewportCoverageWeight: 0.7, // 0=ignorado, 1=lineal

  // ---- Ring buffer de transiciones ----
  transitionHistorySize: 32,

  // ---- Idempotencia ----
  // Si el caller pasa `evaluationId`, se cachea el resultado para dedup.
  evaluationDedupSize: 16,

  // ---- Watchdog ----
  // Si el active no cambia y su score está bajo durante este tiempo, log warning.
  staleActiveWarnMs: 60000,
});

// ----------------------------------------------------------------------
// Presence levels (enum-like)
// ----------------------------------------------------------------------
const PRESENCE_LEVELS = Object.freeze({
  ABSENT: 'absent',
  PERIPHERAL: 'peripheral',
  ENGAGED: 'engaged',
  FOCUSED: 'focused',
});

// ----------------------------------------------------------------------
// Utilidades puras
// ----------------------------------------------------------------------
function exponentialDecay(value, elapsedMs, halfLifeMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return value;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  return value * Math.pow(0.5, elapsedMs / halfLifeMs);
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function safeNumber(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}

// ----------------------------------------------------------------------
// LRU Map (re-insertion on access)
// ----------------------------------------------------------------------
class LRUMap {
  constructor(capacity) {
    this._capacity = capacity;
    this._map = new Map();
  }
  get size() { return this._map.size; }
  has(key) { return this._map.has(key); }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }
  peek(key) { return this._map.get(key); }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this._capacity) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  entries() { return this._map.entries(); }
  [Symbol.iterator]() { return this._map.entries(); }
}

// ----------------------------------------------------------------------
// Ring buffer para historial de transiciones
// ----------------------------------------------------------------------
class TransitionRingBuffer {
  constructor(capacity) {
    this._capacity = Math.max(1, capacity | 0);
    this._buf = new Array(this._capacity);
    this._writeIndex = 0;
    this._count = 0;
  }
  push(item) {
    this._buf[this._writeIndex] = item;
    this._writeIndex = (this._writeIndex + 1) % this._capacity;
    if (this._count < this._capacity) this._count++;
  }
  toArrayNewestFirst() {
    const result = [];
    for (let i = 0; i < this._count; i++) {
      const idx = (this._writeIndex - 1 - i + this._capacity) % this._capacity;
      result.push(this._buf[idx]);
    }
    return result;
  }
  clear() {
    this._buf = new Array(this._capacity);
    this._writeIndex = 0;
    this._count = 0;
  }
  get length() { return this._count; }
  snapshot() {
    // Returns chronological order (oldest first) for snapshot
    const arr = this.toArrayNewestFirst();
    return arr.reverse();
  }
  restore(items) {
    this.clear();
    if (!Array.isArray(items)) return;
    for (const it of items) this.push(it);
  }
}

// ----------------------------------------------------------------------
// Estado de un contexto
// ----------------------------------------------------------------------
class ContextPresence {
  constructor(contextType, productId = null, enteredAt = 0) {
    this.contextType = contextType;
    this.productId = productId;
    this.key = productId ? `${contextType}:${productId}` : contextType;

    // ---- Estado bruto (de UI) ----
    this.visible = false;
    this.wasVisibleLastTick = false;
    this.hoverState = false;
    this.hoverStartedAt = 0;
    this.modalState = false;
    this.modalStartedAt = 0;
    this.viewportCoverage = 0;

    // ---- Acumuladores temporales (idempotentes por tick) ----
    this.visibleDuration = 0;            // ms acumulados en la sesión actual de visibilidad
    this.visibleSegmentStartedAt = 0;    // inicio del segmento de visibilidad actual
    this.interactionCount = 0;           // contador acumulado (con cap)
    this.lastInteractionAt = 0;

    // ---- Timestamps de ciclo de vida ----
    this.lastVisibleAt = 0;
    this.enteredAt = enteredAt;
    this.exitedAt = 0;

    // ---- Scores derivados ----
    this.presenceScore = 0;
    this.visibilityConfidence = 0;
    this.interactionConfidence = 0;
    this.persistenceScore = 0;
    this.dominanceScore = 0;
    this.stabilityScore = 0;

    // ---- Anti-fatigue feedback ----
    this.saturationFlag = false; // settable by orchestrator via setContextSaturation
  }

  serialize() {
    return {
      contextType: this.contextType,
      productId: this.productId,
      key: this.key,
      visible: this.visible,
      wasVisibleLastTick: this.wasVisibleLastTick,
      hoverState: this.hoverState,
      hoverStartedAt: this.hoverStartedAt,
      modalState: this.modalState,
      modalStartedAt: this.modalStartedAt,
      viewportCoverage: this.viewportCoverage,
      visibleDuration: this.visibleDuration,
      visibleSegmentStartedAt: this.visibleSegmentStartedAt,
      interactionCount: this.interactionCount,
      lastInteractionAt: this.lastInteractionAt,
      lastVisibleAt: this.lastVisibleAt,
      enteredAt: this.enteredAt,
      exitedAt: this.exitedAt,
      saturationFlag: this.saturationFlag,
      // scores se omiten: se recomputan post-restore
    };
  }

  static fromSnapshot(data) {
    const ctx = new ContextPresence(data.contextType, data.productId, data.enteredAt || 0);
    // Solo state base; scores se recomputan
    ctx.visible = !!data.visible;
    ctx.wasVisibleLastTick = !!data.wasVisibleLastTick;
    ctx.hoverState = !!data.hoverState;
    ctx.hoverStartedAt = safeNumber(data.hoverStartedAt);
    ctx.modalState = !!data.modalState;
    ctx.modalStartedAt = safeNumber(data.modalStartedAt);
    ctx.viewportCoverage = clamp(safeNumber(data.viewportCoverage), 0, 1);
    ctx.visibleDuration = Math.max(0, safeNumber(data.visibleDuration));
    ctx.visibleSegmentStartedAt = safeNumber(data.visibleSegmentStartedAt);
    ctx.interactionCount = Math.max(0, safeNumber(data.interactionCount));
    ctx.lastInteractionAt = safeNumber(data.lastInteractionAt);
    ctx.lastVisibleAt = safeNumber(data.lastVisibleAt);
    ctx.exitedAt = safeNumber(data.exitedAt);
    ctx.saturationFlag = !!data.saturationFlag;
    return ctx;
  }
}

// ----------------------------------------------------------------------
// Engine principal
// ----------------------------------------------------------------------
class ContextPresenceEngine {
  constructor(options = {}) {
    const {
      config = {},
      eventBus = null,
      logger = null,
      sessionId = null,
    } = options;

    // Config inmutable post-construcción
    const merged = Object.assign({}, DEFAULT_CONFIG, config);
    this.config = deepFreeze(merged);

    // Dependencias inyectables
    this._eventBus = eventBus;
    this._logger = logger;
    this._sessionId = sessionId;

    // Estado
    this._contexts = new Map();
    this._activeContextKey = null;
    this._lastContextSwitchTime = 0;
    this._transitionHistory = new TransitionRingBuffer(this.config.transitionHistorySize);
    this._version = 1;

    // Idempotencia
    this._lastEvaluationId = null;
    this._lastEvaluationResult = null;
    this._evaluationDedup = new LRUMap(this.config.evaluationDedupSize);

    // Watchdog / monotonicidad
    this._lastNow = 0;
    this._lastActiveScoreCheckAt = 0;

    // Dispose
    this._disposed = false;
  }

  // ------------------------------------------------------------------
  // Guards
  // ------------------------------------------------------------------
  _assertAlive() {
    if (this._disposed) {
      throw new Error('[ContextPresenceEngine] instance has been disposed');
    }
  }

  _validateNow(now) {
    if (!Number.isFinite(now)) {
      throw new Error('[ContextPresenceEngine] `now` must be a finite number');
    }
    if (now < this._lastNow) {
      // Out-of-order tick: lo descartamos vía caller, pero no rompemos.
      this._log('warn', 'non_monotonic_now', { now, lastNow: this._lastNow });
      return false;
    }
    this._lastNow = now;
    return true;
  }

  // ------------------------------------------------------------------
  // Log + Emit helpers
  // ------------------------------------------------------------------
  _log(level, code, data = {}) {
    if (!this._logger) return;
    try {
      const payload = Object.assign({ engine: 'context-presence', sessionId: this._sessionId, code }, data);
      if (typeof this._logger.log === 'function') {
        this._logger.log({ level, ...payload });
      } else if (typeof this._logger[level] === 'function') {
        this._logger[level](payload);
      }
    } catch (_) { /* logger broken: silently ignore */ }
  }

  _emit(eventName, payload, now) {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    try {
      this._eventBus.emit(eventName, payload, now, 'NORMAL', 'context-presence');
    } catch (err) {
      this._log('error', 'emit_failed', { eventName, message: err && err.message });
    }
  }

  // ------------------------------------------------------------------
  // API pública: evaluación principal
  // ------------------------------------------------------------------

  /**
   * Evalúa la presencia de todos los contextos conocidos y determina el activo.
   *
   * Contrato del input:
   *   {
   *     now: number,                                  // requerido
   *     evaluationId?: string,                        // opcional, habilita dedup
   *     candidateContexts: Array<{
   *       contextType: string,
   *       productId?: string|number|null,
   *       visible?: boolean,
   *       viewportCoverage?: number,
   *       hoverState?: boolean,
   *       modalState?: boolean,
   *     }>,
   *     interactionsDelta?: Array<{                   // explícitamente delta
   *       contextType: string,
   *       productId?: string|number|null,
   *       count: number,                              // delta desde la última eval
   *     }>,
   *     behavioralState?: {                           // influye en dominance penalty
   *       fatigueScore?: number,
   *       saturatedContexts?: string[],               // claves saturadas
   *     },
   *     viewportState?: object,
   *     sessionState?: object,
   *   }
   *
   * @returns {object}
   */
  evaluateContextPresence(input) {
    this._assertAlive();

    const now = input && input.now;
    if (!this._validateNow(now)) {
      // Tick fuera de orden: devolvemos snapshot actual sin mutar
      return this._buildResult(now || this._lastNow, /* ranked */ null, /* deduped */ false);
    }

    // ---- Idempotencia por evaluationId ----
    const evaluationId = input && input.evaluationId;
    if (evaluationId && this._evaluationDedup.has(evaluationId)) {
      const cached = this._evaluationDedup.get(evaluationId);
      return cached;
    }

    let result;
    try {
      const {
        candidateContexts = [],
        interactionsDelta = [],
        behavioralState = {},
        // viewportState/sessionState/currentContext son aceptados pero no usados
        // directamente: la información debe venir embebida en candidateContexts
        // y en behavioralState para evitar duplicación silenciosa de fuentes.
      } = input || {};

      // 1) Actualizar state bruto a partir de candidates + interacciones
      this._syncCandidates(candidateContexts, now);
      this._applyInteractionDeltas(interactionsDelta, now);

      // 2) Aplicar saturatedContexts (bidireccionalidad con fatigue)
      this._applySaturatedContexts(behavioralState.saturatedContexts || []);

      // 3) Recomputar scores de todos los contextos
      for (const ctx of this._contexts.values()) {
        this._computeAllScores(ctx, behavioralState, now);
      }

      // 4) Cleanup/invalidación DESPUÉS de tener scores frescos
      this._cleanupInvalidContexts(now);

      // 5) Cap por maxContextMemory (también con scores frescos)
      this._enforceContextMemoryCap();

      // 6) Recomputar ranking final (set puede haber cambiado en 4-5)
      const ranked = this._computeDominanceRanking();

      // 7) Decidir promoción con hysteresis dual + refractory
      const decision = this._decideActiveContext(ranked, now);

      // 8) Registrar transición si hay cambio
      if (decision.newActiveKey !== this._activeContextKey) {
        const fromKey = this._activeContextKey;
        const toKey = decision.newActiveKey;
        // Validar minimum dwell de modal antes de aceptar transition
        if (!this._isTransitionValid(fromKey, toKey, now, decision.reason)) {
          // Transición descartada por dwell insuficiente
          this._log('debug', 'transition_rejected_low_dwell', { from: fromKey, to: toKey });
        } else {
          this._registerTransition(fromKey, toKey, decision.reason, now);
          this._activeContextKey = toKey;
          this._lastContextSwitchTime = now;
          this._emit('__presence:context_changed', {
            from: fromKey,
            to: toKey,
            reason: decision.reason,
            sessionId: this._sessionId,
          }, now);
        }
      }

      // 9) Watchdog: active stale
      this._runStaleActiveWatchdog(now);

      result = this._buildResult(now, ranked, /* deduped */ false);
    } catch (err) {
      this._log('error', 'evaluate_failed', { message: err && err.message, stack: err && err.stack });
      this._emit('__presence:eval_error', { message: err && err.message, sessionId: this._sessionId }, now);
      // Devolvemos un resultado degradado pero estable
      result = this._buildResult(now, null, false);
    }

    if (evaluationId) {
      this._evaluationDedup.set(evaluationId, result);
    }
    return result;
  }

  _buildResult(now, ranked, deduped) {
    const activeCtx = this._activeContextKey ? this._contexts.get(this._activeContextKey) : null;
    return {
      activeContextKey: this._activeContextKey,
      activeContext: activeCtx ? this._serializeContext(activeCtx) : null,
      ranked: (ranked || this._computeDominanceRanking()).map(r => ({
        key: r.key,
        contextType: r.ctx.contextType,
        productId: r.ctx.productId,
        dominance: r.ctx.dominanceScore,
        presence: r.ctx.presenceScore,
      })),
      version: this._version,
      deduped,
      now,
    };
  }

  // ------------------------------------------------------------------
  // API pública: consultas (las que el orchestrator espera)
  // ------------------------------------------------------------------

  /**
   * Retorna true si el contextKey está presente con confianza suficiente.
   * Equivale a `getPresenceLevel(contextKey, now) >= ENGAGED`.
   */
  isPresent(contextKey, now) {
    this._assertAlive();
    if (!contextKey) return false;
    const ctx = this._contexts.get(contextKey);
    if (!ctx) return false;
    if (Number.isFinite(now) && now > this._lastNow) {
      // Si el caller pasa un `now` posterior al último tick, ajustamos visibility decay
      // sin mutar state acumulador (read-only refresh).
      const visConf = this._computeVisibilityConfidence(ctx, now);
      const persist = this._computeContextPersistence(ctx, now);
      const refreshed = (visConf * this.config.weightVisibility)
        + (ctx.interactionConfidence * this.config.weightInteraction)
        + (persist * this.config.weightPersistence);
      return refreshed >= this.config.promotionThreshold;
    }
    return ctx.presenceScore >= this.config.promotionThreshold;
  }

  /**
   * Retorna el nivel de presencia para un contextKey dado.
   * Niveles: 'absent' | 'peripheral' | 'engaged' | 'focused'
   */
  getPresenceLevel(contextKey, now) {
    this._assertAlive();
    if (!contextKey) return PRESENCE_LEVELS.ABSENT;
    const ctx = this._contexts.get(contextKey);
    if (!ctx) return PRESENCE_LEVELS.ABSENT;
    const score = ctx.presenceScore;
    if (score < this.config.invalidationPresenceFloor) return PRESENCE_LEVELS.ABSENT;
    if (score < this.config.demotionThreshold) return PRESENCE_LEVELS.PERIPHERAL;
    if (score < this.config.promotionThreshold) return PRESENCE_LEVELS.ENGAGED;
    return PRESENCE_LEVELS.FOCUSED;
  }

  /**
   * Retorna la key del contexto activo o null.
   */
  getActiveContextKey() {
    this._assertAlive();
    return this._activeContextKey;
  }

  /**
   * Retorna el contexto activo serializado o null.
   */
  getActiveContext() {
    this._assertAlive();
    if (!this._activeContextKey) return null;
    const ctx = this._contexts.get(this._activeContextKey);
    return ctx ? this._serializeContext(ctx) : null;
  }

  /**
   * Marca un contexto como saturado (bidireccionalidad con fatigue engine).
   * Saturated contexts reciben penalty en dominance.
   */
  setContextSaturation(contextKey, saturated) {
    this._assertAlive();
    const ctx = this._contexts.get(contextKey);
    if (!ctx) return false;
    ctx.saturationFlag = !!saturated;
    return true;
  }

  // ------------------------------------------------------------------
  // Fórmulas (puras: no mutan state interno)
  // ------------------------------------------------------------------

  /**
   * Confianza de visibilidad.
   * - Si visible: crece con visibleDuration acumulado en el segmento actual,
   *   y se escala por viewportCoverage (si está disponible).
   * - Si no visible: decay exponencial desde el último frame visible.
   */
  _computeVisibilityConfidence(ctx, now) {
    let conf;
    if (ctx.visible) {
      const duration = clamp(ctx.visibleDuration, 0, Infinity);
      const window = this.config.visibilityConfidenceWindowMs;
      conf = clamp(duration / window, 0, 0.95);
    } else {
      if (ctx.lastVisibleAt === 0) return 0;
      const elapsed = now - ctx.lastVisibleAt;
      if (elapsed < 0) return 0;
      conf = exponentialDecay(0.8, elapsed, this.config.presenceDecayHalfLifeMs);
    }
    // Ponderar por viewportCoverage
    const w = this.config.viewportCoverageWeight;
    if (w > 0 && ctx.viewportCoverage > 0 && ctx.viewportCoverage < 1) {
      conf = conf * ((1 - w) + w * ctx.viewportCoverage);
    }
    return clamp(conf, 0, 0.95);
  }

  /**
   * Confianza de interacción: decae con elapsed desde la última interacción,
   * con bonus por count (capped).
   */
  _computeInteractionConfidence(ctx, now) {
    if (ctx.lastInteractionAt === 0) return 0;
    const elapsed = now - ctx.lastInteractionAt;
    if (elapsed < 0) return 0;
    if (elapsed > this.config.interactionConfidenceWindowMs) return 0;
    const base = exponentialDecay(1.0, elapsed, this.config.interactionDecayHalfLifeMs);
    const countBonus = clamp(ctx.interactionCount * 0.04, 0, 0.2);
    return clamp(base + countBonus, 0, 0.95);
  }

  /**
   * Persistencia: tiempo en el contexto, con decay desde el último exit real.
   */
  _computeContextPersistence(ctx, now) {
    if (ctx.enteredAt === 0) return 0;
    const age = Math.max(0, now - ctx.enteredAt);
    const base = clamp(age / this.config.persistenceFloorAgeMs, 0, 1) * this.config.persistenceMaxBase;
    if (!ctx.visible && ctx.exitedAt > 0) {
      const exitElapsed = Math.max(0, now - ctx.exitedAt);
      const decay = exponentialDecay(1.0, exitElapsed, this.config.presenceDecayHalfLifeMs);
      return base * decay;
    }
    return base;
  }

  /**
   * Score combinado de presencia (puro).
   */
  _computePresenceFromComponents(visConf, intConf, persist) {
    const score = visConf * this.config.weightVisibility
      + intConf * this.config.weightInteraction
      + persist * this.config.weightPersistence;
    return clamp(score, 0, 1);
  }

  /**
   * Dominance: presence + boosts validados por dwell mínimo + penalty por saturación.
   */
  _computeDominance(ctx, presenceScore, now) {
    let score = presenceScore;

    // Modal boost solo si el modal sobrevivió dwell mínimo
    if (ctx.modalState && ctx.modalStartedAt > 0) {
      const dwell = now - ctx.modalStartedAt;
      if (dwell >= this.config.modalMinDwellMs) {
        score += this.config.modalDominanceBoost;
      }
    }

    // Hover boost solo si el hover sobrevivió dwell mínimo
    if (ctx.hoverState && ctx.hoverStartedAt > 0) {
      const dwell = now - ctx.hoverStartedAt;
      if (dwell >= this.config.hoverMinDwellMs) {
        score += this.config.hoverBoost;
      }
    }

    // Listing stability: solo si lleva tiempo siendo visible (no boost gratis)
    if (ctx.contextType === 'listing' && ctx.visibleDuration >= this.config.visibilityConfidenceWindowMs) {
      score += this.config.listingStabilityBoost;
    }

    // Penalty por saturación (fatigue feedback)
    if (ctx.saturationFlag) {
      score -= this.config.saturatedContextPenalty;
    }

    return clamp(score, 0, 1);
  }

  /**
   * API pública para preview (puro, no muta).
   */
  computePresenceScore(ctx, now) {
    const visConf = this._computeVisibilityConfidence(ctx, now);
    const intConf = this._computeInteractionConfidence(ctx, now);
    const persist = this._computeContextPersistence(ctx, now);
    return this._computePresenceFromComponents(visConf, intConf, persist);
  }

  /**
   * API pública para preview (puro, no muta).
   */
  computeContextDominance(ctx, now) {
    const presence = this.computePresenceScore(ctx, now);
    return this._computeDominance(ctx, presence, now);
  }

  // ------------------------------------------------------------------
  // Internos: mutación de state (siempre vía evaluate)
  // ------------------------------------------------------------------

  /**
   * Sincroniza state bruto de cada contexto con lo reportado por la UI.
   * Contextos no incluidos en candidateContexts se marcan como NO visibles/hover/modal.
   */
  _syncCandidates(candidateContexts, now) {
    if (!Array.isArray(candidateContexts)) candidateContexts = [];

    const reportedKeys = new Set();

    for (const cand of candidateContexts) {
      if (!cand || typeof cand.contextType !== 'string') continue;
      const key = this._makeKey(cand.contextType, cand.productId);
      reportedKeys.add(key);

      let ctx = this._contexts.get(key);
      const isNew = !ctx;
      if (isNew) {
        ctx = new ContextPresence(cand.contextType, cand.productId || null, now);
        this._contexts.set(key, ctx);
      }

      const newVisible = !!cand.visible;
      const newHover = !!cand.hoverState;
      const newModal = !!cand.modalState;
      const coverage = clamp(safeNumber(cand.viewportCoverage), 0, 1);

      // ---- visibleDuration coherente (transition-driven) ----
      if (newVisible && !ctx.wasVisibleLastTick) {
        // Entró a ser visible
        ctx.visibleSegmentStartedAt = now;
        // Si el gap desde la última visibilidad es corto, continuamos sumando.
        // Si es largo, reseteamos el acumulador.
        const gapSinceLastVisible = ctx.lastVisibleAt > 0 ? now - ctx.lastVisibleAt : Infinity;
        if (gapSinceLastVisible > this.config.visibilityResumeGapMs) {
          ctx.visibleDuration = 0;
        }
      } else if (!newVisible && ctx.wasVisibleLastTick) {
        // Salió de ser visible
        if (ctx.visibleSegmentStartedAt > 0) {
          ctx.visibleDuration += Math.max(0, now - ctx.visibleSegmentStartedAt);
        }
        ctx.visibleSegmentStartedAt = 0;
        ctx.exitedAt = now;
      } else if (newVisible && ctx.wasVisibleLastTick) {
        // Sigue visible: no acumulamos en cada tick, lo hacemos al exit.
        // Pero exponemos un acumulado parcial para que confidence pueda crecer.
        if (ctx.visibleSegmentStartedAt > 0) {
          // visibleDuration efectivo = base acumulada + segmento abierto
          // Lo calculamos efímeramente sin mutar (lo hace _computeVisibilityConfidence).
          // Para mantener la API simple, sí actualizamos el campo expuesto:
          const segDur = Math.max(0, now - ctx.visibleSegmentStartedAt);
          // El acumulado se materializa al cerrar; para el cómputo usamos el segmento abierto.
          ctx._currentVisibleDurationProjection = ctx.visibleDuration + segDur;
        }
      }

      // ---- hover dwell start tracking ----
      if (newHover && !ctx.hoverState) {
        ctx.hoverStartedAt = now;
      } else if (!newHover && ctx.hoverState) {
        ctx.hoverStartedAt = 0;
      }

      // ---- modal dwell start tracking ----
      if (newModal && !ctx.modalState) {
        ctx.modalStartedAt = now;
      } else if (!newModal && ctx.modalState) {
        ctx.modalStartedAt = 0;
      }

      // ---- Aplicar nuevo state ----
      ctx.visible = newVisible;
      ctx.hoverState = newHover;
      ctx.modalState = newModal;
      ctx.viewportCoverage = coverage;
      if (newVisible) ctx.lastVisibleAt = now;
      ctx.wasVisibleLastTick = newVisible;
    }

    // ---- Contextos NO reportados esta vez: marcar como NO visible/hover/modal ----
    for (const [key, ctx] of this._contexts.entries()) {
      if (reportedKeys.has(key)) continue;
      // Si estaba visible y ahora no se reporta, tratamos como exit
      if (ctx.wasVisibleLastTick) {
        if (ctx.visibleSegmentStartedAt > 0) {
          ctx.visibleDuration += Math.max(0, now - ctx.visibleSegmentStartedAt);
          ctx.visibleSegmentStartedAt = 0;
        }
        ctx.exitedAt = now;
      }
      ctx.visible = false;
      ctx.wasVisibleLastTick = false;
      ctx.hoverState = false;
      ctx.hoverStartedAt = 0;
      ctx.modalState = false;
      ctx.modalStartedAt = 0;
      ctx.viewportCoverage = 0;
    }
  }

  /**
   * Aplica deltas explícitos de interacción por contexto+producto (no por contextType).
   */
  _applyInteractionDeltas(interactionsDelta, now) {
    if (!Array.isArray(interactionsDelta) || interactionsDelta.length === 0) return;
    for (const d of interactionsDelta) {
      if (!d || typeof d.contextType !== 'string') continue;
      const count = Math.max(0, safeNumber(d.count, 0));
      if (count <= 0) continue;
      const key = this._makeKey(d.contextType, d.productId);
      const ctx = this._contexts.get(key);
      if (!ctx) continue; // Solo aplicamos a contextos ya sincronizados
      // Cap del contador para evitar saturación silenciosa
      ctx.interactionCount = Math.min(ctx.interactionCount + count, 1000);
      ctx.lastInteractionAt = now;
    }
  }

  /**
   * Aplica el flag saturationFlag a las claves listadas.
   */
  _applySaturatedContexts(saturatedKeys) {
    if (!Array.isArray(saturatedKeys)) return;
    const set = new Set(saturatedKeys);
    for (const [key, ctx] of this._contexts.entries()) {
      ctx.saturationFlag = set.has(key);
    }
  }

  /**
   * Recomputa todos los scores de un contexto a partir de su state actual.
   */
  _computeAllScores(ctx, behavioralState, now) {
    ctx.visibilityConfidence = this._computeVisibilityConfidence(ctx, now);
    ctx.interactionConfidence = this._computeInteractionConfidence(ctx, now);
    ctx.persistenceScore = this._computeContextPersistence(ctx, now);
    ctx.presenceScore = this._computePresenceFromComponents(
      ctx.visibilityConfidence,
      ctx.interactionConfidence,
      ctx.persistenceScore,
    );
    ctx.dominanceScore = this._computeDominance(ctx, ctx.presenceScore, now);

    // Estabilidad: fraction de tiempo activo (sin saltos)
    const ageMs = Math.max(0, now - (ctx.enteredAt || now));
    ctx.stabilityScore = clamp(ageMs / 30000, 0, 0.9);
  }

  /**
   * Limpia contextos invalidados. Usa scores FRESCOS (post _computeAllScores).
   */
  _cleanupInvalidContexts(now) {
    const toDelete = [];
    for (const [key, ctx] of this._contexts.entries()) {
      if (this._shouldInvalidate(ctx, now)) toDelete.push(key);
    }
    for (const key of toDelete) {
      this._contexts.delete(key);
      if (key === this._activeContextKey) {
        this._activeContextKey = null;
      }
      this._emit('__presence:context_invalidated', { key, sessionId: this._sessionId }, now);
    }
  }

  _shouldInvalidate(ctx, now) {
    if (!ctx) return true;
    const lastSignal = Math.max(ctx.lastInteractionAt, ctx.lastVisibleAt, ctx.enteredAt);
    if (lastSignal === 0) return false; // contexto recién creado en este tick
    const idle = now - lastSignal;
    if (ctx.presenceScore < this.config.invalidationPresenceFloor
        && idle > this.config.invalidationIdleMs) {
      return true;
    }
    return false;
  }

  /**
   * Aplica cap de memoria. Usa scores FRESCOS.
   */
  _enforceContextMemoryCap() {
    if (this._contexts.size <= this.config.maxContextMemory) return;
    const sorted = Array.from(this._contexts.entries())
      .sort((a, b) => b[1].presenceScore - a[1].presenceScore);
    const keep = new Set(sorted.slice(0, this.config.maxContextMemory).map(([k]) => k));
    for (const [key] of this._contexts.entries()) {
      if (!keep.has(key)) {
        if (key === this._activeContextKey) this._activeContextKey = null;
        this._contexts.delete(key);
      }
    }
  }

  /**
   * Ranking final por dominance.
   */
  _computeDominanceRanking() {
    const list = [];
    for (const [key, ctx] of this._contexts.entries()) {
      list.push({ key, ctx });
    }
    list.sort((a, b) => b.ctx.dominanceScore - a.ctx.dominanceScore);
    return list;
  }

  /**
   * Decide active context con:
   *  - promotionThreshold como floor del challenger
   *  - demotionThreshold como floor del incumbente (si cae bajo esto, demotable)
   *  - hysteresisMargin asimétrico (incumbente tiene ventaja)
   *  - refractoryMs como hard lockout post-switch (NO solo penalty)
   */
  _decideActiveContext(ranked, now) {
    if (ranked.length === 0) {
      return { newActiveKey: null, reason: 'no_candidates' };
    }

    const topEntry = ranked[0];
    const topScore = topEntry.ctx.dominanceScore;

    const currentKey = this._activeContextKey;
    const currentCtx = currentKey ? this._contexts.get(currentKey) : null;

    // No hay activo: requiere superar promotionThreshold para promocionar.
    if (!currentCtx) {
      if (topScore >= this.config.promotionThreshold) {
        return { newActiveKey: topEntry.key, reason: 'initial_promotion' };
      }
      return { newActiveKey: null, reason: 'top_below_promotion_threshold' };
    }

    // Si el top es el actual, no hay cambio.
    if (topEntry.key === currentKey) {
      return { newActiveKey: currentKey, reason: 'incumbent_top' };
    }

    // Refractory period: hard lockout
    const sinceLastSwitch = now - this._lastContextSwitchTime;
    if (this._lastContextSwitchTime > 0 && sinceLastSwitch < this.config.switchRefractoryMs) {
      return { newActiveKey: currentKey, reason: 'refractory_period' };
    }

    const currentScore = currentCtx.dominanceScore;

    // Si el incumbente está fuerte (> demotionThreshold), challenger debe superar por margin.
    if (currentScore >= this.config.demotionThreshold) {
      const gap = topScore - currentScore;
      // Aplicar penalty si estamos cerca del refractory (gradient)
      let effectiveGap = gap;
      if (sinceLastSwitch < this.config.switchRefractoryMs * 2) {
        effectiveGap -= this.config.rapidContextSwitchPenalty;
      }
      if (effectiveGap > this.config.hysteresisMargin
          && topScore >= this.config.promotionThreshold) {
        return { newActiveKey: topEntry.key, reason: `score_gap_${gap.toFixed(2)}` };
      }
      return { newActiveKey: currentKey, reason: 'insufficient_gap' };
    }

    // Incumbente débil (< demotionThreshold) y top supera promotionThreshold → switch
    if (topScore >= this.config.promotionThreshold) {
      return { newActiveKey: topEntry.key, reason: 'incumbent_demoted' };
    }

    // Incumbente débil pero ningún challenger viable → mantener (o limpiar)
    return { newActiveKey: currentKey, reason: 'no_viable_challenger' };
  }

  /**
   * Valida que una transición sobreviva el dwell mínimo.
   * Para 'to': si es modal/hover y el dwell aún no se cumplió, rechazamos.
   */
  _isTransitionValid(fromKey, toKey, now, reason) {
    // Refractory period y missing son siempre válidos
    if (reason === 'active_context_missing' || reason === 'initial_promotion'
        || reason === 'incumbent_demoted' || reason === 'no_viable_challenger') {
      return true;
    }
    if (!toKey) return true;
    const toCtx = this._contexts.get(toKey);
    if (!toCtx) return false;
    // Si el contexto destino acaba de aparecer (< transitionMinDwellMs), rechazar
    const ageInLastTick = now - toCtx.enteredAt;
    if (ageInLastTick < this.config.transitionMinDwellMs) {
      return false;
    }
    return true;
  }

  /**
   * Registra una transición en el ring buffer.
   */
  _registerTransition(fromKey, toKey, reason, now) {
    this._transitionHistory.push({
      from: fromKey,
      to: toKey,
      reason,
      timestamp: now,
    });
    this._version++;
  }

  /**
   * Watchdog: si el active está bajo su demotionThreshold por mucho tiempo, log.
   */
  _runStaleActiveWatchdog(now) {
    if (!this._activeContextKey) {
      this._lastActiveScoreCheckAt = 0;
      return;
    }
    const ctx = this._contexts.get(this._activeContextKey);
    if (!ctx) return;
    if (ctx.dominanceScore < this.config.demotionThreshold) {
      if (this._lastActiveScoreCheckAt === 0) {
        this._lastActiveScoreCheckAt = now;
      } else if (now - this._lastActiveScoreCheckAt > this.config.staleActiveWarnMs) {
        this._log('warn', 'stale_active_context', {
          key: this._activeContextKey,
          score: ctx.dominanceScore,
          elapsed: now - this._lastActiveScoreCheckAt,
        });
        this._emit('__presence:stale_active', {
          key: this._activeContextKey,
          score: ctx.dominanceScore,
          sessionId: this._sessionId,
        }, now);
        // Reset para no spamear
        this._lastActiveScoreCheckAt = now;
      }
    } else {
      this._lastActiveScoreCheckAt = 0;
    }
  }

  _makeKey(contextType, productId) {
    if (productId === undefined || productId === null || productId === '') return contextType;
    return `${contextType}:${productId}`;
  }

  _serializeContext(ctx) {
    return {
      contextType: ctx.contextType,
      productId: ctx.productId,
      key: ctx.key,
      visible: ctx.visible,
      hoverState: ctx.hoverState,
      modalState: ctx.modalState,
      viewportCoverage: ctx.viewportCoverage,
      visibleDuration: ctx.visibleDuration,
      interactionCount: ctx.interactionCount,
      lastInteractionAt: ctx.lastInteractionAt,
      lastVisibleAt: ctx.lastVisibleAt,
      enteredAt: ctx.enteredAt,
      exitedAt: ctx.exitedAt,
      presenceScore: ctx.presenceScore,
      visibilityConfidence: ctx.visibilityConfidence,
      interactionConfidence: ctx.interactionConfidence,
      persistenceScore: ctx.persistenceScore,
      dominanceScore: ctx.dominanceScore,
      stabilityScore: ctx.stabilityScore,
      saturationFlag: ctx.saturationFlag,
    };
  }

  // ------------------------------------------------------------------
  // Diagnostics / Snapshot / Restore
  // ------------------------------------------------------------------

  generatePresenceDiagnostics(now) {
    this._assertAlive();
    const ranked = this._computeDominanceRanking();
    return {
      activeContextKey: this._activeContextKey,
      lastContextSwitchTime: this._lastContextSwitchTime,
      sinceLastSwitch: this._lastContextSwitchTime ? Math.max(0, now - this._lastContextSwitchTime) : null,
      contexts: ranked.map(r => ({
        key: r.key,
        contextType: r.ctx.contextType,
        productId: r.ctx.productId,
        dominance: r.ctx.dominanceScore,
        presence: r.ctx.presenceScore,
        stability: r.ctx.stabilityScore,
        visible: r.ctx.visible,
        hover: r.ctx.hoverState,
        modal: r.ctx.modalState,
        saturated: r.ctx.saturationFlag,
      })),
      transitionHistory: this._transitionHistory.toArrayNewestFirst().slice(0, 10),
      version: this._version,
      sessionId: this._sessionId,
    };
  }

  createPresenceSnapshot() {
    this._assertAlive();
    const contexts = {};
    for (const [key, ctx] of this._contexts.entries()) {
      contexts[key] = ctx.serialize();
    }
    return {
      __schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: this._sessionId,
      activeContextKey: this._activeContextKey,
      lastContextSwitchTime: this._lastContextSwitchTime,
      transitionHistory: this._transitionHistory.snapshot(),
      lastNow: this._lastNow,
      contexts,
      version: this._version,
    };
  }

  /**
   * Restaura un snapshot.
   * @param {object} snapshot
   * @param {number} now - REQUERIDO, usado como reloj base para recomputar scores.
   */
  restorePresenceSnapshot(snapshot, now) {
    this._assertAlive();
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('[ContextPresenceEngine] snapshot must be an object');
    }
    if (!Number.isFinite(now)) {
      throw new Error('[ContextPresenceEngine] restore requires a finite `now`');
    }
    if (snapshot.__schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      this._log('warn', 'snapshot_version_mismatch', {
        expected: SNAPSHOT_SCHEMA_VERSION,
        got: snapshot.__schemaVersion,
      });
    }
    // Guard contra `now` que va hacia atrás respecto al snapshot
    const snapshotNow = safeNumber(snapshot.lastNow, 0);
    if (now < snapshotNow) {
      throw new Error('[ContextPresenceEngine] restore `now` is older than snapshot.lastNow');
    }

    this._activeContextKey = snapshot.activeContextKey || null;
    this._lastContextSwitchTime = safeNumber(snapshot.lastContextSwitchTime, 0);
    this._transitionHistory.restore(Array.isArray(snapshot.transitionHistory) ? snapshot.transitionHistory : []);
    this._version = safeNumber(snapshot.version, 1);
    this._lastNow = Math.max(this._lastNow, snapshotNow);

    this._contexts.clear();
    const contexts = snapshot.contexts || {};
    for (const key of Object.keys(contexts)) {
      const data = contexts[key];
      if (!data || typeof data !== 'object') continue;
      const ctx = ContextPresence.fromSnapshot(data);
      this._contexts.set(key, ctx);
      // Recomputar scores con el `now` actual (no se serializan los scores)
      this._computeAllScores(ctx, {}, now);
    }

    // Si el active activo no existe en los contextos restaurados, limpiarlo.
    if (this._activeContextKey && !this._contexts.has(this._activeContextKey)) {
      this._activeContextKey = null;
    }

    this._emit('__presence:restored', {
      sessionId: this._sessionId,
      contextCount: this._contexts.size,
    }, now);
  }

  reset(now) {
    this._assertAlive();
    if (Number.isFinite(now)) this._lastNow = Math.max(this._lastNow, now);
    this._contexts.clear();
    this._activeContextKey = null;
    this._lastContextSwitchTime = 0;
    this._transitionHistory.clear();
    this._lastActiveScoreCheckAt = 0;
    this._evaluationDedup.clear();
    this._version++;
    this._emit('__presence:reset', { sessionId: this._sessionId }, now);
  }

  /**
   * Teardown total: marca la instancia como inutilizable.
   */
  dispose(now) {
    if (this._disposed) return;
    if (Number.isFinite(now)) {
      this._emit('__presence:disposed', { sessionId: this._sessionId }, now);
    }
    this._contexts.clear();
    this._activeContextKey = null;
    this._transitionHistory.clear();
    this._evaluationDedup.clear();
    this._eventBus = null;
    this._logger = null;
    this._disposed = true;
  }

  // ------------------------------------------------------------------
  // Internal getters for tests/diagnostics
  // ------------------------------------------------------------------
  get version() { return this._version; }
  get sessionId() { return this._sessionId; }
  get isDisposed() { return this._disposed; }
  get contextCount() { return this._contexts.size; }
}

// ----------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------
module.exports = {
  ContextPresenceEngine,
  ContextPresence,
  PRESENCE_LEVELS,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
};
