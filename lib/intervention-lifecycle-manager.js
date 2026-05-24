/**
 * intervention-lifecycle-manager.js
 *
 * ARQUITECTURA (post-auditoría):
 *
 *   message-visibility-controller  = ÚNICO owner visual autoritativo.
 *                                    Renderiza, muestra, oculta, controla slots,
 *                                    DOM, transiciones visuales, decide visibilidad final.
 *
 *   intervention-lifecycle-manager = ESTE archivo.
 *                                    Coordinador lógico del lifecycle / behavioral
 *                                    state machine. Decide elegibilidad lógica de
 *                                    candidatos. NUNCA toca DOM, NUNCA decide visibilidad.
 *
 * Este módulo:
 *   - Modela un FSM explícito y estricto sobre cada candidato.
 *   - Es determinista: nunca lee Date.now() ni Math.random(); todo `now` se inyecta.
 *   - Es replay-safe: snapshots versionados, validación temporal, sin efectos secundarios ocultos.
 *   - Es pull-based: no registra listeners ni timers.
 *   - Emite eventos opcionales vía deps.onEvent / deps.logger (compat logger-v2).
 *   - Garantiza invariantes verificables (a lo sumo 1 `active`, terminales inmutables, etc.).
 *
 * Estados del FSM:
 *
 *     created     -> candidato recién registrado, todavía no evaluado.
 *     pending     -> esperando ventana de elegibilidad (cooldown, fatigue, estabilidad ctx).
 *     eligible    -> aprobado lógicamente; el visibility controller PUEDE activarlo.
 *     active      -> el visibility controller reportó activación efectiva.
 *     replaced    -> terminal; el visibility controller reportó reemplazo por otro id.
 *     expired     -> terminal; venció TTL lógico (pending/eligible/active).
 *     suppressed  -> terminal; bloqueado por cooldown/fatigue/context antes o durante.
 *     discarded   -> terminal; descartado por score insuficiente, duplicado, inválido.
 *
 * Tabla de transiciones (única fuente de verdad):
 *
 *     created    -> pending | eligible | discarded | suppressed
 *     pending    -> eligible | expired | suppressed | discarded
 *     eligible   -> active   | expired | suppressed | discarded
 *     active     -> replaced | expired | suppressed
 *     replaced   -> (terminal)
 *     expired    -> (terminal)
 *     suppressed -> (terminal)
 *     discarded  -> (terminal)
 */

'use strict';

// ---------------------------------------------------------------------------
// Constantes y configuración
// ---------------------------------------------------------------------------

const SNAPSHOT_SCHEMA_VERSION = 3;

const STATES = Object.freeze({
  CREATED: 'created',
  PENDING: 'pending',
  ELIGIBLE: 'eligible',
  ACTIVE: 'active',
  REPLACED: 'replaced',
  EXPIRED: 'expired',
  SUPPRESSED: 'suppressed',
  DISCARDED: 'discarded',
});

const TERMINAL_STATES = Object.freeze(
  new Set([STATES.REPLACED, STATES.EXPIRED, STATES.SUPPRESSED, STATES.DISCARDED]),
);

// Tabla de transiciones permitidas. Cualquier transición fuera de aquí lanza.
const TRANSITIONS = Object.freeze({
  [STATES.CREATED]: Object.freeze(
    new Set([STATES.PENDING, STATES.ELIGIBLE, STATES.DISCARDED, STATES.SUPPRESSED]),
  ),
  [STATES.PENDING]: Object.freeze(
    new Set([STATES.ELIGIBLE, STATES.EXPIRED, STATES.SUPPRESSED, STATES.DISCARDED]),
  ),
  [STATES.ELIGIBLE]: Object.freeze(
    new Set([STATES.ACTIVE, STATES.EXPIRED, STATES.SUPPRESSED, STATES.DISCARDED]),
  ),
  [STATES.ACTIVE]: Object.freeze(
    new Set([STATES.REPLACED, STATES.EXPIRED, STATES.SUPPRESSED]),
  ),
  [STATES.REPLACED]: Object.freeze(new Set()),
  [STATES.EXPIRED]: Object.freeze(new Set()),
  [STATES.SUPPRESSED]: Object.freeze(new Set()),
  [STATES.DISCARDED]: Object.freeze(new Set()),
});

