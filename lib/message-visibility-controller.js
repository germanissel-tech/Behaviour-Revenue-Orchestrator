/**
 * message-visibility-controller.js
 *
 * Controla el ciclo de vida visual de mensajes/intervenciones.
 * No decide ranking, política ni intención. Solo gestiona:
 *   - cuándo mostrar, cuánto tiempo, cuándo ocultar
 *   - exclusividad visual (un solo mensaje activo por instancia)
 *   - anti-flickering, hysteresis, persistencia contextual
 *   - limpieza por cambio de contexto, producto o modal
 *   - replay-safe vía `now` explícito y snapshots versionados
 *
 * Garantías estructurales:
 *   - Determinista dado (estado interno + input + now). No usa Date.now()
 *     ni Math.random() en ningún path.
 *   - Idempotente bajo reevaluaciones consecutivas con el mismo input.
 *   - Replay-safe: el estado completo es serializable vía snapshot.
 *   - Reentrancy-safe: protegido contra evaluación recursiva sincrónica.
 *
 * NO garantiza exclusividad inter-instancia: para eso úsese
 * MessageVisibilityRegistry o un único controlador compartido.
 */

'use strict';

// ----------------------------------------------------------------------
// Constantes internas
// ----------------------------------------------------------------------
const SNAPSHOT_SCHEMA_VERSION = 2;
const DEFAULT_CONTEXT_STABILITY_MS = 500;
const DEFAULT_CONTEXT_CACHE_MAX_ENTRIES = 64;
const DEFAULT_CONTEXT_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_FATIGUE_THRESHOLD = 0.7;

// ----------------------------------------------------------------------
// Configuración (deep-frozen)
// ----------------------------------------------------------------------
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = out[key];
    if (
      srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      out[key] = deepMerge(tgtVal, srcVal);
    } else if (srcVal !== undefined) {
      out[key] = srcVal;
    }
  }
  return out;
}

const DEFAULT_CONFIG = deepFreeze({
  // Temporizadores por tipo de contexto (ms)
  minimumVisibleTime: {
    listing: 3000,
    product_detail: 2500,
    modal: 4000,
    cart: 3500,
    hover_cta: 2000,
    default: 3000,
  },
  maximumVisibleTime: {
    listing: 12000,
    product_detail: 15000,
    modal: 20000,
    cart: 18000,
    hover_cta: 8000,
    default: 15000,
  },
  delayedRenderTime: {
    listing: 800,
    product_detail: 400,
    modal: 200,
    cart: 500,
    hover_cta: 300,
    default: 500,
  },

  decayTimeMs: 5000,
  hysteresisWindowMs: 1000,
  contextStabilityMs: DEFAULT_CONTEXT_STABILITY_MS,

  replacementDominanceThreshold: 0.2,
  rapidContextSwitchPenalty: 0.15,
  weightDominance: 0.5,
  weightUrgency: 0.3,
  weightRelevance: 0.2,

  fatigueThreshold: DEFAULT_FATIGUE_THRESHOLD,

  // Cache de contextos observados
  contextCacheMaxEntries: DEFAULT_CONTEXT_CACHE_MAX_ENTRIES,
  contextCacheTtlMs: DEFAULT_CONTEXT_CACHE_TTL_MS,
});

// ----------------------------------------------------------------------
// Logger noop por defecto
// ----------------------------------------------------------------------
const NOOP_LOGGER = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
});

// ----------------------------------------------------------------------
// Errores tipados
// ----------------------------------------------------------------------
class MessageVisibilityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MessageVisibilityError';
    this.code = code;
  }
}

// ----------------------------------------------------------------------
// Clase principal
// ----------------------------------------------------------------------
class MessageVisibilityController {
  constructor(config = {}, deps = {}) {
    // Deep-merge preserva sub-objetos no override-eados
    this.config = deepMerge(DEFAULT_CONFIG, config);

    // Dependencias inyectables
    this._logger = deps.logger || NOOP_LOGGER;
    this._onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null;

    // Estado interno
    this._currentMessage = null;
    this._visibleSince = 0;
    this._lastReplacementTime = 0;
    this._lastInteractionAt = 0; // interacción real con el mensaje activo

    // contextType -> last observed timestamp
    this._contextLastSeen = new Map();

    // Versionado (monótono creciente)
    this._version = 1;

    // Reentrancy guard
    this._evaluating = false;
  }

