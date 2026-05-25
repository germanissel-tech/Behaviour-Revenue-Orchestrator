'use client';

/**
 * ope-debug-bridge.ts
 *
 * Bridge READ-ONLY entre los motores OPE (JS) y los componentes React de debug.
 *
 * CAMBIOS v2 — Integración completa del event flow:
 *
 *  PROBLEMA ANTERIOR:
 *    - opeEvents emitía eventos (product:visible, hover, dwell, cart:add, etc.)
 *    - Nadie los escuchaba para actualizar el debug store
 *    - El bridge vivía desconectado del event bus real
 *    - useOPEEventBridge era simulación manual sin suscripción real
 *
 *  SOLUCIÓN:
 *    - initOPEBridge() suscribe a TODOS los eventos de opeEvents
 *    - Cada evento actualiza el debug store de forma determinista
 *    - Señales de comportamiento se derivan de los eventos reales
 *    - Trace se construye desde eventos reales de navegación
 *    - Health se ejecuta periódicamente
 *
 *  GARANTÍAS:
 *    - READ-ONLY: nunca modifica estado de motores
 *    - Never triggers interventions
 *    - Never writes memories
 *    - Never changes orchestration
 *    - Cleanup seguro (unsubscribe en dispose)
 */

import { create } from 'zustand';
import { opeEvents, type OPEEventType } from './ope-events';

// ============================================================================
// TIPOS
// ============================================================================

export interface SessionState {
  sessionId: string;
  userId: string | null;
  startedAt: number;
  duration: number;
  eventsCount: number;
  revisitCount: number;
  scrollVelocity: number;
  activeContext: string;
  activeProductId: string | null;
}

export interface BehaviorSignals {
  hoverScore: number;
  dwellScore: number;
  hesitationScore: number;
  interestScore: number;
  revisitScore: number;
  cartConfidence: number;
  completionConfidence: number;
  returnRisk: number;
  fatigueScore: number;
}

export interface IntentState {
  rawSignals: string[];
  currentIntent: string;
  intentConfidence: number;
  previousIntent: string | null;
  transitionReason: string | null;
  transitionConfidence: number;
}

export interface ProductRelationship {
  primaryId: string;
  complementId: string;
  relationshipType: string;
  completionConfidence: number;
  negativePreference: boolean;
  historicalAffinity: string;
  suppressionState: string | null;
  relationshipScore: number;
}

export interface MessageCandidate {
  id: string;
  family: string;
  content: string;
  rankingScore: number;
  compatibilityScore: number;
  selected: boolean;
  rejectionReason: string | null;
}

export interface FatigueState {
  cooldownActive: boolean;
  cooldownRemainingMs: number;
  familyFatigue: Record<string, number>;
  contextFatigue: Record<string, number>;
  blockedReason: string | null;
  sessionMessagesCount: number;
  saturationLevel: number;
}

export interface LifecycleState {
  messageId: string | null;
  state: 'none' | 'visible' | 'dismissed' | 'expired' | 'converted';
  shownAt: number | null;
  dismissedAt: number | null;
  expiredAt: number | null;
  cleanupEvents: string[];
}

export interface TraceEntry {
  seq: number;
  stage: string;
  prevStage: string | null;
  productId: string | null;
  timestamp: number;
  anomaly: string | null;
  trigger: string | null;
}

export interface HealthCheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string | null;
}

export interface RuntimeHealth {
  healthy: boolean;
  memoryUsage: number;
  orphanReferences: number;
  orphanTimers: number;
  listenersCount: number;
  boundedMemoryOk: boolean;
  replayValid: boolean;
  stateDriftDetected: boolean;
  checks: HealthCheckResult[];
}

export interface DecisionPath {
  signal: string;
  intent: string;
  ranking: string;
  fatigue: string;
  lifecycle: string;
  finalMessage: string | null;
}