const DEFAULT_CONFIG = Object.freeze({
  // TTL lógico de cada estado no-terminal.
  maxPendingMs: 8000,
  maxEligibleWindowMs: 4000,
  maxActiveMs: 15000,

  // Estabilidad contextual mínima antes de declarar eligible.
  contextStabilityMs: 500,

  // Fatigue gate.
  fatigueThreshold: 0.7,

  // Cooldown global entre transiciones a `eligible`.
  minEligibilityIntervalMs: 1500,

  // Cooldown por familia tras terminar (expired/replaced/suppressed).
  familyCooldownMs: 6000,

  // Familias consideradas equivalentes para propagación de cooldown.
  similarFamilies: Object.freeze([
    Object.freeze(['URGENCY', 'EXIT_RISK', 'SCARCITY']),
    Object.freeze(['ASSIST', 'EDUCATIONAL', 'GUIDANCE']),
    Object.freeze(['SOCIAL_PROOF', 'TRUST']),
  ]),

  // Pesos de scoring (efectivos, no decorativos).
  priorityWeight: 0.45,
  intensityWeight: 0.25,
  contextualRelevanceWeight: 0.2,
  behavioralFitWeight: 0.1,

  // Score mínimo para no ser descartado de entrada.
  minAcceptableScore: 0.25,

  // Delta de score que un candidato debe superar al activo para ser tratado
  // como reemplazo lógico. La decisión visual final es del controller.
  replacementScoreDelta: 0.15,

  // Capacidad y limpieza del registro de candidatos.
  candidatesMaxEntries: 256,
  terminalLedgerMaxEntries: 64,

  // Tamaño máximo del history por candidato (defensivo).
  perCandidateHistoryMax: 32,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class InterventionLifecycleError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'InterventionLifecycleError';
    this.code = code || 'E_UNKNOWN';
    this.details = details || null;
  }
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function assertNow(now, where) {
  if (!isFiniteNumber(now) || now < 0) {
    throw new InterventionLifecycleError(
      `Invalid 'now' passed to ${where}: ${String(now)}`,
      'E_NOW_INVALID',
      { now, where },
    );
  }
}

function numOr(value, fallback) {
  return isFiniteNumber(value) ? value : fallback;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.values(obj).forEach(deepFreeze);
  return Object.freeze(obj);
}

function deepMerge(base, override) {
  if (override == null) return cloneDeep(base);
  if (typeof base !== 'object' || base === null) return cloneDeep(override);
  if (typeof override !== 'object' || override === null) return cloneDeep(override);
  if (Array.isArray(base) || Array.isArray(override)) return cloneDeep(override);
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const k of keys) {
    if (k in override) {
      out[k] = deepMerge(base[k], override[k]);
    } else {
      out[k] = cloneDeep(base[k]);
    }
  }
  return out;
}

function cloneDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneDeep);
  const out = {};
  for (const k of Object.keys(value)) out[k] = cloneDeep(value[k]);
  return out;
}

deepFreeze(DEFAULT_CONFIG);

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

class InterventionLifecycleManager {
  /**
   * @param {object} [options]
   * @param {object} [options.config] - Overrides parciales (deep-merge sobre DEFAULT_CONFIG).
   * @param {object} [options.deps]
   * @param {function} [options.deps.onEvent] - (event) => void. event: { type, at, intervention?, from?, to?, reason?, data? }
   * @param {object} [options.deps.logger] - compat logger-v2: { debug, info, warn, error }
   * @param {string} [options.sessionId] - sesión inicial opcional.
   */
  constructor(options) {
    const opts = options || {};
    this.config = Object.freeze(deepMerge(DEFAULT_CONFIG, opts.config || {}));
    this.deps = Object.freeze({
      onEvent: typeof opts.deps?.onEvent === 'function' ? opts.deps.onEvent : null,
      logger: opts.deps?.logger || null,
    });

    this._candidates = new Map(); // id -> intervention object
    this._activeId = null;
    this._lastEligibleAt = 0;
    this._familyCooldowns = new Map(); // family -> expiresAt
    this._terminalLedger = []; // ring buffer de terminales recientes
    this._sessionId = opts.sessionId || null;
    this._sessionStartedAt = 0;
    this._version = 0;
    this._evaluating = false;

    this._familyGroupIndex = this._buildFamilyGroupIndex(this.config.similarFamilies);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  beginSession(sessionId, now) {
    assertNow(now, 'beginSession');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new InterventionLifecycleError(
        'beginSession requires a non-empty sessionId',
        'E_SESSION_INVALID',
      );
    }
    this._resetInternal(now);
    this._sessionId = sessionId;
    this._sessionStartedAt = now;
    this._emit({ type: 'session_begin', at: now, data: { sessionId } });
    return { sessionId, startedAt: now };
  }

  endSession(now, reason) {
    assertNow(now, 'endSession');
    const sid = this._sessionId;
    // Cierra todo no-terminal como suppressed por fin de sesión.
    for (const intervention of this._candidates.values()) {
      if (!TERMINAL_STATES.has(intervention.state)) {
        this._transition(intervention, STATES.SUPPRESSED, now, reason || 'session_end');
      }
    }
    this._emit({ type: 'session_end', at: now, data: { sessionId: sid, reason: reason || null } });
    this._sessionId = null;
    this._sessionStartedAt = 0;
  }