  // ==================================================================
  // API pública: evaluación principal
  // ==================================================================

  /**
   * Evalúa el estado y decide la acción visual.
   *
   * Entradas relevantes en `input`:
   *   - candidateMessage   : próximo mensaje propuesto (o null)
   *   - contextState       : { activeContext, currentContext, activeProductId, ... }
   *   - behavioralState    : opcional
   *   - transitionState    : opcional
   *   - fatigueState       : { fatigueScore, ... } (opcional)
   *   - interactionState   : { lastInteractionAt } (opcional)
   *   - now                : timestamp monótono (ms). REQUERIDO.
   *
   * @returns {object} { action, reason, message, visibilityTiming, persistence, version }
   */
  evaluateMessageVisibility(input) {
    if (!input || typeof input !== 'object') {
      throw new MessageVisibilityError('input is required', 'E_INPUT_MISSING');
    }
    const { now } = input;
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new MessageVisibilityError('input.now must be a finite number', 'E_NOW_INVALID');
    }

    if (this._evaluating) {
      // Reentrancy: rechazamos antes que corromper estado.
      this._logger.warn('[mvc] reentrant evaluateMessageVisibility ignored', { version: this._version });
      return this._buildDecision('reentrant_noop', 'reentrancy_guard', null, now, /*pure*/ true);
    }
    this._evaluating = true;
    try {
      return this._evaluateInternal(input);
    } finally {
      this._evaluating = false;
    }
  }

  _evaluateInternal(input) {
    const {
      candidateMessage = null,
      contextState = null,
      behavioralState = null,
      fatigueState = null,
      interactionState = null,
      now,
    } = input;

    // (a) Ingestar interacción real reportada por el integrador.
    if (interactionState && typeof interactionState.lastInteractionAt === 'number') {
      if (interactionState.lastInteractionAt > this._lastInteractionAt) {
        this._lastInteractionAt = interactionState.lastInteractionAt;
        if (this._currentMessage) {
          this._currentMessage.lastInteractionAt = this._lastInteractionAt;
        }
      }
    }

    // (b) Observar contexto activo SIEMPRE, sin depender de si hay mensaje.
    const observedContext =
      (contextState && (contextState.activeContext || contextState.currentContext)) || null;
    if (observedContext) {
      this._observeContext(observedContext, now);
    }

    // 1. Limpieza contextual: si el contexto dominante cambió respecto al
    //    mensaje actual, se evalúa eliminación (respetando minimumVisibleTime
    //    salvo cambio de producto o expiración dura).
    const cleanup = this._checkContextualCleanup(contextState, now);
    if (cleanup.shouldClear) {
      this._clearCurrentMessage(cleanup.reason, now);
    }

    // 2. Sin mensaje actual -> evaluar candidato
    if (!this._currentMessage) {
      if (!candidateMessage) {
        return this._buildDecision('none', 'no_message', null, now);
      }
      const showCheck = this._evaluateDisplay(candidateMessage, contextState, behavioralState, fatigueState, now);
      if (showCheck.decision) {
        this._setCurrentMessage(candidateMessage, now);
        return this._buildDecision('show', showCheck.reason, this._currentMessage, now);
      }
      return this._buildDecision('delay', showCheck.reason, null, now);
    }

    // 3. Hay mensaje actual: checar remoción por tiempo/contexto/producto
    const removal = this._evaluateRemoval(this._currentMessage, contextState, now);
    if (removal.shouldRemove) {
      this._clearCurrentMessage(removal.reason, now);
      if (candidateMessage) {
        const showCheck = this._evaluateDisplay(candidateMessage, contextState, behavioralState, fatigueState, now);
        if (showCheck.decision) {
          this._setCurrentMessage(candidateMessage, now);
          return this._buildDecision('show_after_removal', showCheck.reason, this._currentMessage, now);
        }
      }
      return this._buildDecision('removed', removal.reason, null, now);
    }

    // 4. Candidato propuesto: evaluar reemplazo
    if (candidateMessage) {
      // Dedupe estricto por messageId: no re-mostrar el mismo mensaje.
      if (
        this._currentMessage.messageId != null &&
        candidateMessage.messageId === this._currentMessage.messageId
      ) {
        return this._buildDecision('keep', 'same_message_id', this._currentMessage, now);
      }
      const replace = this._evaluateReplace(this._currentMessage, candidateMessage, contextState, now);
      if (replace.shouldReplace) {
        this._clearCurrentMessage(replace.reason, now);
        this._setCurrentMessage(candidateMessage, now);
        return this._buildDecision('replace', replace.reason, this._currentMessage, now);
      }
    }

    // 5. Mantener
    return this._buildDecision('keep', 'no_replacement_needed', this._currentMessage, now);
  }

  // ==================================================================
  // API pública: queries puras (sin efectos secundarios)
  // ==================================================================
  //
  // IMPORTANTE: estas son queries sobre el estado interno de la instancia.
  // Son deterministas dado (estado + args), pero NO puras en el sentido
  // funcional estricto: leen `this._currentMessage`, `this._visibleSince`,
  // `this._contextLastSeen`, etc. Si necesitas pureza absoluta para tests,
  // usa createVisibilitySnapshot() + restoreVisibilitySnapshot() para
  // congelar el estado primero.
  //
  // Ninguna de estas funciones muta estado.

  shouldDisplayMessage(candidate, contextState, behavioralState, fatigueState, now) {
    return this._evaluateDisplay(candidate, contextState, behavioralState, fatigueState, now);
  }

  shouldRemoveMessage(message, contextState, now) {
    return this._evaluateRemoval(message, contextState, now);
  }

  shouldReplaceMessage(current, candidate, contextState, now) {
    return this._evaluateReplace(current, candidate, contextState, now);
  }

  // ==================================================================
  // Lógica interna de decisión (sin efectos secundarios)
  // ==================================================================

  _evaluateDisplay(candidate, contextState, behavioralState, fatigueState, now) {
    if (!candidate) {
      return { decision: false, reason: 'no_candidate' };
    }

    const contextType = this._resolveContextType(candidate, contextState);

    if (this._currentMessage) {
      return { decision: false, reason: 'message_already_visible' };
    }

    // Estabilidad contextual mínima (anti-flicker).
    if (!this._isContextStable(contextType, now)) {
      return { decision: false, reason: 'context_unstable' };
    }

    // Delay de render desde primera observación del contexto.
    const delay = this._getDelayedRenderTime(contextType);
    const lastContextSeen = this._contextLastSeen.get(contextType);
    if (lastContextSeen === undefined) {
      // No deberíamos llegar aquí porque _observeContext corre antes,
      // pero defendemos el invariante.
      return { decision: false, reason: 'context_not_observed' };
    }
    if (now - lastContextSeen < delay) {
      return { decision: false, reason: 'delayed_render_not_met' };
    }

    // Fatiga (ahora correctamente parametrizada).
    if (fatigueState && typeof fatigueState.fatigueScore === 'number') {
      if (fatigueState.fatigueScore > this.config.fatigueThreshold) {
        return { decision: false, reason: 'high_fatigue' };
      }
    }

    return { decision: true, reason: 'display_allowed' };
  }

  _evaluateRemoval(message, contextState, now) {
    if (!message) return { shouldRemove: false, reason: 'no_message' };

    const contextType = this._resolveContextType(message, contextState);
    const shownAt = (typeof message.shownAt === 'number') ? message.shownAt : this._visibleSince;
    const visibleDuration = now - shownAt;
    const minTime = this._getMinimumVisibleTime(contextType);
    const maxTime = this._getMaximumVisibleTime(contextType);

    // 1. Timeout duro: siempre se respeta.
    if (visibleDuration > maxTime) {
      return { shouldRemove: true, reason: 'max_visibility_timeout', hard: true };
    }

    // 2. Producto cambiado: invalidación semántica fuerte, sin mínimo.
    if (message.productId != null && contextState && contextState.activeProductId != null) {
      if (contextState.activeProductId !== message.productId) {
        return { shouldRemove: true, reason: 'product_changed', hard: true };
      }
    }

    // 3. Pérdida de contexto dominante: respeta minimumVisibleTime.
    const activeContext = contextState && contextState.activeContext;
    if (activeContext && contextType && activeContext !== contextType) {
      if (visibleDuration < minTime) {
        return { shouldRemove: false, reason: 'context_mismatch_within_min' };
      }
      return { shouldRemove: true, reason: 'context_mismatch' };
    }

    // 4. Decaimiento por inactividad real.
    const lastInteraction = message.lastInteractionAt || this._lastInteractionAt || 0;
    if (lastInteraction > 0 && now - lastInteraction > this.config.decayTimeMs) {
      if (visibleDuration < minTime) {
        return { shouldRemove: false, reason: 'inactivity_within_min' };
      }
      return { shouldRemove: true, reason: 'inactivity_decay' };
    }

    return { shouldRemove: false, reason: 'still_valid' };
  }

  _evaluateReplace(current, candidate, contextState, now) {
    if (!current) return { shouldReplace: true, reason: 'no_current' };
    if (!candidate) return { shouldReplace: false, reason: 'no_candidate' };

    if (current.messageId != null && candidate.messageId === current.messageId) {
      return { shouldReplace: false, reason: 'same_message_id' };
    }

    const contextType = this._resolveContextType(current, contextState);
    const minVisible = this._getMinimumVisibleTime(contextType);
    const shownAt = (typeof current.shownAt === 'number') ? current.shownAt : this._visibleSince;
    const visibleDuration = now - shownAt;
    if (visibleDuration < minVisible) {
      return { shouldReplace: false, reason: 'minimum_visibility_not_met' };
    }

    const wD = this.config.weightDominance;
    const wU = this.config.weightUrgency;
    const wR = this.config.weightRelevance;

    const candidateScore =
      (numOr(candidate.dominance, numOr(candidate.score, 0)) * wD) +
      (numOr(candidate.urgency, 0) * wU) +
      (numOr(candidate.relevance, 0) * wR);

    const currentScore =
      (numOr(current.dominance, 0.5) * wD) +
      (numOr(current.urgency, 0) * wU) +
      (numOr(current.relevance, 0) * wR);

    let gap = candidateScore - currentScore;
    const timeSinceLastReplacement = now - this._lastReplacementTime;
    if (timeSinceLastReplacement < this.config.hysteresisWindowMs) {
      gap -= this.config.rapidContextSwitchPenalty;
    }

    if (gap > this.config.replacementDominanceThreshold) {
      return { shouldReplace: true, reason: `score_gap_${gap.toFixed(2)}` };
    }
    return { shouldReplace: false, reason: 'insufficient_score_gap' };
  }

  // ==================================================================
  // Helpers de tiempo y persistencia (puros sobre args; leen config)
  // ==================================================================

  computeVisibilityTiming(message, contextState, now) {
    if (!message) return { minMs: 0, maxMs: 0, elapsedMs: 0, remainingMinMs: 0, remainingMaxMs: 0 };
    const ctx = this._resolveContextType(message, contextState);
    const minMs = this._getMinimumVisibleTime(ctx);
    const maxMs = this._getMaximumVisibleTime(ctx);
    const shownAt = (typeof message.shownAt === 'number') ? message.shownAt : this._visibleSince;
    const elapsed = Math.max(0, now - shownAt);
    return {
      minMs,
      maxMs,
      elapsedMs: elapsed,
      remainingMinMs: Math.max(0, minMs - elapsed),
      remainingMaxMs: Math.max(0, maxMs - elapsed),
    };
  }

  computeVisibilityPersistence(message, contextState, now) {
    if (!message) return 0;
    const ctx = this._resolveContextType(message, contextState);
    const shownAt = (typeof message.shownAt === 'number') ? message.shownAt : this._visibleSince;
    const visibleDuration = Math.max(0, now - shownAt);
    const maxTime = this._getMaximumVisibleTime(ctx);
    if (visibleDuration >= maxTime) return 0;
    return 1 - (visibleDuration / maxTime);
  }

  computeVisibilityDecay(message, contextState, now) {
    if (!message) return 0;
    const lastInteraction = message.lastInteractionAt || this._lastInteractionAt || this._visibleSince;
    const elapsed = Math.max(0, now - lastInteraction);
    if (elapsed <= 0) return 1;
    return Math.exp(-elapsed / this.config.decayTimeMs);
  }

  // ==================================================================
  // Acciones de control
  // ==================================================================

  /**
   * Registra una interacción explícita con el mensaje visible.
   * Necesario para que el `decayTimeMs` represente inactividad real.
   */
  recordInteraction(messageId, now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new MessageVisibilityError('now must be a finite number', 'E_NOW_INVALID');
    }
    if (!this._currentMessage) return false;
    if (messageId != null && this._currentMessage.messageId !== messageId) return false;
    this._lastInteractionAt = now;
    this._currentMessage.lastInteractionAt = now;
    this._version++;
    this._emit('interaction', { messageId: this._currentMessage.messageId, now });
    return true;
  }

  /**
   * Notifica al controlador de un cambio de contexto observable,
   * sin necesidad de llamar al evaluador completo. Útil para
   * orquestadores que quieren marcar la entrada de un contexto antes
   * de tener un candidato listo.
   */
  observeContext(contextType, now) {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new MessageVisibilityError('now must be a finite number', 'E_NOW_INVALID');
    }
    if (!contextType) return;
    this._observeContext(contextType, now);
  }

  clearCurrentMessage(reason, now) {
    this._clearCurrentMessage(reason || 'manual_clear', now);
  }

  invalidateMessageVisibility(messageId, reason, now) {
    if (this._currentMessage && this._currentMessage.messageId === messageId) {
      this._clearCurrentMessage(reason || 'invalidated', now);
      return true;
    }
    return false;
  }

  reset(now) {
    const had = !!this._currentMessage;
    this._currentMessage = null;
    this._visibleSince = 0;
    this._lastReplacementTime = 0;
    this._lastInteractionAt = 0;
    this._contextLastSeen.clear();
    this._version++;
    if (had) this._emit('reset', { now });
  }

  // ==================================================================
  // Snapshots / diagnostics
  // ==================================================================

  generateVisibilityDiagnostics(now) {
    return {
      currentMessage: this._currentMessage ? {
        messageId: this._currentMessage.messageId,
        family: this._currentMessage.family,
        contextType: this._currentMessage.contextType,
        visibleSince: this._visibleSince,
        visibleDurationMs: Math.max(0, now - this._visibleSince),
        persistence: this.computeVisibilityPersistence(this._currentMessage, null, now),
        lastInteractionAt: this._currentMessage.lastInteractionAt,
      } : null,
      lastReplacementTime: this._lastReplacementTime,
      lastInteractionAt: this._lastInteractionAt,
      contextLastSeen: Array.from(this._contextLastSeen.entries()),
      version: this._version,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    };
  }

  createVisibilitySnapshot() {
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      currentMessage: this._currentMessage ? { ...this._currentMessage } : null,
      visibleSince: this._visibleSince,
      lastReplacementTime: this._lastReplacementTime,
      lastInteractionAt: this._lastInteractionAt,
      contextLastSeen: Array.from(this._contextLastSeen.entries()),
      version: this._version,
    };
  }

  restoreVisibilitySnapshot(snapshot, now) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      throw new MessageVisibilityError('now must be a finite number', 'E_NOW_INVALID');
    }
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      this._logger.warn('[mvc] snapshot schema mismatch', {
        expected: SNAPSHOT_SCHEMA_VERSION,
        got: snapshot.schemaVersion,
      });
      return false;
    }

    // Sanity de timestamps: no aceptamos futuros respecto a `now`.
    const visibleSince = numOr(snapshot.visibleSince, 0);
    const lastReplacementTime = numOr(snapshot.lastReplacementTime, 0);
    const lastInteractionAt = numOr(snapshot.lastInteractionAt, 0);
    if (visibleSince > now || lastReplacementTime > now || lastInteractionAt > now) {
      this._logger.warn('[mvc] snapshot has timestamps in the future', { now });
      return false;
    }

    this._currentMessage = snapshot.currentMessage ? { ...snapshot.currentMessage } : null;
    this._visibleSince = visibleSince;
    this._lastReplacementTime = lastReplacementTime;
    this._lastInteractionAt = lastInteractionAt;
    this._contextLastSeen = new Map(
      Array.isArray(snapshot.contextLastSeen)
        ? snapshot.contextLastSeen.filter(([k, v]) => typeof v === 'number' && v <= now)
        : []
    );
    this._version = numOr(snapshot.version, 1);

    // Si el mensaje restaurado ya expiró, limpiar.
    if (this._currentMessage) {
      const removal = this._evaluateRemoval(this._currentMessage, null, now);
      if (removal.shouldRemove) {
        this._clearCurrentMessage(removal.reason, now);
      }
    }
    this._pruneContextCache(now);
    return true;
  }

  // ==================================================================
  // Internals
  // ==================================================================

  _setCurrentMessage(candidate, now) {
    this._currentMessage = {
      messageId: candidate.messageId,
      family: candidate.family,
      contextType: candidate.contextType,
      productId: candidate.productId,
      shownAt: now,
      lastInteractionAt: now,
      visible: true,
      priority: numOr(candidate.priority, 0.5),
      intensity: numOr(candidate.intensity, 0.3),
      dominance: numOr(candidate.dominance, numOr(candidate.score, 0.5)),
      urgency: numOr(candidate.urgency, 0),
      relevance: numOr(candidate.relevance, 0.5),
      persistenceScore: 1,
    };
    this._visibleSince = now;
    this._lastReplacementTime = now;
    this._lastInteractionAt = now;
    this._version++;
    this._emit('show', {
      messageId: this._currentMessage.messageId,
      family: this._currentMessage.family,
      contextType: this._currentMessage.contextType,
      now,
    });
  }

  _clearCurrentMessage(reason, now) {
    if (!this._currentMessage) return;
    const cleared = {
      messageId: this._currentMessage.messageId,
      family: this._currentMessage.family,
      contextType: this._currentMessage.contextType,
      visibleDurationMs: Math.max(0, now - this._visibleSince),
    };
    this._currentMessage = null;
    this._visibleSince = 0;
    this._lastInteractionAt = 0;
    this._version++;
    this._emit('clear', { ...cleared, reason, now });
  }

  _checkContextualCleanup(contextState, now) {
    const activeContext = contextState && contextState.activeContext;
    if (!activeContext) return { shouldClear: false, reason: 'no_active_context' };
    if (!this._currentMessage) return { shouldClear: false, reason: 'no_current_message' };
    if (this._currentMessage.contextType == null) {
      // Mensajes sin contextType son globales; no se limpian por contexto.
      return { shouldClear: false, reason: 'message_context_agnostic' };
    }
    if (this._currentMessage.contextType === activeContext) {
      return { shouldClear: false, reason: 'context_match' };
    }

    // Respetar minimumVisibleTime salvo expiración dura o cambio de producto,
    // que se manejan en _evaluateRemoval. Aquí solo verificamos cambio de contexto.
    const minTime = this._getMinimumVisibleTime(this._currentMessage.contextType);
    const visibleDuration = Math.max(0, now - this._visibleSince);
    if (visibleDuration < minTime) {
      return { shouldClear: false, reason: 'context_change_within_min' };
    }
    return { shouldClear: true, reason: `context_changed_to_${activeContext}` };
  }

  _isContextStable(contextType, now) {
    const lastSeen = this._contextLastSeen.get(contextType);
    if (lastSeen === undefined) return false;
    return (now - lastSeen) >= this.config.contextStabilityMs;
  }

  _observeContext(contextType, now) {
    // Solo registramos el PRIMER timestamp en el que vimos el contexto
    // dentro de la ventana actual; refrescar en cada tick rompería
    // `delayedRenderTime` y `_isContextStable`. Si el contexto ya está,
    // mantenemos su primera observación.
    if (!this._contextLastSeen.has(contextType)) {
      this._contextLastSeen.set(contextType, now);
    }
    this._pruneContextCache(now);
  }

  _pruneContextCache(now) {
    const ttl = this.config.contextCacheTtlMs;
    const max = this.config.contextCacheMaxEntries;

    if (ttl > 0) {
      for (const [key, ts] of this._contextLastSeen) {
        if (now - ts > ttl) this._contextLastSeen.delete(key);
      }
    }
    if (this._contextLastSeen.size > max) {
      // Maps preservan orden de inserción -> evict los más antiguos.
      const toRemove = this._contextLastSeen.size - max;
      let removed = 0;
      for (const key of this._contextLastSeen.keys()) {
        if (removed >= toRemove) break;
        this._contextLastSeen.delete(key);
        removed++;
      }
    }
  }

  _resolveContextType(messageOrCandidate, contextState) {
    if (messageOrCandidate && messageOrCandidate.contextType) return messageOrCandidate.contextType;
    if (contextState && contextState.currentContext) return contextState.currentContext;
    if (contextState && contextState.activeContext) return contextState.activeContext;
    return 'default';
  }

  _getMinimumVisibleTime(contextType) {
    const table = this.config.minimumVisibleTime;
    return numOr(table[contextType], numOr(table.default, 0));
  }

  _getMaximumVisibleTime(contextType) {
    const table = this.config.maximumVisibleTime;
    return numOr(table[contextType], numOr(table.default, Infinity));
  }

  _getDelayedRenderTime(contextType) {
    const table = this.config.delayedRenderTime;
    return numOr(table[contextType], numOr(table.default, 0));
  }

  _buildDecision(action, reason, message, now, isPure = false) {
    const decision = {
      action,
      reason,
      message: message ? { ...message } : null,
      visibilityTiming: this.computeVisibilityTiming(message, null, now),
      persistence: message ? this.computeVisibilityPersistence(message, null, now) : 0,
      version: this._version,
    };
    if (!isPure) {
      this._emit('decision', { action, reason, version: this._version, now });
    }
    return decision;
  }

  _emit(event, payload) {
    try {
      if (this._onEvent) this._onEvent(event, payload);
      // logger-v2 compat: niveles standard
      const lvl = event === 'clear' || event === 'reset' ? 'info' : 'debug';
      this._logger[lvl](`[mvc] ${event}`, payload);
    } catch (err) {
      // Nunca dejar que telemetría rompa el controlador.
      try { this._logger.error('[mvc] emit_failed', { event, err: String(err) }); } catch (_) {}
    }
  }
}

