'use client';

/**
 * ope-debug-bridge.ts
 *
 * Bridge READ-ONLY entre los motores OPE (JS) y los componentes React de debug.
 * Este módulo SOLO OBSERVA, nunca modifica estado ni dispara intervenciones.
 *
 * Simula los motores OPE para propósitos de testing/demo ya que los motores
 * reales son módulos Node.js que no pueden ejecutarse directamente en el browser.
 */

import { create } from 'zustand';

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

// ── New: Observability decision record ──────────────────────────────────────
export interface ObservabilityDecision {
  recordId: string;
  sessionId: string;
  decision: string;       // INTERVENE | SKIP | BLOCK_FATIGUE | DO_NOTHING | ...
  confidence: number;
  reason: string | null;
  context: string | null;
  selectedFamily: string | null;
  variant: string | null;
  timestamp: number;
  summary: string;
}

// ── New: Mobile intent state ─────────────────────────────────────────────────
export interface MobileIntentState {
  intent: string;         // exploring | hesitating | high_intent | disengaged
  confidence: number;
  thumbZoneRatio: number;
  avgScrollVelocity: number | null;
  isHesitating: boolean;
  hasLongPress: boolean;
  touchCount: number;
}

// ── New: User memory summary ─────────────────────────────────────────────────
export interface MemoryState {
  ignoredProductCount: number;
  sessionDismissals: number;
  sessionHesitations: number;
  sessionRevisits: number;
  sessionCartAdds: number;
  topCategories: string[];
  suppressedEntities: string[];
}

export interface OPEEvent {
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
  // Estado
  isConnected: boolean;
  isPanelOpen: boolean;
  isPanelMinimized: boolean;
  panelWidth: number;
  activeSection: string;
  
  // Datos de los motores
  session: SessionState;
  signals: BehaviorSignals;
  intent: IntentState;
  relationships: ProductRelationship[];
  messageCandidates: MessageCandidate[];
  fatigue: FatigueState;
  lifecycle: LifecycleState;
  trace: TraceEntry[];
  health: RuntimeHealth;
  events: OPEEvent[];

  // ── Hardening engines data ────────────────────────────────────────────────
  lastDecision: ObservabilityDecision | null;
  recentDecisions: ObservabilityDecision[];
  mobileIntent: MobileIntentState | null;
  memoryState: MemoryState | null;
  
  // Acciones (UI only, no modifica motores)
  togglePanel: () => void;
  minimizePanel: () => void;
  setPanelWidth: (width: number) => void;
  setActiveSection: (section: string) => void;
  
  // Simulación de eventos (para testing)
  simulateEvent: (event: Partial<OPEEvent>) => void;
  updateFromOPE: (data: Partial<OPEDebugStore>) => void;
  reset: () => void;

  // ── Hardening engine updates ──────────────────────────────────────────────
  pushDecision: (decision: ObservabilityDecision) => void;
  updateMobileIntent: (mobileIntent: MobileIntentState) => void;
  updateMemoryState: (memoryState: MemoryState) => void;
}