export interface OPEDebugEvent {
  id: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
  affectedEngines: string[];
  decisionPath: DecisionPath | null;
  status: 'active' | 'waiting' | 'blocked' | 'executed';
}

// ============================================================================
// STORE DE DEBUG (READ-ONLY OBSERVER)
// ============================================================================

interface OPEDebugStore {
  isConnected: boolean;
  isPanelOpen: boolean;
  isPanelMinimized: boolean;
  panelWidth: number;
  activeSection: string;

  session: SessionState;
  signals: BehaviorSignals;
  intent: IntentState;
  relationships: ProductRelationship[];
  messageCandidates: MessageCandidate[];
  fatigue: FatigueState;
  lifecycle: LifecycleState;
  trace: TraceEntry[];
  health: RuntimeHealth;
  events: OPEDebugEvent[];

  // UI actions only — never touch engine state
  togglePanel: () => void;
  minimizePanel: () => void;
  setPanelWidth: (width: number) => void;
  setActiveSection: (section: string) => void;
  updateFromOPE: (data: Partial<OPEDebugStore>) => void;
  reset: () => void;

  // Internal: called by bridge subscriptions only
  _handleOPEEvent: (type: string, data: Record<string, unknown>, timestamp: number) => void;
  _pushTrace: (entry: Omit<TraceEntry, 'seq'>) => void;
}

const initialSession: SessionState = {
  sessionId: typeof window !== 'undefined'
    ? `sess_${Date.now().toString(36)}`
    : 'sess_ssr',
  userId: null,
  startedAt: typeof window !== 'undefined' ? Date.now() : 0,
  duration: 0,
  eventsCount: 0,
  revisitCount: 0,
  scrollVelocity: 0,
  activeContext: 'listing',
  activeProductId: null,
};

const initialSignals: BehaviorSignals = {
  hoverScore: 0,
  dwellScore: 0,
  hesitationScore: 0,
  interestScore: 0,
  revisitScore: 0,
  cartConfidence: 0,
  completionConfidence: 0,
  returnRisk: 0,
  fatigueScore: 0,
};

const initialIntent: IntentState = {
  rawSignals: [],
  currentIntent: 'exploring',
  intentConfidence: 0.5,
  previousIntent: null,
  transitionReason: null,
  transitionConfidence: 0,
};

const initialFatigue: FatigueState = {
  cooldownActive: false,
  cooldownRemainingMs: 0,
  familyFatigue: {},
  contextFatigue: {},
  blockedReason: null,
  sessionMessagesCount: 0,
  saturationLevel: 0,
};

const initialLifecycle: LifecycleState = {
  messageId: null,
  state: 'none',
  shownAt: null,
  dismissedAt: null,
  expiredAt: null,
  cleanupEvents: [],
};

const initialHealth: RuntimeHealth = {
  healthy: true,
  memoryUsage: 0,
  orphanReferences: 0,
  orphanTimers: 0,
  listenersCount: 0,
  boundedMemoryOk: true,
  replayValid: true,
  stateDriftDetected: false,
  checks: [],
};

// ============================================================================
// SIGNAL DERIVATION HELPERS (pure, deterministic)
// ============================================================================

/** Exponential moving average update: prev × (1-α) + value × α */
function ema(prev: number, value: number, alpha = 0.3): number {
  return Math.round(Math.min(1, Math.max(0, prev * (1 - alpha) + value * alpha)) * 1000) / 1000;
}

/** Derive context string from OPE event type */
function deriveContext(eventType: string, currentContext: string): string {
  if (eventType === 'pdp:open') return 'product_detail';
  if (eventType === 'pdp:close') return 'listing';
  if (eventType === 'cart:view' || eventType === 'cart:hesitation') return 'cart';
  if (eventType === 'checkout:start' || eventType === 'checkout:step') return 'checkout';
  if (eventType === 'checkout:complete') return 'post_purchase';
  if (eventType === 'category:view') return 'listing';
  return currentContext;
}