  reset(now) {
    assertNow(now, 'reset');
    this._resetInternal(now);
    this._emit({ type: 'reset', at: now });
  }

  _resetInternal(now) {
    // Marcar todo como suppressed antes de limpiar para emitir trazas.
    for (const intervention of this._candidates.values()) {
      if (!TERMINAL_STATES.has(intervention.state)) {
        this._transition(intervention, STATES.SUPPRESSED, now, 'reset');
      }
    }
    this._candidates.clear();
    this._activeId = null;
    this._lastEligibleAt = 0;
    this._familyCooldowns.clear();
    this._terminalLedger.length = 0;
    this._version += 1;
  }

  // -------------------------------------------------------------------------
  // API pública: proponer / evaluar candidatos
  // -------------------------------------------------------------------------

  /**
   * Registra un candidato y devuelve la decisión lógica inicial.
   * No realiza ninguna acción visual.
   *
   * @returns {{ decision: string, intervention: object|null, reason: string }}
   *   decision in: 'eligible' | 'pending' | 'discarded' | 'suppressed' | 'duplicate' | 'reentrant_noop'
   */
  proposeIntervention(candidate, contextState, behavioralState, fatigueState, now) {
    assertNow(now, 'proposeIntervention');
    if (this._evaluating) {
      this._warn('Reentrant proposeIntervention call detected; returning noop.');
      return { decision: 'reentrant_noop', intervention: null, reason: 'reentrant' };
    }
    this._evaluating = true;
    try {
      const validation = this._validateCandidate(candidate);
      if (!validation.ok) {
        return { decision: 'discarded', intervention: null, reason: validation.reason };
      }

      // Dedupe por id si ya existe no-terminal.
      const existing = this._candidates.get(candidate.id);
      if (existing && !TERMINAL_STATES.has(existing.state)) {
        return {
          decision: 'duplicate',
          intervention: this._freezeView(existing),
          reason: 'duplicate_id',
        };
      }

      const intervention = this._createInternal(candidate, now);
      this._candidates.set(intervention.id, intervention);
      this._pruneCandidatesIfNeeded(now);
      this._emit({
        type: 'candidate_created',
        at: now,
        intervention: this._freezeView(intervention),
      });

      // Evaluación inicial.
      const result = this._evaluateOne(intervention, contextState, behavioralState, fatigueState, now);
      return result;
    } finally {
      this._evaluating = false;
    }
  }

  /**
   * Reevalúa todos los candidatos no-terminales: avanza pending -> eligible,
   * expira ventanas vencidas, aplica supresión por contexto/fatigue.
   *
   * @returns {{ promoted: object[], expired: object[], suppressed: object[] }}
   */
  evaluatePending(contextState, behavioralState, fatigueState, now) {
    assertNow(now, 'evaluatePending');
    if (this._evaluating) {
      this._warn('Reentrant evaluatePending call detected; returning empty.');
      return { promoted: [], expired: [], suppressed: [] };
    }
    this._evaluating = true;
    try {
      const promoted = [];
      const expired = [];
      const suppressed = [];

      // Iterar sobre snapshot para evitar mutación durante iteración.
      const snapshot = Array.from(this._candidates.values());
      for (const intervention of snapshot) {
        if (TERMINAL_STATES.has(intervention.state)) continue;
        if (intervention.state === STATES.ACTIVE) {
          // Verifica TTL del active (lifecycle lógico, no visual).
          if (now - intervention.activatedAt >= this.config.maxActiveMs) {
            this._transition(intervention, STATES.EXPIRED, now, 'max_active_lifetime');
            expired.push(this._freezeView(intervention));
          }
          continue;
        }

        const r = this._evaluateOne(intervention, contextState, behavioralState, fatigueState, now);
        if (r.decision === 'eligible' && r.intervention?.state === STATES.ELIGIBLE) {
          promoted.push(r.intervention);
        } else if (r.decision === 'suppressed') {
          suppressed.push(r.intervention);
        } else if (r.decision === 'expired') {
          expired.push(r.intervention);
        }
      }

      return { promoted, expired, suppressed };
    } finally {
      this._evaluating = false;
    }
  }

  // -------------------------------------------------------------------------
  // API pública: observación desde el visibility controller
  //
  // Estos métodos NO renderizan ni controlan visibilidad. Solo reciben hechos
  // que ocurrieron en la capa visual y los reflejan en el FSM lógico.
  // -------------------------------------------------------------------------

