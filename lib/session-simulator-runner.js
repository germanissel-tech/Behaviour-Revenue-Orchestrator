/**
 * session-simulator-runner.js
 *
 * Núcleo de validación conductual del sistema OPE.
 *
 * Responsabilidades (y SOLO estas):
 *   - Simular sesiones reales con tiempo discreto y avance entre eventos.
 *   - Inyectar reloj, PRNG seedado y hooks de telemetría en TODOS los módulos.
 *   - Suscribirse al event bus interno y al onEvent de cada componente
 *     para construir un timeline completo y verificable.
 *   - Evaluar invariantes en vivo tras cada tick (no solo métricas al final).
 *   - Validar el contrato del orchestrator antes de ejecutar nada.
 *   - Validar expectedBehavior por escenario.
 *   - Aislar el entorno DOM por instancia (sin mutar globals de Node).
 *   - Garantizar replay-determinism bit-exact entre corridas del mismo seed.
 *
 * NO renderiza. NO toma decisiones de negocio. NO oculta fallos por defecto.
 *
 * Modos:
 *   - mode='logical'    : simula el pipeline backend/orchestrator directamente.
 *                         Rápido, no carga logger-v2 ni JSDOM si no se pide.
 *   - mode='full-stack' : carga JSDOM + logger-v2, mockea fetch, ejercita
 *                         el camino real navegador → backend → controller.
 *
 * Uso:
 *   const runner = new SessionSimulatorRunner({ mode: 'logical', seed: 1 });
 *   runner.registerScenario(scenario);
 *   const result = runner.run('normal_listing', { startTime: 0 });
 *   if (result.passed === false) console.error(result.failures);
 */

'use strict';

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

class SimulatorError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SimulatorError';
    this.code = code;
    this.details = details || null;
  }
}

// ---------------------------------------------------------------------------
// PRNG determinista (mulberry32). Mismo seed => misma secuencia. Sin Math.random.
// ---------------------------------------------------------------------------

function createSeededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return function next() {
    s |= 0;
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// UUID determinista (NO crypto.randomUUID). Sembrado desde PRNG.
// ---------------------------------------------------------------------------

function createSeededUuid(random) {
  return function uuid() {
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 32; i++) {
      const r = Math.floor(random() * 16);
      out += hex[r];
      if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Reloj inyectable. El simulator es la UNICA fuente de tiempo del sistema
// durante la simulación. Todos los módulos deben recibir deps.now = clock.now.
// ---------------------------------------------------------------------------

function createSimulatedClock(startTime) {
  let current = startTime;
  return {
    now() { return current; },
    set(t) {
      if (!Number.isFinite(t)) {
        throw new SimulatorError('E_CLOCK_INVALID', `Clock set to non-finite value: ${t}`);
      }
      if (t < current) {
        throw new SimulatorError('E_CLOCK_BACKWARDS', `Clock cannot go backwards: ${current} -> ${t}`);
      }
      current = t;
    },
    advance(dt) {
      if (!Number.isFinite(dt) || dt < 0) {
        throw new SimulatorError('E_CLOCK_INVALID_DT', `Clock advance with invalid dt: ${dt}`);
      }
      current += dt;
    },
  };
}

// ---------------------------------------------------------------------------
// TimelineLogger
//   - Clone shallow al añadir (evita mutación posterior).
//   - Stringify defensivo con detección de ciclos.
//   - Cap configurable.
// ---------------------------------------------------------------------------

class TimelineLogger {
  constructor(options = {}) {
    this.events = [];
    this.maxEvents = Number.isFinite(options.maxEvents) ? options.maxEvents : 5000;
    this.dropped = 0;
  }

  add(timestamp, eventType, details, source = 'system') {
    if (this.events.length >= this.maxEvents) {
      this.dropped++;
      return;
    }
    const safeDetails = this._safeClone(details);
    this.events.push({
      t: timestamp,
      type: eventType,
      source,
      details: safeDetails,
    });
  }

  _safeClone(value) {
    if (value == null) return value;
    if (typeof value !== 'object') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return { _unserializable: true, _type: typeof value };
    }
  }

  filter(typePredicate) {
    return this.events.filter(e => typePredicate(e.type));
  }

  getLog() {
    const lines = this.events.map(e => {
      let payload;
      try { payload = JSON.stringify(e.details); }
      catch (_e) { payload = '"[unserializable]"'; }
      return `[t=${e.t}] (${e.source}) ${e.type} ${payload}`;
    });
    if (this.dropped > 0) {
      lines.push(`[truncated] ${this.dropped} events dropped (maxEvents=${this.maxEvents})`);
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// SimulationScenario
//
// expectedBehavior soporta:
//   - mustShowFamilies: string[]   (al menos una intervención de esa familia debe activarse)
//   - mustNotShowFamilies: string[]
//   - minInterventions: number
//   - maxInterventions: number
//   - minVisibleMs: number         (cada mensaje activado debe respetar este mínimo)
//   - maxFlickering: number        (re-renders del MISMO messageId tras gap < minVisibleMs)
//   - replayStable: boolean        (corrida bit-exact entre runs con mismo seed)
//   - customAssertions: Array<(ctx) => { pass, message }>
// ---------------------------------------------------------------------------

class SimulationScenario {
  constructor({
    name,
    initialContext = 'listing',
    actions = [],
    expectedBehavior = {},
    postRunDurationMs = 5000,
    tickResolutionMs = 100,
  } = {}) {
    if (!name) throw new SimulatorError('E_SCENARIO_NO_NAME', 'Scenario requires a name');
    if (!Array.isArray(actions)) throw new SimulatorError('E_SCENARIO_ACTIONS', 'Scenario actions must be an array');
    this.name = name;
    this.initialContext = initialContext;
    this.actions = actions;
    this.expectedBehavior = expectedBehavior || {};
    this.postRunDurationMs = postRunDurationMs;
    this.tickResolutionMs = tickResolutionMs;
  }
}

// ---------------------------------------------------------------------------
// Contrato esperado del orchestrator. Si no se cumple, fallamos rápido.
// ---------------------------------------------------------------------------

const REQUIRED_ORCHESTRATOR_METHODS = [
  'initialize',
  'processEvent',
  'evaluate',
  'snapshot',
  'getDiagnostics',
];

function assertOrchestratorContract(orchestrator) {
  if (!orchestrator || typeof orchestrator !== 'object') {
    throw new SimulatorError('E_ORCH_INVALID', 'Orchestrator must be an object');
  }
  const missing = REQUIRED_ORCHESTRATOR_METHODS.filter(m => typeof orchestrator[m] !== 'function');
  if (missing.length) {
    throw new SimulatorError(
      'E_ORCH_CONTRACT',
      `Orchestrator missing required methods: ${missing.join(', ')}`,
      { missing }
    );
  }
}

// ---------------------------------------------------------------------------
// Configuración por defecto del runner
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  mode: 'logical',                 // 'logical' | 'full-stack'
  seed: 1,
  defaultSpeedFactor: 1,
  defaultTickResolutionMs: 100,
  maxScenarioWallMs: 60_000,       // safety cap para escenarios runaway
  maxEventsPerTimeline: 5000,
  anomalyThresholds: Object.freeze({
    maxFlickeringPerMinute: 3,
    maxContextSwitchesPerMinute: 5,
    maxSuppressedInterventions: 10,
    maxStaleMessages: 2,
    minVisibleMsRespected: 1500,   // umbral por debajo del cual un remove se considera flicker
  }),
  loggerV2BridgeEnabled: true,     // si modules expose hooks deps, los conectamos
});

// ---------------------------------------------------------------------------
// Invariantes verificadas en cada tick. Cada invariante recibe (ctx) y
// devuelve null si pasa, o { code, message, details } si falla.
// ---------------------------------------------------------------------------

const INVARIANTS = [
  function atMostOneActiveMessage(ctx) {
    const snap = ctx.snapshot || {};
    const active = snap.activeMessages || snap.activeMessage;
    if (Array.isArray(active) && active.length > 1) {
      return {
        code: 'INV_MULTIPLE_ACTIVE_MESSAGES',
        message: `Más de un mensaje activo simultáneamente (${active.length})`,
        details: { count: active.length },
      };
    }
    return null;
  },
  function noActiveExpired(ctx) {
    const snap = ctx.snapshot || {};
    const active = snap.activeMessage || (Array.isArray(snap.activeMessages) ? snap.activeMessages[0] : null);
    if (active && active.visibilityState === 'expired') {
      return {
        code: 'INV_ACTIVE_BUT_EXPIRED',
        message: `Mensaje marcado expired pero permanece como activo: ${active.id || active.messageId}`,
        details: { id: active.id || active.messageId },
      };
    }
    return null;
  },
  function contextCoherent(ctx) {
    const snap = ctx.snapshot || {};
    if (!snap.activeContext || !snap.lifecycleObservedContext) return null;
    if (snap.activeContext !== snap.lifecycleObservedContext) {
      return {
        code: 'INV_CONTEXT_DESYNC',
        message: `Contexto activo (${snap.activeContext}) no coincide con el observado por lifecycle (${snap.lifecycleObservedContext})`,
      };
    }
    return null;
  },
  function clockMonotonic(ctx) {
    if (ctx.previousNow != null && ctx.now < ctx.previousNow) {
      return {
        code: 'INV_CLOCK_BACKWARDS',
        message: `Reloj retrocedió: ${ctx.previousNow} -> ${ctx.now}`,
      };
    }
    return null;
  },
];

// ---------------------------------------------------------------------------
// Resolver módulos: lazy require con error útil. Lo intentamos desde paths
// relativos comunes y dejamos al usuario sobreescribir vía options.moduleResolver.
// ---------------------------------------------------------------------------

function defaultModuleResolver(name) {
  try {
    return require(`./${name}`);
  } catch (err) {
    throw new SimulatorError(
      'E_MODULE_NOT_FOUND',
      `No se pudo cargar módulo "${name}" desde ./${name}: ${err.message}. ` +
      `Provea options.moduleResolver para resolver desde otra ubicación.`,
      { name, cause: err.message }
    );
  }
}

// ---------------------------------------------------------------------------
// Cargar JSDOM solo si hace falta (modo full-stack).
// ---------------------------------------------------------------------------

function loadJsdomOrThrow() {
  try {
    const jsdom = require('jsdom');
    return jsdom.JSDOM;
  } catch (err) {
    throw new SimulatorError(
      'E_JSDOM_NOT_INSTALLED',
      'JSDOM no está instalado. Instale con `npm install --save-dev jsdom` ' +
      'o use mode: "logical" para evitar la dependencia.',
      { cause: err.message }
    );
  }
}

// ---------------------------------------------------------------------------
// Runner principal
// ---------------------------------------------------------------------------

class SessionSimulatorRunner {
  constructor(config = {}) {
    this.config = Object.assign({}, DEFAULT_CONFIG, config);
    if (!['logical', 'full-stack'].includes(this.config.mode)) {
      throw new SimulatorError('E_MODE_INVALID', `Mode inválido: ${this.config.mode}`);
    }
    this.scenarios = new Map();
    this.moduleResolver = config.moduleResolver || defaultModuleResolver;
  }

  registerScenario(scenario) {
    if (!(scenario instanceof SimulationScenario)) {
      throw new SimulatorError('E_SCENARIO_INVALID', 'registerScenario requiere una instancia de SimulationScenario');
    }
    this.scenarios.set(scenario.name, scenario);
  }

  // -------------------------------------------------------------------------
  // run(scenarioName, options)
  //   options.startTime
  //   options.speedFactor
  //   options.seed (override del seed por escenario)
  //   options.injectModules (para tests: pasa mocks ya instanciados)
  // -------------------------------------------------------------------------

  run(scenarioName, options = {}) {
    const scenario = this.scenarios.get(scenarioName);
    if (!scenario) {
      throw new SimulatorError('E_SCENARIO_NOT_FOUND', `Scenario no registrado: ${scenarioName}`);
    }

    const startTime = Number.isFinite(options.startTime) ? options.startTime : 0;
    const speedFactor = options.speedFactor || this.config.defaultSpeedFactor;
    const seed = Number.isFinite(options.seed) ? options.seed : this.config.seed;

    const clock = createSimulatedClock(startTime);
    const random = createSeededRandom(seed);
    const uuid = createSeededUuid(random);

    const sessionId = `sim_${scenario.name}_seed${seed}_start${startTime}`;
    const storeId = options.storeId || 'sim_store';

    const timeline = new TimelineLogger({ maxEvents: this.config.maxEventsPerTimeline });
    const metrics = this._emptyMetrics();
    const invariantFailures = [];
    const errors = [];

    let domHandle = null;
    let orchestrator = null;
    let result;

    try {
      if (this.config.mode === 'full-stack') {
        domHandle = this._setupDom();
      }

      const modules = options.injectModules || this._loadModules();
      orchestrator = this._buildOrchestrator(modules, {
        clock, random, uuid, timeline, metrics, sessionId,
      });

      assertOrchestratorContract(orchestrator);

      this._subscribeToEventBus(modules.eventBus, timeline, metrics, clock);

      orchestrator.initialize(sessionId, storeId, clock.now());
      timeline.add(clock.now(), 'SESSION_INITIALIZED', { sessionId, storeId }, 'runner');

      // Aplicar contexto inicial declarado por el escenario.
      this._applyInitialContext(orchestrator, scenario, clock);

      // Ejecutar acciones con tick discreto entre ellas.
      this._runActionsWithTicks(scenario, orchestrator, clock, speedFactor, timeline, metrics, invariantFailures, errors);

      // Período post-run: avanzar tiempo para observar decay/cooldowns/expiraciones.
      this._runPostScenarioTicks(scenario, orchestrator, clock, speedFactor, timeline, metrics, invariantFailures, errors);

      // Snapshot final + métricas + anomalías.
      const snapshot = this._safeSnapshot(orchestrator);
      const diagnostics = this._safeDiagnostics(orchestrator, clock.now());
      this._mergeDiagnosticsIntoMetrics(diagnostics, metrics);
      const anomalies = this._detectAnomalies(timeline, metrics, scenario, this.config.anomalyThresholds);

      // Validar expectedBehavior.
      const expectationResults = this._evaluateExpectations(scenario, timeline, metrics, snapshot);

      // Replay-stability (si se pidió).
      let replayDiff = null;
      if (scenario.expectedBehavior && scenario.expectedBehavior.replayStable) {
        replayDiff = this._checkReplayStability(scenarioName, options, snapshot);
      }

      const failures = []
        .concat(invariantFailures)
        .concat(expectationResults.filter(r => !r.pass))
        .concat(errors.map(e => ({ code: 'RUNTIME_ERROR', message: e.message, details: e.details })))
        .concat(replayDiff && !replayDiff.stable ? [{ code: 'REPLAY_UNSTABLE', message: 'La corrida no es bit-exact reproducible', details: replayDiff.diff }] : []);

      result = {
        sessionId,
        scenario: scenario.name,
        seed,
        passed: failures.length === 0 && anomalies.length === 0,
        metrics,
        anomalies,
        invariantFailures,
        expectations: expectationResults,
        errors: errors.map(e => ({ message: e.message, details: e.details })),
        replayDiff,
        failures,
        timeline: timeline.getLog(),
        timelineEvents: timeline.events.slice(),
        orchestratorSnapshot: snapshot,
        diagnostics,
      };
    } catch (err) {
      // Error catastrófico no recuperable. Devolvemos resultado fallido coherente.
      result = {
        sessionId,
        scenario: scenario.name,
        seed,
        passed: false,
        metrics,
        anomalies: [],
        invariantFailures,
        expectations: [],
        errors: [{ message: err.message, code: err.code || 'E_FATAL', details: err.details || null }],
        replayDiff: null,
        failures: [{ code: 'E_FATAL', message: err.message }],
        timeline: timeline.getLog(),
        timelineEvents: timeline.events.slice(),
        orchestratorSnapshot: null,
        diagnostics: null,
      };
    } finally {
      // Cleanup garantizado pase lo que pase.
      try { if (domHandle) this._teardownDom(domHandle); }
      catch (e) { /* ignore cleanup error */ }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Carga de módulos
  // -------------------------------------------------------------------------

  _loadModules() {
    const resolve = (name) => this.moduleResolver(name);
    const { BehavioralStateStore } = resolve('behavioral-state-store');
    const { InteractionTransitionLayer } = resolve('interaction-transition-layer');
    const { ContextPresenceEngine } = resolve('context-presence-engine');
    const { MessageVisibilityController } = resolve('message-visibility-controller');
    const { InterventionPolicyEngine } = resolve('intervention-policy-engine');
    const { MessageRankingEngine } = resolve('message-ranking-engine');
    const { CooldownFatigueEngine } = resolve('cooldown-fatigue-engine');
    const { InternalBehavioralEventBus } = resolve('internal-behavioral-event-bus');
    const { SessionOrchestrator } = resolve('session-orchestrator');
    const eventBus = new InternalBehavioralEventBus();
    return {
      BehavioralStateStore, InteractionTransitionLayer, ContextPresenceEngine,
      MessageVisibilityController, InterventionPolicyEngine, MessageRankingEngine,
      CooldownFatigueEngine, SessionOrchestrator,
      eventBus,
    };
  }

  // -------------------------------------------------------------------------
  // Construcción del orchestrator con dependencias inyectadas a TODOS los módulos
  // -------------------------------------------------------------------------

  _buildOrchestrator(modules, ctx) {
    const { clock, random, uuid, timeline, metrics, sessionId } = ctx;

    // deps comunes inyectadas a cada componente que las acepte (vía duck-typing).
    const makeDeps = (componentName) => ({
      now: () => clock.now(),
      random,
      uuid,
      logger: this._makeLogger(componentName, timeline),
      onEvent: (eventName, payload) => this._handleComponentEvent(componentName, eventName, payload, clock, timeline, metrics),
    });

    const safeNew = (Ctor, name, args) => {
      try {
        return new Ctor(...(args || []));
      } catch (err) {
        throw new SimulatorError('E_MODULE_CTOR', `No se pudo instanciar ${name}: ${err.message}`, { cause: err.message });
      }
    };

    // Pasamos deps como segundo argumento opcional. Los módulos corregidos los aceptan;
    // los que no, los ignoran sin romper.
    const stateStore = safeNew(modules.BehavioralStateStore, 'BehavioralStateStore', [{ deps: makeDeps('state-store') }]);
    const transitionLayer = safeNew(modules.InteractionTransitionLayer, 'InteractionTransitionLayer', [{ deps: makeDeps('transition-layer') }]);
    const presenceEngine = safeNew(modules.ContextPresenceEngine, 'ContextPresenceEngine', [{ deps: makeDeps('presence-engine') }]);
    const visibilityController = safeNew(modules.MessageVisibilityController, 'MessageVisibilityController', [{ deps: makeDeps('visibility-controller') }]);
    const policyEngine = safeNew(modules.InterventionPolicyEngine, 'InterventionPolicyEngine', [{ deps: makeDeps('policy-engine') }]);
    const rankingEngine = safeNew(modules.MessageRankingEngine, 'MessageRankingEngine', [{ deps: makeDeps('ranking-engine') }]);
    const fatigueEngine = safeNew(modules.CooldownFatigueEngine, 'CooldownFatigueEngine', [{ deps: makeDeps('fatigue-engine') }]);

    const orchestrator = safeNew(modules.SessionOrchestrator, 'SessionOrchestrator', [{
      stateStore,
      transitionLayer,
      presenceEngine,
      visibilityController,
      policyEngine,
      rankingEngine,
      fatigueEngine,
      eventBus: modules.eventBus,
      deps: makeDeps('orchestrator'),
    }]);

    return orchestrator;
  }

  _makeLogger(componentName, timeline) {
    return {
      debug: (msg, data) => timeline.add(this._timelineNow(timeline), `LOG_DEBUG:${componentName}`, { msg, data }, componentName),
      info: (msg, data) => timeline.add(this._timelineNow(timeline), `LOG_INFO:${componentName}`, { msg, data }, componentName),
      warn: (msg, data) => timeline.add(this._timelineNow(timeline), `LOG_WARN:${componentName}`, { msg, data }, componentName),
      error: (msg, data) => timeline.add(this._timelineNow(timeline), `LOG_ERROR:${componentName}`, { msg, data }, componentName),
    };
  }

  // Helper: el clock no está disponible aquí directamente, así que el timeline
  // recibe el último timestamp conocido. Para precisión, los handlers reales
  // reciben el clock.now() en _handleComponentEvent.
  _timelineNow(timeline) {
    const last = timeline.events[timeline.events.length - 1];
    return last ? last.t : 0;
  }

  _handleComponentEvent(componentName, eventName, payload, clock, timeline, metrics) {
    const now = clock.now();
    timeline.add(now, `COMP:${componentName}:${eventName}`, payload, componentName);

    // Contabilidad de métricas robustas (no depende solo del eventBus).
    if (eventName === 'activate' || eventName === 'show' || eventName === 'INTERVENTION_RENDERED') {
      metrics.interventions++;
      metrics.renders++;
      const msgId = (payload && (payload.messageId || payload.id)) || null;
      metrics._renderedTimeline.push({ t: now, messageId: msgId, family: payload && payload.family });
    } else if (eventName === 'clear' || eventName === 'remove' || eventName === 'expired') {
      metrics.clearings++;
      metrics._removedTimeline.push({ t: now, messageId: (payload && (payload.messageId || payload.id)) || null });
    } else if (eventName === 'suppressed' || eventName === 'rejected' || eventName === 'INTERVENTION_BLOCKED') {
      metrics.suppressed++;
    } else if (eventName === 'CONTEXT_CHANGED' || eventName === 'context_observed') {
      metrics.contextSwitches++;
    }
  }

  // -------------------------------------------------------------------------
  // Suscripción al event bus interno (segunda fuente, complementaria)
  // -------------------------------------------------------------------------

  _subscribeToEventBus(eventBus, timeline, metrics, clock) {
    if (!eventBus || typeof eventBus.on !== 'function') {
      // No es fatal: algunos sistemas usan solo onEvent. Lo registramos.
      timeline.add(clock.now(), 'WARNING', { msg: 'eventBus.on no disponible; usando solo deps.onEvent' }, 'runner');
      return;
    }

    const safeT = (meta) => (meta && Number.isFinite(meta.timestamp)) ? meta.timestamp : clock.now();

    eventBus.on('INTERVENTION_TRIGGERED', (payload, meta) => {
      const t = safeT(meta);
      const family = (payload && payload.candidate && payload.candidate.family) || (payload && payload.family) || null;
      const messageId = (payload && payload.candidate && payload.candidate.messageId) || (payload && payload.messageId) || null;
      timeline.add(t, 'INTERVENTION_RENDERED', { family, messageId }, 'event-bus');
      metrics.interventions++;
      metrics._renderedTimeline.push({ t, messageId, family });
    });

    eventBus.on('INTERVENTION_REPLACED', (payload, meta) => {
      timeline.add(safeT(meta), 'INTERVENTION_REPLACED', payload, 'event-bus');
      metrics.replacements++;
    });

    eventBus.on('INTERVENTION_EXPIRED', (payload, meta) => {
      const t = safeT(meta);
      timeline.add(t, 'INTERVENTION_EXPIRED', payload, 'event-bus');
      metrics.clearings++;
      metrics._removedTimeline.push({ t, messageId: (payload && payload.messageId) || null });
    });

    eventBus.on('INTERVENTION_CLEARED', (payload, meta) => {
      const t = safeT(meta);
      timeline.add(t, 'INTERVENTION_CLEARED', payload, 'event-bus');
      metrics.clearings++;
      metrics._removedTimeline.push({ t, messageId: (payload && payload.messageId) || null });
    });

    eventBus.on('INTERVENTION_BLOCKED', (payload, meta) => {
      timeline.add(safeT(meta), 'INTERVENTION_BLOCKED', payload, 'event-bus');
      metrics.suppressed++;
    });

    eventBus.on('CONTEXT_CHANGED', (payload, meta) => {
      timeline.add(safeT(meta), 'CONTEXT_CHANGED', payload, 'event-bus');
      metrics.contextSwitches++;
    });
  }

  // -------------------------------------------------------------------------
  // Aplicar contexto inicial
  // -------------------------------------------------------------------------

  _applyInitialContext(orchestrator, scenario, clock) {
    if (!scenario.initialContext) return;
    try {
      orchestrator.processEvent(
        { type: 'CONTEXT_CHANGED', payload: { context: scenario.initialContext }, ts: clock.now() },
        clock.now()
      );
      orchestrator.evaluate(clock.now());
    } catch (err) {
      throw new SimulatorError('E_INITIAL_CONTEXT', `Falló aplicar initialContext: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Loop principal: ejecutar acciones con tick discreto entre ellas
  // -------------------------------------------------------------------------

  _runActionsWithTicks(scenario, orchestrator, clock, speedFactor, timeline, metrics, invariantFailures, errors) {
    const tickRes = Math.max(1, scenario.tickResolutionMs || this.config.defaultTickResolutionMs);
    const wallStart = Date.now();
    let previousNow = clock.now();

    for (let i = 0; i < scenario.actions.length; i++) {
      const action = scenario.actions[i];
      const delay = Math.max(0, (action.delayMs || 0)) / Math.max(0.0001, speedFactor);

      // Avance discreto desde el now actual hasta el tiempo de la acción.
      const targetTime = clock.now() + delay;
      while (clock.now() + tickRes <= targetTime) {
        clock.advance(tickRes);
        this._tickOrchestrator(orchestrator, clock, timeline, metrics, invariantFailures, errors, previousNow);
        previousNow = clock.now();
        this._enforceWallClockCap(wallStart);
      }
      // Ajuste fino al timestamp exacto.
      if (clock.now() < targetTime) {
        clock.set(Math.round(targetTime));
      }

      // Ejecutar la acción.
      this._executeAction(action, clock.now(), orchestrator, timeline, errors);

      // Evaluar invariantes inmediatamente tras la acción.
      this._checkInvariants(orchestrator, clock.now(), previousNow, invariantFailures);
      previousNow = clock.now();
      this._enforceWallClockCap(wallStart);
    }
  }

  _runPostScenarioTicks(scenario, orchestrator, clock, speedFactor, timeline, metrics, invariantFailures, errors) {
    const tickRes = Math.max(1, scenario.tickResolutionMs || this.config.defaultTickResolutionMs);
    const duration = Math.max(0, scenario.postRunDurationMs || 0) / Math.max(0.0001, speedFactor);
    const target = clock.now() + duration;
    let previousNow = clock.now();
    const wallStart = Date.now();
    while (clock.now() + tickRes <= target) {
      clock.advance(tickRes);
      this._tickOrchestrator(orchestrator, clock, timeline, metrics, invariantFailures, errors, previousNow);
      previousNow = clock.now();
      this._enforceWallClockCap(wallStart);
    }
    if (clock.now() < target) {
      clock.set(Math.round(target));
      this._tickOrchestrator(orchestrator, clock, timeline, metrics, invariantFailures, errors, previousNow);
    }
  }

  _tickOrchestrator(orchestrator, clock, timeline, metrics, invariantFailures, errors, previousNow) {
    try {
      // Si el orchestrator expone tick(now), lo usamos; si no, evaluate(now) hace el trabajo.
      if (typeof orchestrator.tick === 'function') {
        orchestrator.tick(clock.now());
      } else {
        orchestrator.evaluate(clock.now());
      }
    } catch (err) {
      const wrapped = new SimulatorError('E_TICK', `Excepción en tick @t=${clock.now()}: ${err.message}`, { cause: err.message });
      errors.push(wrapped);
      timeline.add(clock.now(), 'ERROR', { phase: 'tick', message: err.message }, 'runner');
    }
    this._checkInvariants(orchestrator, clock.now(), previousNow, invariantFailures);
  }

  _enforceWallClockCap(wallStart) {
    const elapsed = Date.now() - wallStart;
    if (elapsed > this.config.maxScenarioWallMs) {
      throw new SimulatorError(
        'E_WALL_CLOCK_CAP',
        `Escenario excedió el cap de wall-clock (${this.config.maxScenarioWallMs}ms). Posible loop o tick demasiado fino.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Ejecutar una acción individual (con try/catch defensivo)
  // -------------------------------------------------------------------------

  _executeAction(action, now, orchestrator, timeline, errors) {
    timeline.add(now, 'ACTION', action, 'scenario');
    const dispatch = (type, payload) => orchestrator.processEvent({ type, payload: payload || {}, ts: now }, now);

    try {
      switch (action.type) {
        case 'scroll':
          dispatch('SCROLL', { depth: action.payload && action.payload.depth });
          break;
        case 'product_focus':
          dispatch('PRODUCT_CHANGED', { productId: action.payload && action.payload.productId });
          break;
        case 'modal_open':
          dispatch('MODAL_OPENED', { productId: action.payload && action.payload.productId });
          break;
        case 'modal_close':
          dispatch('MODAL_CLOSED', {});
          break;
        case 'hover_start':
          dispatch('HOVER_START', {
            elementId: action.payload && action.payload.elementId,
            productId: action.payload && action.payload.productId,
          });
          break;
        case 'hover_end':
          dispatch('HOVER_END', {});
          break;
        case 'add_to_cart':
          dispatch('USER_ACTION', { type: 'add_to_cart', productId: action.payload && action.payload.productId });
          break;
        case 'context_change':
          dispatch('CONTEXT_CHANGED', { context: action.payload && action.payload.context });
          break;
        case 'idle':
          // No emite evento. Sirve para forzar avance de tiempo sin actividad.
          break;
        case 'raw_event':
          // Escape hatch: el escenario puede emitir cualquier evento crudo.
          if (action.payload && action.payload.type) {
            dispatch(action.payload.type, action.payload.payload);
          }
          break;
        default:
          timeline.add(now, 'WARNING', { msg: `Acción desconocida: ${action.type}` }, 'runner');
      }
      // Evaluación inmediata post-acción.
      orchestrator.evaluate(now);
    } catch (err) {
      const wrapped = new SimulatorError(
        'E_ACTION',
        `Excepción ejecutando acción ${action.type} @t=${now}: ${err.message}`,
        { action, cause: err.message }
      );
      errors.push(wrapped);
      timeline.add(now, 'ERROR', { phase: 'action', action: action.type, message: err.message }, 'runner');
    }
  }

  // -------------------------------------------------------------------------
  // Invariantes
  // -------------------------------------------------------------------------

  _checkInvariants(orchestrator, now, previousNow, invariantFailures) {
    const snapshot = this._safeSnapshot(orchestrator);
    const ctx = { now, previousNow, snapshot };
    for (const inv of INVARIANTS) {
      let result;
      try { result = inv(ctx); }
      catch (e) { result = { code: 'INV_THREW', message: `Invariante lanzó: ${e.message}` }; }
      if (result) {
        invariantFailures.push(Object.assign({ at: now }, result));
      }
    }
  }

  _safeSnapshot(orchestrator) {
    try { return orchestrator.snapshot(); }
    catch (_e) { return null; }
  }

  _safeDiagnostics(orchestrator, now) {
    try { return orchestrator.getDiagnostics(now); }
    catch (_e) { return null; }
  }

  _mergeDiagnosticsIntoMetrics(diagnostics, metrics) {
    if (!diagnostics || typeof diagnostics !== 'object') return;
    // Solo sobrescribimos si diagnostics aporta valor; en otro caso conservamos
    // las métricas calculadas por el runner desde el bus + deps.onEvent.
    const fields = [
      ['interventionsCount', 'interventions'],
      ['rendersCount', 'renders'],
      ['clearingCount', 'clearings'],
      ['suppressedCount', 'suppressed'],
      ['contextSwitches', 'contextSwitches'],
      ['staleMessages', 'staleMessages'],
    ];
    for (const [src, dst] of fields) {
      if (typeof diagnostics[src] === 'number' && diagnostics[src] > metrics[dst]) {
        metrics[dst] = diagnostics[src];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Detección de anomalías (basada en datos reales, no en placeholders)
  // -------------------------------------------------------------------------

  _detectAnomalies(timeline, metrics, scenario, thresholds) {
    const anomalies = [];
    const totalMinutes = this._spanMinutes(timeline);

    // Flickering real: re-render del MISMO messageId con gap < umbral, o
    // remove seguido de re-render del mismo messageId con gap insuficiente.
    const rendered = metrics._renderedTimeline || [];
    const removed = metrics._removedTimeline || [];
    const minVisible = thresholds.minVisibleMsRespected;

    // 1) Re-render directo del mismo messageId.
    const lastByMsg = new Map();
    for (const r of rendered) {
      if (!r.messageId) continue;
      const prev = lastByMsg.get(r.messageId);
      if (prev != null && (r.t - prev) < minVisible) {
        anomalies.push({
          code: 'FLICKER_SAME_MESSAGE',
          message: `Flicker: messageId=${r.messageId} re-renderizado tras ${r.t - prev}ms (< ${minVisible}ms)`,
          at: r.t,
        });
        metrics.flickering++;
      }
      lastByMsg.set(r.messageId, r.t);
    }

    // 2) Mensaje removido y reaparecido rápidamente.
    for (const r of rendered) {
      if (!r.messageId) continue;
      const matchingRemoval = removed.find(x => x.messageId === r.messageId && x.t < r.t && (r.t - x.t) < minVisible);
      if (matchingRemoval) {
        anomalies.push({
          code: 'FLICKER_REINSERT',
          message: `Flicker: messageId=${r.messageId} re-insertado ${r.t - matchingRemoval.t}ms tras remove`,
          at: r.t,
        });
        metrics.flickering++;
      }
    }

    // 3) Tasa por minuto.
    if (totalMinutes > 0) {
      const ratePerMin = metrics.flickering / totalMinutes;
      if (ratePerMin > thresholds.maxFlickeringPerMinute) {
        anomalies.push({
          code: 'FLICKER_RATE',
          message: `Tasa de flickering ${ratePerMin.toFixed(2)}/min > umbral ${thresholds.maxFlickeringPerMinute}`,
        });
      }
      const ctxRate = metrics.contextSwitches / totalMinutes;
      if (ctxRate > thresholds.maxContextSwitchesPerMinute) {
        anomalies.push({
          code: 'CONTEXT_SWITCH_RATE',
          message: `Tasa de context switches ${ctxRate.toFixed(2)}/min > umbral ${thresholds.maxContextSwitchesPerMinute}`,
        });
      }
    }

    if (metrics.suppressed > thresholds.maxSuppressedInterventions) {
      anomalies.push({
        code: 'SUPPRESSIONS_HIGH',
        message: `Demasiadas supresiones: ${metrics.suppressed} > ${thresholds.maxSuppressedInterventions}`,
      });
    }

    if (metrics.staleMessages > thresholds.maxStaleMessages) {
      anomalies.push({
        code: 'STALE_MESSAGES',
        message: `Mensajes obsoletos detectados: ${metrics.staleMessages}`,
      });
    }

    return anomalies;
  }

  _spanMinutes(timeline) {
    const evs = timeline.events;
    if (evs.length < 2) return 0;
    const first = evs[0].t;
    const last = evs[evs.length - 1].t;
    return Math.max(0, (last - first) / 60000);
  }

  // -------------------------------------------------------------------------
  // Evaluación de expectedBehavior declarado por el escenario
  // -------------------------------------------------------------------------

  _evaluateExpectations(scenario, timeline, metrics, snapshot) {
    const exp = scenario.expectedBehavior || {};
    const results = [];
    const renderedFamilies = new Set((metrics._renderedTimeline || []).map(r => r.family).filter(Boolean));

    if (Array.isArray(exp.mustShowFamilies)) {
      for (const fam of exp.mustShowFamilies) {
        results.push({
          name: `mustShowFamily:${fam}`,
          pass: renderedFamilies.has(fam),
          message: renderedFamilies.has(fam) ? 'ok' : `Familia ${fam} debía mostrarse y no se mostró`,
        });
      }
    }

    if (Array.isArray(exp.mustNotShowFamilies)) {
      for (const fam of exp.mustNotShowFamilies) {
        results.push({
          name: `mustNotShowFamily:${fam}`,
          pass: !renderedFamilies.has(fam),
          message: !renderedFamilies.has(fam) ? 'ok' : `Familia ${fam} NO debía mostrarse y se mostró`,
        });
      }
    }

    if (Number.isFinite(exp.minInterventions)) {
      results.push({
        name: 'minInterventions',
        pass: metrics.interventions >= exp.minInterventions,
        message: `interventions=${metrics.interventions} esperado ≥ ${exp.minInterventions}`,
      });
    }

    if (Number.isFinite(exp.maxInterventions)) {
      results.push({
        name: 'maxInterventions',
        pass: metrics.interventions <= exp.maxInterventions,
        message: `interventions=${metrics.interventions} esperado ≤ ${exp.maxInterventions}`,
      });
    }

    if (Number.isFinite(exp.minVisibleMs)) {
      // Cada mensaje debe haber estado visible al menos minVisibleMs antes de removerse.
      const rendered = metrics._renderedTimeline || [];
      const removed = metrics._removedTimeline || [];
      const violations = [];
      for (const r of rendered) {
        if (!r.messageId) continue;
        const rem = removed.find(x => x.messageId === r.messageId && x.t > r.t);
        if (rem && (rem.t - r.t) < exp.minVisibleMs) {
          violations.push({ messageId: r.messageId, visibleMs: rem.t - r.t });
        }
      }
      results.push({
        name: 'minVisibleMs',
        pass: violations.length === 0,
        message: violations.length === 0 ? 'ok' : `${violations.length} mensaje(s) por debajo del mínimo`,
        details: violations,
      });
    }

    if (Number.isFinite(exp.maxFlickering)) {
      results.push({
        name: 'maxFlickering',
        pass: metrics.flickering <= exp.maxFlickering,
        message: `flickering=${metrics.flickering} esperado ≤ ${exp.maxFlickering}`,
      });
    }

    if (Array.isArray(exp.customAssertions)) {
      for (let i = 0; i < exp.customAssertions.length; i++) {
        const fn = exp.customAssertions[i];
        try {
          const r = fn({ metrics, timeline: timeline.events, snapshot });
          results.push({
            name: `custom[${i}]`,
            pass: !!(r && r.pass),
            message: (r && r.message) || (r && r.pass ? 'ok' : 'fail'),
          });
        } catch (err) {
          results.push({
            name: `custom[${i}]`,
            pass: false,
            message: `custom assertion lanzó: ${err.message}`,
          });
        }
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Replay-stability: corre el mismo escenario dos veces con el mismo seed
  // y compara snapshots. Útil para detectar no-determinismo residual.
  // -------------------------------------------------------------------------

  _checkReplayStability(scenarioName, options, firstSnapshot) {
    const optsCopy = Object.assign({}, options);
    // Marcador para evitar recursión infinita.
    optsCopy._isReplayCheck = true;
    if (options._isReplayCheck) return { stable: true, diff: null };

    let second;
    try {
      // Re-run en un sub-runner clónico (mismo seed, mismo escenario).
      const cloneRunner = new SessionSimulatorRunner(this.config);
      cloneRunner.scenarios = this.scenarios;
      cloneRunner.moduleResolver = this.moduleResolver;
      const cloneScenario = this.scenarios.get(scenarioName);
      // Desactivamos replayStable en el sub-run para no recurrir.
      const cloneExp = Object.assign({}, cloneScenario.expectedBehavior, { replayStable: false });
      cloneRunner.scenarios.set(scenarioName, new SimulationScenario({
        name: cloneScenario.name,
        initialContext: cloneScenario.initialContext,
        actions: cloneScenario.actions,
        expectedBehavior: cloneExp,
        postRunDurationMs: cloneScenario.postRunDurationMs,
        tickResolutionMs: cloneScenario.tickResolutionMs,
      }));
      second = cloneRunner.run(scenarioName, optsCopy);
      // Restauramos el escenario original.
      cloneRunner.scenarios.set(scenarioName, cloneScenario);
    } catch (err) {
      return { stable: false, diff: { error: err.message } };
    }

    const a = stableStringify(firstSnapshot);
    const b = stableStringify(second.orchestratorSnapshot);
    return { stable: a === b, diff: a === b ? null : { firstHash: hash32(a), secondHash: hash32(b) } };
  }

  // -------------------------------------------------------------------------
  // DOM aislado (solo modo full-stack)
  // -------------------------------------------------------------------------

  _setupDom() {
    const JSDOM = loadJsdomOrThrow();
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <div id="productModal" class="modal"></div>
        <div id="cartOverlay" class="cart-overlay"></div>
        <div id="modalBody"></div>
        <div class="product-card" data-product-id="prod_1"></div>
        <div class="product-card" data-product-id="prod_2"></div>
        <button class="btn-add">Add</button>
      </body></html>`,
      { url: 'http://localhost' }
    );

    // Backup de globals para restaurar tras teardown.
    const backup = {
      window: global.window,
      document: global.document,
      navigator: global.navigator,
      hadWindow: 'window' in global,
      hadDocument: 'document' in global,
      hadNavigator: 'navigator' in global,
    };

    global.window = dom.window;
    global.document = dom.window.document;
    global.navigator = dom.window.navigator;

    return { dom, backup };
  }

  _teardownDom(handle) {
    if (!handle) return;
    try { handle.dom.window.close(); } catch (_e) { /* ignore */ }
    const { backup } = handle;
    if (backup.hadWindow) global.window = backup.window; else delete global.window;
    if (backup.hadDocument) global.document = backup.document; else delete global.document;
    if (backup.hadNavigator) global.navigator = backup.navigator; else delete global.navigator;
  }

  _emptyMetrics() {
    return {
      interventions: 0,
      renders: 0,
      replacements: 0,
      clearings: 0,
      suppressed: 0,
      contextSwitches: 0,
      staleMessages: 0,
      flickering: 0,
      _renderedTimeline: [],
      _removedTimeline: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Stable stringify para comparación bit-exact de snapshots.
// ---------------------------------------------------------------------------

function stableStringify(value) {
  return JSON.stringify(value, (key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      const keys = Object.keys(v).sort();
      for (const k of keys) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// Escenarios predefinidos con expectedBehavior real (no placeholders)
// ---------------------------------------------------------------------------

function createListingScenario() {
  return new SimulationScenario({
    name: 'normal_listing',
    initialContext: 'listing',
    actions: [
      { type: 'scroll', payload: { depth: 0.3 }, delayMs: 500 },
      { type: 'product_focus', payload: { productId: 'prod_1' }, delayMs: 1000 },
      { type: 'scroll', payload: { depth: 0.6 }, delayMs: 1500 },
      { type: 'product_focus', payload: { productId: 'prod_2' }, delayMs: 800 },
      { type: 'modal_open', payload: { productId: 'prod_2' }, delayMs: 2000 },
      { type: 'modal_close', payload: {}, delayMs: 5000 },
    ],
    expectedBehavior: {
      maxFlickering: 0,
      minVisibleMs: 1500,
      replayStable: true,
    },
    postRunDurationMs: 8000,
    tickResolutionMs: 100,
  });
}

function createHighIntentScenario() {
  return new SimulationScenario({
    name: 'high_intent',
    initialContext: 'product_detail',
    actions: [
      { type: 'product_focus', payload: { productId: 'prod_1' }, delayMs: 300 },
      { type: 'hover_start', payload: { elementId: 'btn1', productId: 'prod_1' }, delayMs: 500 },
      { type: 'add_to_cart', payload: { productId: 'prod_1' }, delayMs: 1000 },
      { type: 'modal_open', payload: { productId: 'prod_1' }, delayMs: 1500 },
      { type: 'hover_start', payload: { elementId: 'checkout', productId: 'prod_1' }, delayMs: 800 },
      { type: 'add_to_cart', payload: { productId: 'prod_1' }, delayMs: 600 },
    ],
    expectedBehavior: {
      maxFlickering: 0,
      minVisibleMs: 1500,
      maxInterventions: 5,
      replayStable: true,
    },
    postRunDurationMs: 6000,
    tickResolutionMs: 100,
  });
}

function createExitRiskScenario() {
  return new SimulationScenario({
    name: 'exit_risk',
    initialContext: 'listing',
    actions: [
      { type: 'scroll', payload: { depth: 0.2 }, delayMs: 300 },
      { type: 'scroll', payload: { depth: 0.9 }, delayMs: 200 },
      { type: 'context_change', payload: { context: 'exit' }, delayMs: 500 },
      { type: 'modal_open', payload: { productId: 'prod_1' }, delayMs: 400 },
      { type: 'modal_close', payload: {}, delayMs: 200 },
      { type: 'context_change', payload: { context: 'listing' }, delayMs: 300 },
    ],
    expectedBehavior: {
      maxFlickering: 1,
      replayStable: true,
    },
    postRunDurationMs: 5000,
    tickResolutionMs: 50,
  });
}

function createEventStormScenario() {
  const actions = [];
  for (let i = 0; i < 200; i++) {
    actions.push({ type: 'scroll', payload: { depth: (i % 100) / 100 }, delayMs: 10 });
  }
  return new SimulationScenario({
    name: 'event_storm',
    initialContext: 'listing',
    actions,
    expectedBehavior: {
      maxFlickering: 0,
      maxInterventions: 5,
      replayStable: true,
    },
    postRunDurationMs: 4000,
    tickResolutionMs: 50,
  });
}

function createLongIdleScenario() {
  const actions = [
    { type: 'product_focus', payload: { productId: 'prod_1' }, delayMs: 500 },
    { type: 'idle', payload: {}, delayMs: 60_000 },
    { type: 'product_focus', payload: { productId: 'prod_2' }, delayMs: 500 },
  ];
  return new SimulationScenario({
    name: 'long_idle',
    initialContext: 'listing',
    actions,
    expectedBehavior: {
      maxFlickering: 0,
      replayStable: true,
    },
    postRunDurationMs: 5000,
    tickResolutionMs: 250,
  });
}

function createContextThrashScenario() {
  const actions = [];
  const contexts = ['listing', 'product_detail', 'modal', 'cart'];
  for (let i = 0; i < 40; i++) {
    actions.push({ type: 'context_change', payload: { context: contexts[i % contexts.length] }, delayMs: 100 });
  }
  return new SimulationScenario({
    name: 'context_thrash',
    initialContext: 'listing',
    actions,
    expectedBehavior: {
      maxFlickering: 0,
      replayStable: true,
    },
    postRunDurationMs: 3000,
    tickResolutionMs: 50,
  });
}

// ---------------------------------------------------------------------------
// Exportación
// ---------------------------------------------------------------------------

module.exports = {
  SessionSimulatorRunner,
  // Alias retrocompatible con el nombre anterior.
  SessionSimulationRunner: SessionSimulatorRunner,
  SimulationScenario,
  TimelineLogger,
  SimulatorError,
  createSeededRandom,
  createSeededUuid,
  createSimulatedClock,
  createListingScenario,
  createHighIntentScenario,
  createExitRiskScenario,
  createEventStormScenario,
  createLongIdleScenario,
  createContextThrashScenario,
};