// Estado inicial
const initialSession: SessionState = {
  sessionId: `sess_${Date.now().toString(36)}`,
  userId: null,
  startedAt: Date.now(),
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

export const useOPEDebugStore = create<OPEDebugStore>((set, get) => ({
  // Estado inicial
  isConnected: true,
  lastDecision: null,
  recentDecisions: [],
  mobileIntent: null,
  memoryState: null,
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
  
  // Acciones de UI
  togglePanel: () => set(state => ({ isPanelOpen: !state.isPanelOpen })),
  minimizePanel: () => set(state => ({ isPanelMinimized: !state.isPanelMinimized })),
  setPanelWidth: (width) => set({ panelWidth: Math.max(300, Math.min(600, width)) }),
  setActiveSection: (section) => set({ activeSection: section }),
  
  // Simular evento (para demo/testing)
  simulateEvent: (event) => {
    const now = Date.now();
    const newEvent: OPEEvent = {
      id: `evt_${now}_${Math.random().toString(36).slice(2, 8)}`,
      type: event.type || 'UNKNOWN',
      timestamp: now,
      payload: event.payload || {},
      affectedEngines: event.affectedEngines || [],
      decisionPath: event.decisionPath || null,
      status: event.status || 'executed',
    };
    
    set(state => ({
      events: [newEvent, ...state.events].slice(0, 100),
      session: {
        ...state.session,
        eventsCount: state.session.eventsCount + 1,
        duration: now - state.session.startedAt,
      },
    }));
  },
  
  // Actualizar desde OPE (cuando los motores emiten datos)
  updateFromOPE: (data) => set(state => ({ ...state, ...data })),

  // ── Push a new observability decision record ────────────────────────────────
  pushDecision: (decision: ObservabilityDecision) => set(state => ({
    lastDecision: decision,
    recentDecisions: [decision, ...state.recentDecisions].slice(0, 50),
  })),

  // ── Update mobile intent state ──────────────────────────────────────────────
  updateMobileIntent: (mobileIntent: MobileIntentState) => set(() => ({ mobileIntent })),

  // ── Update user memory state ────────────────────────────────────────────────
  updateMemoryState: (memoryState: MemoryState) => set(() => ({ memoryState })),
  
  // Reset
  reset: () => set({
    session: { ...initialSession, sessionId: `sess_${Date.now().toString(36)}`, startedAt: Date.now() },
    signals: initialSignals,
    intent: initialIntent,
    relationships: [],
    messageCandidates: [],
    fatigue: initialFatigue,
    lifecycle: initialLifecycle,
    trace: [],
    health: initialHealth,
    events: [],
    lastDecision: null,
    recentDecisions: [],
    mobileIntent: null,
    memoryState: null,
  }),
}));

// ============================================================================
// HOOK PARA CONECTAR EVENTOS DE LA TIENDA CON EL DEBUG
// ============================================================================

export function useOPEEventBridge() {
  const { simulateEvent, updateFromOPE } = useOPEDebugStore();
  
  const trackProductView = (productId: string, category: string) => {
    simulateEvent({
      type: 'PRODUCT_VIEW',
      payload: { productId, category },
      affectedEngines: ['behavioral-state-store', 'unified-intent-engine', 'runtime-trace'],
      status: 'executed',
    });
    
    // Actualizar trace
    updateFromOPE({
      session: {
        ...useOPEDebugStore.getState().session,
        activeContext: 'product_detail',
        activeProductId: productId,
      },
    });
  };
  
  const trackHover = (productId: string, durationMs: number) => {
    const signals = useOPEDebugStore.getState().signals;
    const newHoverScore = Math.min(1, signals.hoverScore + 0.1);
    const newDwellScore = Math.min(1, durationMs / 5000);
    
    simulateEvent({
      type: 'HOVER',
      payload: { productId, durationMs },
      affectedEngines: ['behavioral-state-store', 'signal-derivation-engine'],
      status: 'executed',
    });
    
    updateFromOPE({
      signals: { ...signals, hoverScore: newHoverScore, dwellScore: newDwellScore },
    });
  };
  
  const trackAddToCart = (productId: string, quantity: number) => {
    const state = useOPEDebugStore.getState();
    
    simulateEvent({
      type: 'ADD_TO_CART',
      payload: { productId, quantity },
      affectedEngines: ['behavioral-state-store', 'unified-intent-engine', 'product-relationship-intervention-engine'],
      status: 'executed',
      decisionPath: {
        signal: 'add_to_cart',
        intent: state.intent.currentIntent,
        ranking: 'CART_SUPPORT evaluated',
        fatigue: state.fatigue.cooldownActive ? 'blocked' : 'allowed',
        lifecycle: 'pending',
        finalMessage: null,
      },
    });
    
    // Simular transición de intent
    updateFromOPE({
      intent: {
        ...state.intent,
        previousIntent: state.intent.currentIntent,
        currentIntent: 'high_intent',
        intentConfidence: 0.75,
        transitionReason: 'add_to_cart_signal',
        transitionConfidence: 0.8,
        rawSignals: [...state.intent.rawSignals, 'add_to_cart'].slice(-10),
      },
      signals: {
        ...state.signals,
        cartConfidence: Math.min(1, state.signals.cartConfidence + 0.3),
        interestScore: Math.min(1, state.signals.interestScore + 0.2),
      },
    });
  };
  
  const trackCheckoutProgress = (step: string) => {
    simulateEvent({
      type: 'CHECKOUT_PROGRESS',
      payload: { step },
      affectedEngines: ['behavioral-state-store', 'funnel-stage-engine', 'runtime-trace'],
      status: 'executed',
    });
    
    updateFromOPE({
      session: {
        ...useOPEDebugStore.getState().session,
        activeContext: 'checkout',
      },
    });
  };
  
  const trackSearch = (query: string, resultsCount: number) => {
    simulateEvent({
      type: 'SEARCH',
      payload: { query, resultsCount },
      affectedEngines: ['behavioral-state-store'],
      status: 'executed',
    });
  };
  
  const trackScroll = (velocity: number, direction: 'up' | 'down') => {
    updateFromOPE({
      session: {
        ...useOPEDebugStore.getState().session,
        scrollVelocity: velocity,
      },
    });
  };
  
  return {
    trackProductView,
    trackHover,
    trackAddToCart,
    trackCheckoutProgress,
    trackSearch,
    trackScroll,
  };
}