  /**
   * El visibility controller informa que `interventionId` fue efectivamente activado.
   */
  observeActivation(interventionId, now) {
    assertNow(now, 'observeActivation');
    const intervention = this._requireCandidate(interventionId, 'observeActivation');

    if (intervention.state !== STATES.ELIGIBLE) {
      this._warn(
        `observeActivation on intervention in state ${intervention.state} (expected eligible). Coercing.`,
      );
      // Defensa: si llega activation sobre algo no-eligible, lo marcamos suppressed
      // y registramos la incoherencia. NO promovemos saltándonos el FSM.
      if (!TERMINAL_STATES.has(intervention.state) && intervention.state !== STATES.ACTIVE) {
        this._transition(intervention, STATES.SUPPRESSED, now, 'incoherent_activation');
      }
      return { ok: false, reason: 'incoherent_activation', intervention: this._freezeView(intervention) };
    }

    // Si ya hay otro activo, lo marcamos como replaced LÓGICAMENTE.
    if (this._activeId && this._activeId !== intervention.id) {
      const prev = this._candidates.get(this._activeId);
      if (prev && prev.state === STATES.ACTIVE) {
        prev.replacedBy = intervention.id;
        this._transition(prev, STATES.REPLACED, now, 'replaced_by_observation');
      }
    }

    this._transition(intervention, STATES.ACTIVE, now, 'observed_activation');
    intervention.activatedAt = now;
    this._activeId = intervention.id;
    this._lastEligibleAt = now;
    return { ok: true, intervention: this._freezeView(intervention) };
  }

  /**
   * El visibility controller informa que la intervención activa fue cerrada/oculta.
   */
  observeDismissal(interventionId, reason, now) {
    assertNow(now, 'observeDismissal');
    const intervention = this._requireCandidate(interventionId, 'observeDismissal');
    if (intervention.state !== STATES.ACTIVE) {
      this._warn(
        `observeDismissal on intervention in state ${intervention.state} (expected active). Ignoring.`,
      );
      return { ok: false, reason: 'not_active', intervention: this._freezeView(intervention) };
    }
    const safeReason = typeof reason === 'string' && reason.length > 0 ? reason : 'dismissed';
    this._transition(intervention, STATES.EXPIRED, now, safeReason);
    if (this._activeId === intervention.id) this._activeId = null;
    return { ok: true, intervention: this._freezeView(intervention) };
  }

  /**
   * El visibility controller informa un reemplazo explícito old -> new.
   * Útil cuando el controller decide el swap por su cuenta.
   */
  observeReplacement(oldId, newId, now) {
    assertNow(now, 'observeReplacement');
    const oldIntervention = this._requireCandidate(oldId, 'observeReplacement(old)');
    const newIntervention = this._requireCandidate(newId, 'observeReplacement(new)');

    if (oldIntervention.state === STATES.ACTIVE) {
      oldIntervention.replacedBy = newId;
      this._transition(oldIntervention, STATES.REPLACED, now, 'observed_replacement');
    }
    if (newIntervention.state === STATES.ELIGIBLE) {
      this._transition(newIntervention, STATES.ACTIVE, now, 'observed_replacement');
      newIntervention.activatedAt = now;
      this._activeId = newId;
      this._lastEligibleAt = now;
    } else {
      this._warn(
        `observeReplacement: new intervention ${newId} not eligible (state=${newIntervention.state}).`,
      );
    }
    return {
      ok: true,
      old: this._freezeView(oldIntervention),
      next: this._freezeView(newIntervention),
    };
  }

  // -------------------------------------------------------------------------
  // API pública: notificaciones de contexto / fatigue
  // -------------------------------------------------------------------------

  onContextChange(newContext, now) {
    assertNow(now, 'onContextChange');
    const suppressed = [];
    for (const intervention of this._candidates.values()) {
      if (TERMINAL_STATES.has(intervention.state)) continue;
      // Mensajes sin contexto declarado son context-agnostic.
      if (!intervention.contextType) continue;
      if (intervention.contextType !== newContext) {
        // Solo suprime estados PRE-activos. Para `active`, el controller decide
        // visualmente; nosotros NO forzamos transición visual aquí. Marcamos
        // el active como suppressed lógicamente solo si el controller no nos lo
        // dice (vía observeDismissal). Esto evita doble verdad.
        if (intervention.state !== STATES.ACTIVE) {
          this._transition(intervention, STATES.SUPPRESSED, now, 'context_change');
          suppressed.push(this._freezeView(intervention));
        }
      }
    }
    return { suppressed };
  }

  // -------------------------------------------------------------------------
  // API pública: queries deterministas (NO puras: leen estado interno)
  // -------------------------------------------------------------------------