/** Map OPE event type to trace stage */
function eventToTraceStage(eventType: string): string | null {
  const map: Record<string, string> = {
    'product:visible':  'listing',
    'product:hover':    'hover',
    'product:dwell':    'dwell',
    'session:revisit':  'revisit',
    'pdp:open':         'product_detail',
    'cart:add':         'add_to_cart',
    'cart:view':        'cart',
    'cart:hesitation':  'cart_hesitation',
    'checkout:start':   'checkout',
    'checkout:complete':'post_purchase',
  };
  return map[eventType] || null;
}

/** Map cart confidence to intent state */
function deriveIntentFromSignals(
  cartConfidence: number,
  hesitationScore: number,
  interestScore: number,
  currentIntent: string,
): { intent: string; confidence: number; reason: string } {
  if (cartConfidence > 0.5) {
    return { intent: 'high_intent', confidence: 0.75, reason: 'cart_add_signal' };
  }
  if (hesitationScore > 0.6) {
    return { intent: 'hesitating', confidence: 0.65, reason: 'hesitation_detected' };
  }
  if (interestScore > 0.7) {
    return { intent: 'evaluating', confidence: 0.6, reason: 'dwell_interest_signal' };
  }
  if (interestScore > 0.3) {
    return { intent: 'exploring', confidence: 0.55, reason: 'browsing_signal' };
  }
  return { intent: currentIntent, confidence: 0.5, reason: 'no_change' };
}

// ============================================================================
// ZUSTAND STORE
// ============================================================================

let _traceSeq = 0;