// ----------------------------------------------------------------------
// Utilidad numérica
// ----------------------------------------------------------------------
function numOr(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

// ----------------------------------------------------------------------
// Registry opcional para garantizar exclusividad inter-instancia
// ----------------------------------------------------------------------
class MessageVisibilityRegistry {
  constructor() {
    this._controllers = new Map(); // key -> controller
    this._active = null;           // key del controller que tiene mensaje visible
  }

  register(key, controller) {
    if (!(controller instanceof MessageVisibilityController)) {
      throw new MessageVisibilityError('controller must be a MessageVisibilityController', 'E_REGISTRY_TYPE');
    }
    this._controllers.set(key, controller);
  }

  unregister(key) {
    if (this._active === key) this._active = null;
    this._controllers.delete(key);
  }

  /**
   * Anuncia que `key` quiere mostrar un mensaje. Si otro controller
   * está activo, lo limpia. Devuelve true si la petición fue aceptada.
   */
  claim(key, now) {
    if (!this._controllers.has(key)) return false;
    if (this._active && this._active !== key) {
      const prev = this._controllers.get(this._active);
      if (prev) prev.clearCurrentMessage('preempted_by_registry', now);
    }
    this._active = key;
    return true;
  }

  release(key) {
    if (this._active === key) this._active = null;
  }

  getActive() {
    if (!this._active) return null;
    return { key: this._active, controller: this._controllers.get(this._active) || null };
  }
}

// ----------------------------------------------------------------------
// Exportación
// ----------------------------------------------------------------------
module.exports = {
  MessageVisibilityController,
  MessageVisibilityRegistry,
  MessageVisibilityError,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
};