  getActiveIntervention() {
    if (!this._activeId) return null;
    const a = this._candidates.get(this._activeId);
    return a ? this._freezeView(a) : null;
  }

  getEligibleInterventions() {
    const out = [];
    for (const intervention of this._candidates.values()) {
      if (intervention.state === STATES.ELIGIBLE) out.push(this._freezeView(intervention));
    }
    return out;
  }

  getPendingInterventions() {
    const out = [];
    for (const intervention of this._candidates.values()) {
      if (intervention.state === STATES.PENDING) out.push(this._freezeView(intervention));
    }
    return out;
  }

  getIntervention(id) {
    const i = this._candidates.get(id);
    return i ? this._freezeView(i) : null;
  }

  /**
   * Pregunta si, dado el estado lógico, este id es el candidato preferido para
   * ocupar el slot visual. La decisión final sigue siendo del controller.
   */
  isPreferredCandidate(id, now) {
    assertNow(now, 'isPreferredCandidate');
    const candidate = this._candidates.get(id);
    if (!candidate || candidate.state !== STATES.ELIGIBLE) return false;

    let best = candidate;
    for (const other of this._candidates.values()) {
      if (other.state !== STATES.ELIGIBLE) continue;
      if (other.id === candidate.id) continue;
      if (other.score > best.score) best = other;
    }
    return best.id === candidate.id;
  }

  /**
   * Pregunta lógica de reemplazo. NO ejecuta nada.
   */
  shouldRequestReplacement(candidateId, now) {
    assertNow(now, 'shouldRequestReplacement');
    const candidate = this._candidates.get(candidateId);
    if (!candidate || candidate.state !== STATES.ELIGIBLE) {
      return { shouldReplace: false, reason: 'candidate_not_eligible' };
    }
    if (!this._activeId) {
      return { shouldReplace: true, reason: 'no_active' };
    }
    const active = this._candidates.get(this._activeId);
    if (!active || active.state !== STATES.ACTIVE) {
      return { shouldReplace: true, reason: 'stale_active' };
    }
    if (candidate.id === active.id) {
      return { shouldReplace: false, reason: 'same_id' };
    }
    const delta = candidate.score - active.score;
    if (delta < this.config.replacementScoreDelta) {
      return { shouldReplace: false, reason: 'score_delta_insufficient', delta };
    }
    return { shouldReplace: true, reason: 'score_delta_sufficient', delta };
  }

  // -------------------------------------------------------------------------
  // Snapshots (replay / simulator)
  // -------------------------------------------------------------------------

  createSnapshot(now) {
    assertNow(now, 'createSnapshot');
    const candidates = [];
    for (const intervention of this._candidates.values()) {
      candidates.push(cloneDeep(intervention));
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      takenAt: now,
      sessionId: this._sessionId,
      sessionStartedAt: this._sessionStartedAt,
      version: this._version,
      activeId: this._activeId,
      lastEligibleAt: this._lastEligibleAt,
      familyCooldowns: Array.from(this._familyCooldowns.entries()),
      terminalLedger: cloneDeep(this._terminalLedger),
      candidates,
    };
  }

  restoreSnapshot(snapshot, now) {
    assertNow(now, 'restoreSnapshot');
    if (!snapshot || typeof snapshot !== 'object') {
      throw new InterventionLifecycleError('Snapshot must be an object', 'E_SNAPSHOT_INVALID');
    }
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new InterventionLifecycleError(
        `Snapshot schema version mismatch (got ${snapshot.schemaVersion}, expected ${SNAPSHOT_SCHEMA_VERSION})`,
        'E_SNAPSHOT_SCHEMA',
        { got: snapshot.schemaVersion, expected: SNAPSHOT_SCHEMA_VERSION },
      );
    }
    if (!isFiniteNumber(snapshot.takenAt) || snapshot.takenAt > now) {
      throw new InterventionLifecycleError(
        'Snapshot takenAt invalid or in the future relative to now',
        'E_SNAPSHOT_TEMPORAL',
        { takenAt: snapshot.takenAt, now },
      );
    }

    this._candidates.clear();
    this._terminalLedger.length = 0;
    this._familyCooldowns.clear();