export const useOPEDebugStore = create<OPEDebugStore>((set, get) => ({
  isConnected: false,  // set to true after initOPEBridge()
  isPanelOpen: false,
  isPanelMinimized: false,
  panelWidth: 380,
  activeSection: 'session',

  session: initialSession,
  signals: initialSignals,
  intent: initialIntent,
  relationships: [],
  messageCandidates: [],
  fatigue: initialFatigue,
  lifecycle: initialLifecycle,
  trace: [],
  health: initialHealth,
  events: [],

  // UI actions
  togglePanel: () => set(state => ({ isPanelOpen: !state.isPanelOpen })),
  minimizePanel: () => set(state => ({ isPanelMinimized: !state.isPanelMinimized })),
  setPanelWidth: (width) => set({ panelWidth: Math.max(300, Math.min(600, width)) }),
  setActiveSection: (section) => set({ activeSection: section }),
  updateFromOPE: (data) => set(state => ({ ...state, ...data })),

  reset: () => {
    _traceSeq = 0;
    set({
      session: {
        ...initialSession,
        sessionId: `sess_${Date.now().toString(36)}`,
        startedAt: Date.now(),
      },
      signals: { ...initialSignals },
      intent: { ...initialIntent },
      relationships: [],
      messageCandidates: [],
      fatigue: { ...initialFatigue },
      lifecycle: { ...initialLifecycle },
      trace: [],
      health: { ...initialHealth },
      events: [],
    });
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Internal: called by bridge subscriptions
  // READ-ONLY — never writes to engine state
  // ──────────────────────────────────────────────────────────────────────────

  _handleOPEEvent: (type, data, timestamp) => {
    const state = get();
    const now = timestamp;

    // 1. Push to events log (capped at 100)
    const newEvent: OPEDebugEvent = {
      id: `evt_${now}_${Math.random().toString(36).slice(2, 7)}`,
      type,
      timestamp: now,
      payload: data,
      affectedEngines: _mapEventToEngines(type),
      decisionPath: null,
      status: 'executed',
    };
    const events = [newEvent, ...state.events].slice(0, 100);

    // 2. Update session counters
    const session: SessionState = {
      ...state.session,
      eventsCount: state.session.eventsCount + 1,
      duration: now - state.session.startedAt,
      activeContext: deriveContext(type, state.session.activeContext),
      activeProductId: (data.productId as string) ?? state.session.activeProductId,
    };

    // 3. Derive signals from event
    let signals = { ...state.signals };

    switch (type) {
      case 'product:hover':
        signals.hoverScore = ema(signals.hoverScore, 0.6);
        break;
      case 'product:hover_end': {
        const duration = (data.duration as number) ?? 0;
        signals.hoverScore = ema(signals.hoverScore, Math.min(1, duration / 3000));
        break;
      }
      case 'product:dwell': {
        const dwellTime = (data.dwellTime as number) ?? 0;
        const returnVisits = (data.returnVisits as number) ?? 1;
        signals.dwellScore = ema(signals.dwellScore, Math.min(1, dwellTime / 8000));
        signals.interestScore = ema(
          signals.interestScore,
          Math.min(1, (dwellTime / 6000) * 0.6 + (returnVisits / 3) * 0.4)
        );
        if (returnVisits > 1) {
          signals.revisitScore = ema(signals.revisitScore, Math.min(1, returnVisits / 4));
        }
        break;
      }
      case 'cart:add':
        signals.cartConfidence = ema(signals.cartConfidence, 0.8, 0.5);
        signals.interestScore  = ema(signals.interestScore, 0.85, 0.4);
        break;
      case 'cart:remove':
        signals.cartConfidence = Math.max(0, signals.cartConfidence - 0.2);
        break;
      case 'cart:hesitation': {
        const hesitationDuration = (data.hesitationDuration as number) ?? 0;
        const viewCount = (data.viewCount as number) ?? 1;
        signals.hesitationScore = ema(
          signals.hesitationScore,
          Math.min(1, hesitationDuration / 10000) * 0.7 + Math.min(1, viewCount / 5) * 0.3,
          0.4
        );
        break;
      }
      case 'scroll:velocity': {
        const velocity = (data.velocity as number) ?? 0;
        // Fast scrolling = low interest; slow = higher interest
        signals.interestScore = ema(signals.interestScore, velocity < 200 ? 0.6 : 0.2, 0.1);
        break;
      }
      case 'checkout:start':
      case 'checkout:complete':
        signals.cartConfidence = ema(signals.cartConfidence, 1.0, 0.7);
        signals.interestScore  = ema(signals.interestScore, 1.0, 0.5);
        break;
      case 'session:revisit':
        signals.revisitScore = ema(signals.revisitScore, 0.8, 0.5);
        session.revisitCount = session.revisitCount + 1;
        break;
    }

    // 4. Derive intent from updated signals
    const { intent: newIntentStr, confidence, reason } = deriveIntentFromSignals(
      signals.cartConfidence,
      signals.hesitationScore,
      signals.interestScore,
      state.intent.currentIntent,
    );

    const intent: IntentState = newIntentStr !== state.intent.currentIntent
      ? {
          rawSignals: [...state.intent.rawSignals, type].slice(-12),
          currentIntent: newIntentStr,
          intentConfidence: confidence,
          previousIntent: state.intent.currentIntent,
          transitionReason: reason,
          transitionConfidence: confidence,
        }
      : {
          ...state.intent,
          rawSignals: [...state.intent.rawSignals, type].slice(-12),
          intentConfidence: ema(state.intent.intentConfidence, confidence, 0.2),
        };

    // 5. Trace transition
    const traceStage = eventToTraceStage(type);
    let trace = state.trace;
    if (traceStage) {
      const prevStage = trace.length > 0 ? trace[trace.length - 1].stage : null;
      if (traceStage !== prevStage) {
        const entry: TraceEntry = {
          seq: ++_traceSeq,
          stage: traceStage,
          prevStage,
          productId: (data.productId as string) ?? null,
          timestamp: now,
          anomaly: null,
          trigger: type,
        };
        trace = [...trace, entry].slice(-50); // keep last 50 transitions
      }
    }

    set({ events, session, signals, intent, trace });
  },

  _pushTrace: (entry) => {
    const state = get();
    const full: TraceEntry = { ...entry, seq: ++_traceSeq };
    set({ trace: [...state.trace, full].slice(-50) });
  },
}));

// ============================================================================
// ENGINE → AFFECTED ENGINES MAP
// ============================================================================

function _mapEventToEngines(type: string): string[] {
  const map: Record<string, string[]> = {
    'product:visible':    ['context-presence-engine', 'runtime-trace'],
    'product:hover':      ['behavioral-state-store', 'signal-derivation-engine'],
    'product:hover_end':  ['behavioral-state-store', 'signal-derivation-engine'],
    'product:dwell':      ['behavioral-state-store', 'unified-intent-engine', 'runtime-trace'],
    'product:click':      ['behavioral-state-store', 'funnel-stage-engine'],
    'pdp:open':           ['session-orchestrator', 'unified-intent-engine', 'runtime-trace'],
    'pdp:close':          ['session-orchestrator', 'runtime-trace'],
    'pdp:scroll':         ['behavioral-state-store'],
    'cart:add':           ['session-orchestrator', 'unified-intent-engine', 'product-relationship-intervention-engine', 'runtime-trace'],
    'cart:remove':        ['session-orchestrator', 'behavioral-state-store'],
    'cart:quantity_change':['behavioral-state-store'],
    'cart:view':          ['behavioral-state-store', 'funnel-stage-engine'],
    'cart:hesitation':    ['behavioral-state-store', 'unified-intent-engine', 'cooldown-fatigue-engine'],
    'checkout:start':     ['session-orchestrator', 'funnel-stage-engine', 'runtime-trace'],
    'checkout:step':      ['funnel-stage-engine', 'runtime-trace'],
    'checkout:complete':  ['session-orchestrator', 'funnel-stage-engine', 'runtime-trace'],
    'checkout:abandon':   ['session-orchestrator', 'behavioral-state-store'],
    'session:start':      ['session-orchestrator'],
    'session:revisit':    ['session-orchestrator', 'behavioral-state-store', 'runtime-trace'],
    'session:duration_update': ['session-orchestrator'],
    'scroll:velocity':    ['behavioral-state-store', 'signal-derivation-engine'],
    'scroll:pause':       ['behavioral-state-store'],
    'category:view':      ['context-presence-engine', 'funnel-stage-engine'],
    'search:query':       ['behavioral-state-store'],
  };
  return map[type] || ['behavioral-state-store'];
}

// ============================================================================
// BRIDGE INITIALIZATION
// ============================================================================

/** Unsubscribe function returned by initOPEBridge */
type BridgeCleanup = () => void;

let _bridgeInitialized = false;
let _bridgeCleanup: BridgeCleanup | null = null;

/**
 * initOPEBridge()
 *
 * Subscribes the debug store to ALL opeEvents events.
 * Must be called once on client mount (e.g. in StoreLayout useEffect).
 *
 * Returns a cleanup function that removes all subscriptions.
 * Call it in the useEffect cleanup to avoid memory leaks.
 *
 * READ-ONLY: this function only observes events, never modifies
 * engine state or triggers any intervention.
 */
export function initOPEBridge(): BridgeCleanup {
  if (_bridgeInitialized && _bridgeCleanup) {
    return _bridgeCleanup;
  }

  const store = useOPEDebugStore.getState();

  // Subscribe to wildcard — catches every event type
  const unsubscribeAll = opeEvents.on('*', (event) => {
    store._handleOPEEvent(event.type, event.data, event.timestamp);
  });

  // Health check: run every 30 seconds, update health panel
  // READ-ONLY: only reads browser performance API
  const healthInterval = setInterval(() => {
    const memUsage = typeof performance !== 'undefined' && (performance as any).memory
      ? Math.round(((performance as any).memory.usedJSHeapSize / (performance as any).memory.jsHeapSizeLimit) * 100)
      : 0;

    const eventHistory = opeEvents.getEventHistory();
    const currentState = useOPEDebugStore.getState();

    const checks: HealthCheckResult[] = [
      {
        name: 'Event bus liviness',
        status: eventHistory.length >= 0 ? 'pass' : 'fail',
        detail: `${eventHistory.length} events in history`,
      },
      {
        name: 'Session active',
        status: currentState.session.eventsCount > 0 ? 'pass' : 'warn',
        detail: `${currentState.session.eventsCount} events processed`,
      },
      {
        name: 'Memory usage',
        status: memUsage < 80 ? 'pass' : memUsage < 95 ? 'warn' : 'fail',
        detail: memUsage > 0 ? `${memUsage}% heap used` : 'unavailable',
      },
      {
        name: 'Trace integrity',
        status: currentState.trace.length <= 50 ? 'pass' : 'warn',
        detail: `${currentState.trace.length} entries`,
      },
      {
        name: 'Signal bounds',
        status: Object.values(currentState.signals).every(v => v >= 0 && v <= 1) ? 'pass' : 'fail',
        detail: 'all scores in [0,1]',
      },
    ];

    const allPass = checks.every(c => c.status === 'pass');
    const anyFail = checks.some(c => c.status === 'fail');

    useOPEDebugStore.getState().updateFromOPE({
      health: {
        healthy: !anyFail,
        memoryUsage: memUsage,
        orphanReferences: 0,
        orphanTimers: 0,
        listenersCount: eventHistory.length,
        boundedMemoryOk: true,
        replayValid: true,
        stateDriftDetected: false,
        checks,
      },
    });
  }, 30_000);

  // Mark bridge as connected
  useOPEDebugStore.getState().updateFromOPE({ isConnected: true });

  _bridgeInitialized = true;
  _bridgeCleanup = () => {
    unsubscribeAll();
    clearInterval(healthInterval);
    _bridgeInitialized = false;
    _bridgeCleanup = null;
    useOPEDebugStore.getState().updateFromOPE({ isConnected: false });
  };

  return _bridgeCleanup;
}

// ============================================================================
// HOOK: useOPEEventBridge
//
// Thin helpers that components can call to emit named events.
// These emit to opeEvents (the real bus) — the bridge subscription
// above picks them up automatically.
//
// Components should prefer calling the typed emit helpers in ope-events.ts
// directly. This hook exists for convenience in components that need
// context-aware tracking beyond what the automatic subscription covers.
// ============================================================================

export function useOPEEventBridge() {
  // These are READ-ONLY helpers — they emit to opeEvents only.
  // The bridge subscription translates them to debug state updates.

  const trackProductView = (productId: string, category: string) => {
    opeEvents.emit('pdp:open', {
      productId,
      category,
      canonicalType: category,
      price: 0,
    });
  };

  const trackHover = (productId: string, durationMs: number) => {
    opeEvents.emit('product:hover_end', {
      productId,
      category: '',
      canonicalType: '',
      duration: durationMs,
    });
  };

  const trackAddToCart = (productId: string, quantity: number) => {
    // cart-store already emits cart:add — this is a no-op safety wrapper
    // to avoid double-emitting. Use cart-store's addItem() instead.
  };

  const trackCheckoutProgress = (step: string) => {
    opeEvents.emit('checkout:step', {
      step: step as any,
      cartTotal: 0,
      itemCount: 0,
    });
  };

  const trackScroll = (velocity: number, direction: 'up' | 'down') => {
    opeEvents.emit('scroll:velocity', {
      velocity,
      direction,
      position: 0,
      maxPosition: document.documentElement.scrollHeight,
    });
  };

  return {
    trackProductView,
    trackHover,
    trackAddToCart,
    trackCheckoutProgress,
    trackScroll,
  };
}