    const cands = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    for (const raw of cands) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
      if (!STATES[String(raw.state || '').toUpperCase()] && !this._isKnownState(raw.state)) {
        continue;
      }
      this._candidates.set(raw.id, cloneDeep(raw));
    }

    this._activeId = typeof snapshot.activeId === 'string' ? snapshot.activeId : null;
    if (this._activeId && !this._candidates.has(this._activeId)) {
      this._activeId = null;
    }
    this._lastEligibleAt = numOr(snapshot.lastEligibleAt, 0);
    if (Array.isArray(snapshot.familyCooldowns)) {
      for (const entry of snapshot.familyCooldowns) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && isFiniteNumber(entry[1])) {
          if (entry[1] > now - this.config.familyCooldownMs * 2) {
            this._familyCooldowns.set(entry[0], entry[1]);
          }
        }
      }
    }
    if (Array.isArray(snapshot.terminalLedger)) {
      this._terminalLedger = cloneDeep(snapshot.terminalLedger).slice(
        -this.config.terminalLedgerMaxEntries,
      );
    }
    this._sessionId = typeof snapshot.sessionId === 'string' ? snapshot.sessionId : null;
    this._sessionStartedAt = numOr(snapshot.sessionStartedAt, 0);
    this._version = numOr(snapshot.version, 0) + 1;

    this._emit({ type: 'snapshot_restored', at: now, data: { takenAt: snapshot.takenAt } });
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  getDiagnostics(now) {
    const counts = {
      created: 0, pending: 0, eligible: 0, active: 0,
      replaced: 0, expired: 0, suppressed: 0, discarded: 0,
    };
    for (const i of this._candidates.values()) {
      if (counts[i.state] !== undefined) counts[i.state] += 1;
    }
    return {
      sessionId: this._sessionId,
      sessionStartedAt: this._sessionStartedAt,
      version: this._version,
      now: isFiniteNumber(now) ? now : null,
      activeId: this._activeId,
      lastEligibleAt: this._lastEligibleAt,
      counts,
      familyCooldowns: Array.from(this._familyCooldowns.entries()),
      terminalLedger: cloneDeep(this._terminalLedger),
    };
  }

  // -------------------------------------------------------------------------
  // Internals: creación, evaluación, scoring
  // -------------------------------------------------------------------------

  _validateCandidate(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return { ok: false, reason: 'candidate_not_object' };
    }
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      return { ok: false, reason: 'candidate_id_missing' };
    }
    if (candidate.family != null && typeof candidate.family !== 'string') {
      return { ok: false, reason: 'candidate_family_invalid' };
    }
    if (candidate.contextType != null && typeof candidate.contextType !== 'string') {
      return { ok: false, reason: 'candidate_context_invalid' };
    }
    return { ok: true };
  }

  _createInternal(candidate, now) {
    const intervention = {
      id: candidate.id,
      family: typeof candidate.family === 'string' ? candidate.family : null,
      contextType: typeof candidate.contextType === 'string' ? candidate.contextType : null,
      messageId: typeof candidate.messageId === 'string' ? candidate.messageId : candidate.id,
      priority: numOr(candidate.priority, 0.5),
      intensity: numOr(candidate.intensity, 0.3),
      contextualRelevance: numOr(candidate.contextualRelevance, 0.5),
      behavioralFit: numOr(candidate.behavioralFit, 0.5),
      payload: candidate.payload != null ? cloneDeep(candidate.payload) : null,

      state: STATES.CREATED,
      score: 0,
      createdAt: now,
      pendingSince: 0,
      eligibleSince: 0,
      activatedAt: 0,
      terminatedAt: 0,
      terminationReason: null,
      replacedBy: null,
      history: [],
    };
    this._appendHistory(intervention, STATES.CREATED, now, 'created');
    intervention.score = this._computeScore(intervention);
    return intervention;
  }

  _computeScore(intervention) {
    const c = this.config;
    const sum =
      c.priorityWeight * clamp01(intervention.priority) +
      c.intensityWeight * clamp01(intervention.intensity) +
      c.contextualRelevanceWeight * clamp01(intervention.contextualRelevance) +
      c.behavioralFitWeight * clamp01(intervention.behavioralFit);
    return Math.max(0, Math.min(1, sum));
  }

  _evaluateOne(intervention, contextState, behavioralState, fatigueState, now) {
    // 1) Score gating.
    if (intervention.score < this.config.minAcceptableScore) {
      this._transition(intervention, STATES.DISCARDED, now, 'score_below_minimum');
      return { decision: 'discarded', intervention: this._freezeView(intervention), reason: 'score_below_minimum' };
    }

    // 2) Fatigue gating.
    const fatigueScore = numOr(fatigueState?.fatigueScore, 0);
    if (fatigueScore > this.config.fatigueThreshold) {
      this._transition(intervention, STATES.SUPPRESSED, now, 'fatigue_above_threshold');
      return { decision: 'suppressed', intervention: this._freezeView(intervention), reason: 'fatigue_above_threshold' };
    }

    // 3) Family cooldown.
    if (intervention.family && this._isFamilyOnCooldown(intervention.family, now)) {
      this._transition(intervention, STATES.SUPPRESSED, now, 'family_cooldown');
      return { decision: 'suppressed', intervention: this._freezeView(intervention), reason: 'family_cooldown' };
    }

    // 4) Context mismatch.
    const activeContext = contextState?.activeContext || contextState?.currentContext || null;
    if (intervention.contextType && activeContext && intervention.contextType !== activeContext) {
      // No descartamos: lo dejamos pending; el contexto puede volver.
      if (intervention.state === STATES.CREATED) {
        this._transition(intervention, STATES.PENDING, now, 'awaiting_context_match');
      }
      // TTL del pending.
      if (intervention.state === STATES.PENDING &&
          now - intervention.pendingSince >= this.config.maxPendingMs) {
        this._transition(intervention, STATES.EXPIRED, now, 'pending_ttl_exhausted');
        return { decision: 'expired', intervention: this._freezeView(intervention), reason: 'pending_ttl_exhausted' };
      }
      return { decision: 'pending', intervention: this._freezeView(intervention), reason: 'awaiting_context_match' };
    }

    // 5) Estabilidad contextual mínima.
    const contextStableFor = numOr(contextState?.stableFor, Infinity);
    if (contextStableFor < this.config.contextStabilityMs) {
      if (intervention.state === STATES.CREATED) {
        this._transition(intervention, STATES.PENDING, now, 'awaiting_context_stability');
      }
      if (intervention.state === STATES.PENDING &&
          now - intervention.pendingSince >= this.config.maxPendingMs) {
        this._transition(intervention, STATES.EXPIRED, now, 'pending_ttl_exhausted');
        return { decision: 'expired', intervention: this._freezeView(intervention), reason: 'pending_ttl_exhausted' };
      }
      return { decision: 'pending', intervention: this._freezeView(intervention), reason: 'awaiting_context_stability' };
    }

    // 6) Intervalo mínimo entre elegibilidades.
    if (this._lastEligibleAt > 0 &&
        now - this._lastEligibleAt < this.config.minEligibilityIntervalMs) {
      if (intervention.state === STATES.CREATED) {
        this._transition(intervention, STATES.PENDING, now, 'awaiting_eligibility_interval');
      }
      if (intervention.state === STATES.PENDING &&
          now - intervention.pendingSince >= this.config.maxPendingMs) {
        this._transition(intervention, STATES.EXPIRED, now, 'pending_ttl_exhausted');
        return { decision: 'expired', intervention: this._freezeView(intervention), reason: 'pending_ttl_exhausted' };
      }
      return { decision: 'pending', intervention: this._freezeView(intervention), reason: 'awaiting_eligibility_interval' };
    }

    // 7) Si ya está eligible y la ventana ha vencido sin activación → expired.
    if (intervention.state === STATES.ELIGIBLE &&
        now - intervention.eligibleSince >= this.config.maxEligibleWindowMs) {
      this._transition(intervention, STATES.EXPIRED, now, 'eligible_window_exhausted');
      return { decision: 'expired', intervention: this._freezeView(intervention), reason: 'eligible_window_exhausted' };
    }

    // 8) Promover a eligible (si no lo está ya).
    if (intervention.state !== STATES.ELIGIBLE) {
      this._transition(intervention, STATES.ELIGIBLE, now, 'all_gates_passed');
      this._lastEligibleAt = now;
    }
    return { decision: 'eligible', intervention: this._freezeView(intervention), reason: 'all_gates_passed' };
  }

  // -------------------------------------------------------------------------
  // Internals: FSM
  // -------------------------------------------------------------------------

  _transition(intervention, toState, now, reason) {
    const from = intervention.state;
    if (from === toState) return;
    const allowed = TRANSITIONS[from];
    if (!allowed || !allowed.has(toState)) {
      throw new InterventionLifecycleError(
        `Invalid FSM transition ${from} -> ${toState} for intervention ${intervention.id}`,
        'E_FSM_INVALID_TRANSITION',
        { id: intervention.id, from, to: toState, reason },
      );
    }
    intervention.state = toState;
    this._appendHistory(intervention, toState, now, reason);

    if (toState === STATES.PENDING && intervention.pendingSince === 0) {
      intervention.pendingSince = now;
    }
    if (toState === STATES.ELIGIBLE) {
      intervention.eligibleSince = now;
    }
    if (TERMINAL_STATES.has(toState)) {
      intervention.terminatedAt = now;
      intervention.terminationReason = reason || null;
      this._onTerminal(intervention, now);
    }

    this._version += 1;
    this._emit({
      type: 'transition',
      at: now,
      intervention: this._freezeView(intervention),
      from,
      to: toState,
      reason: reason || null,
    });
  }

  _onTerminal(intervention, now) {
    // Aplicar cooldown por familia y propagar a familias similares.
    if (intervention.family) {
      const expiresAt = now + this.config.familyCooldownMs;
      const group = this._familyGroupIndex.get(intervention.family);
      if (group) {
        for (const fam of group) this._familyCooldowns.set(fam, expiresAt);
      } else {
        this._familyCooldowns.set(intervention.family, expiresAt);
      }
    }
    // Ring buffer.
    this._terminalLedger.push({
      id: intervention.id,
      family: intervention.family,
      state: intervention.state,
      reason: intervention.terminationReason,
      at: now,
    });
    if (this._terminalLedger.length > this.config.terminalLedgerMaxEntries) {
      this._terminalLedger.splice(0, this._terminalLedger.length - this.config.terminalLedgerMaxEntries);
    }
    if (this._activeId === intervention.id) {
      this._activeId = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals: utilidades varias
  // -------------------------------------------------------------------------

  _isFamilyOnCooldown(family, now) {
    const exp = this._familyCooldowns.get(family);
    if (!isFiniteNumber(exp)) return false;
    if (exp <= now) {
      this._familyCooldowns.delete(family);
      return false;
    }
    return true;
  }

  _buildFamilyGroupIndex(groups) {
    const index = new Map();
    if (!Array.isArray(groups)) return index;
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      const frozen = Object.freeze([...group]);
      for (const fam of group) {
        if (typeof fam === 'string') index.set(fam, frozen);
      }
    }
    return index;
  }

  _appendHistory(intervention, state, now, reason) {
    intervention.history.push({ state, at: now, reason: reason || null });
    const max = this.config.perCandidateHistoryMax;
    if (intervention.history.length > max) {
      intervention.history.splice(0, intervention.history.length - max);
    }
  }

  _pruneCandidatesIfNeeded(now) {
    if (this._candidates.size <= this.config.candidatesMaxEntries) return;
    // Evictar terminales más antiguos primero.
    const terminals = [];
    for (const intervention of this._candidates.values()) {
      if (TERMINAL_STATES.has(intervention.state)) {
        terminals.push(intervention);
      }
    }
    terminals.sort((a, b) => a.terminatedAt - b.terminatedAt);
    while (this._candidates.size > this.config.candidatesMaxEntries && terminals.length > 0) {
      const victim = terminals.shift();
      this._candidates.delete(victim.id);
    }
    // Si aun así excede, evictar el non-terminal más viejo (defensa).
    if (this._candidates.size > this.config.candidatesMaxEntries) {
      let oldest = null;
      for (const intervention of this._candidates.values()) {
        if (TERMINAL_STATES.has(intervention.state)) continue;
        if (intervention.state === STATES.ACTIVE) continue; // nunca evictar al activo
        if (!oldest || intervention.createdAt < oldest.createdAt) oldest = intervention;
      }
      if (oldest) {
        this._transition(oldest, STATES.DISCARDED, now, 'evicted_capacity');
        this._candidates.delete(oldest.id);
      }
    }
  }

  _requireCandidate(id, where) {
    if (typeof id !== 'string') {
      throw new InterventionLifecycleError(`${where}: id must be a string`, 'E_INPUT_MISSING', { id });
    }
    const intervention = this._candidates.get(id);
    if (!intervention) {
      throw new InterventionLifecycleError(
        `${where}: intervention ${id} not found`,
        'E_NOT_FOUND',
        { id },
      );
    }
    return intervention;
  }

  _isKnownState(s) {
    return (
      s === STATES.CREATED || s === STATES.PENDING || s === STATES.ELIGIBLE ||
      s === STATES.ACTIVE || s === STATES.REPLACED || s === STATES.EXPIRED ||
      s === STATES.SUPPRESSED || s === STATES.DISCARDED
    );
  }

  _freezeView(intervention) {
    // Vista inmutable para callers (defensiva). Clonamos para impedir mutaciones.
    return Object.freeze(cloneDeep(intervention));
  }

  _emit(event) {
    try {
      if (this.deps.onEvent) this.deps.onEvent(event);
    } catch (e) {
      this._warn(`onEvent handler threw: ${e && e.message}`);
    }
    if (this.deps.logger && typeof this.deps.logger.debug === 'function') {
      try { this.deps.logger.debug('[intervention-lifecycle]', event); } catch (_e) { /* noop */ }
    }
  }

  _warn(message) {
    if (this.deps.logger && typeof this.deps.logger.warn === 'function') {
      try { this.deps.logger.warn('[intervention-lifecycle]', message); } catch (_e) { /* noop */ }
    }
  }
}

function clamp01(x) {
  if (!isFiniteNumber(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  InterventionLifecycleManager,
  InterventionLifecycleError,
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
};
