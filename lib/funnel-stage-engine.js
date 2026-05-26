/**
 * funnel-stage-engine.js (v2 — enterprise restructure)
 *
 * Explicit funnel stage management for the OPE system.
 * Tracks user journey through purchase funnel with automatic transitions.
 *
 * Stages:
 * - DISCOVERY: Initial exploration, browsing products
 * - CONSIDERATION: Showing interest, viewing details
 * - EVALUATION: Deep engagement, comparing options
 * - PURCHASE_INTENT: High intent, considering purchase
 * - CART_REVIEW: Items in cart, reviewing decision
 * - CHECKOUT_READY: Ready to complete purchase
 * - POST_CART_HESITATION: Hesitating after cart action
 *
 * Enterprise restructure changes (v2):
 *   - P0-4 FIX: _createSession requires explicit nowMs (no Date.now())
 *   - P0-5 FIX: metrics reset on stage transition (per-stage accumulation)
 *   - P0-6 FIX: Hysteresis system with confidence thresholds, stabilization
 *     windows, and minimum dwell before escalation.
 *   - P1-5 FIX: Backward transitions supported (POST_CART_HESITATION ->
 *     EVALUATION or CONSIDERATION when user continues browsing after cart remove).
 *   - STAGE_MESSAGE_PRIORITIES uses unified UPPERCASE families from ope-constants.
 *   - stageHistory is bounded to 50 entries (memory safety).
 *   - LRU eviction uses O(1) access counter.
 *
 * Architecture:
 * - Pure functions for determinism
 * - Explicit timestamps for replay safety (NO Date.now())
 * - Bounded memory with LRU eviction
 */

'use strict';

const { FUNNEL_STAGES: _OPE_FUNNEL_STAGES, STAGE_MESSAGE_CONFIG } = require('./ope-constants');

// ----------------------------------------------------------------------
// Constants & Configuration
// ----------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// Funnel stages (ordered by progression)
const FUNNEL_STAGES = Object.freeze({
  DISCOVERY: 'discovery',
  CONSIDERATION: 'consideration',
  EVALUATION: 'evaluation',
  PURCHASE_INTENT: 'purchase_intent',
  CART_REVIEW: 'cart_review',
  CHECKOUT_READY: 'checkout_ready',
  POST_CART_HESITATION: 'post_cart_hesitation',
});

// Stage progression order (for forward/backward detection)
const STAGE_ORDER = Object.freeze([
  FUNNEL_STAGES.DISCOVERY,
  FUNNEL_STAGES.CONSIDERATION,
  FUNNEL_STAGES.EVALUATION,
  FUNNEL_STAGES.PURCHASE_INTENT,
  FUNNEL_STAGES.CART_REVIEW,
  FUNNEL_STAGES.CHECKOUT_READY,
]);

// Stage transition thresholds
const TRANSITION_THRESHOLDS = Object.freeze({
  // Discovery -> Consideration
  discoveryToConsideration: {
    minDwellMs: 3000,
    minProductsViewed: 2,
    orModalOpen: true,
  },
  
  // Consideration -> Evaluation
  considerationToEvaluation: {
    minDwellMs: 8000,
    minVariantChanges: 1,
    minModalDwellMs: 5000,
    orMultipleProductViews: 3,
  },
  
  // Evaluation -> Purchase Intent
  evaluationToPurchaseIntent: {
    minCtaHovers: 2,
    minDwellMs: 12000,
    orHighConfidenceSignal: true,
  },
  
  // Purchase Intent -> Cart Review
  purchaseIntentToCartReview: {
    cartItemAdded: true,
  },
  
  // Cart Review -> Checkout Ready
  cartReviewToCheckoutReady: {
    minCartDwellMs: 10000,
    noCartRemoves: true,
    orCheckoutHover: true,
  },
  
  // Any stage -> Post Cart Hesitation
  toPostCartHesitation: {
    cartRemoveAfterAdd: true,
    orLongCartDwell: 30000,
    orRepeatedVariantChanges: 3,
  },
});

// ---------------------------------------------------------------------------
// HYSTERESIS CONFIGURATION (P0-6 fix)
// Prevents funnel flickering by requiring confidence thresholds and
// minimum stabilization windows before transitions execute.
// ---------------------------------------------------------------------------
const HYSTERESIS = Object.freeze({
  // Minimum ms the user must remain in a stage before any forward transition
  minDwellBeforeTransitionMs: 2000,

  // After a backward transition, minimum ms before any new forward transition
  stabilizationWindowMs: 5000,

  // For POST_CART_HESITATION: minimum ms between cart_add and cart_remove
  // to qualify as real hesitation (vs. accidental tap)
  minHesitationGapMs: 3000,

  // ---- P2-STAB: Oscillation prevention for rapid add/remove ----
  // If the user does N cart add/remove cycles within a window, lock the stage
  oscillationDetection: Object.freeze({
    maxCyclesInWindow: 3,        // 3 add/remove cycles = oscillating
    windowMs: 30000,             // within 30s
    lockoutMs: 10000,            // lock stage for 10s after detection
  }),

  // ---- P2-STAB: Confidence accumulation ----
  // Transitions require accumulating N qualifying signals before firing.
  // Each qualifying event increments confidence by 1.
  // Confidence resets when the pending transition target changes.
  confidenceThresholds: Object.freeze({
    discoveryToConsideration:    1,  // 1 qualifying signal set
    considerationToEvaluation:   1,
    evaluationToPurchaseIntent:  2,  // Require 2 qualifying signals
    purchaseIntentToCartReview:  1,  // Cart add is definitive
    cartReviewToCheckoutReady:   2,  // Require 2 signals (dwell + hover)
    toPostCartHesitation:        1,  // But gated by minHesitationGapMs
  }),

  // ---- P2-STAB: Timing validation ----
  // Minimum ms of consistent signal before a transition is accepted.
  // This prevents transitions triggered by single-frame events.
  minConsistentSignalMs: 500,
});

// Message priorities by stage — uses CANONICAL families from ope-constants
const STAGE_MESSAGE_PRIORITIES = Object.freeze({
  [FUNNEL_STAGES.DISCOVERY]: {
    families: ['BENEFIT', 'LIFESTYLE', 'SOCIAL_PROOF'],
    intensity: 'low',
    maxPerSession: 2,
    cooldownMs: 20000,
    description: 'Exploracion suave, diferenciacion, social proof ligero',
  },
  
  [FUNNEL_STAGES.CONSIDERATION]: {
    families: ['BENEFIT', 'QUALITY', 'COMPARISON', 'EXPERTISE'],
    intensity: 'medium',
    maxPerSession: 3,
    cooldownMs: 15000,
    description: 'Beneficios claros, calidad, comparacion sutil',
  },
  
  [FUNNEL_STAGES.EVALUATION]: {
    families: ['EXPERTISE', 'COMPATIBILITY', 'QUALITY', 'COMPARISON'],
    intensity: 'medium',
    maxPerSession: 4,
    cooldownMs: 12000,
    description: 'Especificaciones, compatibilidad, fit',
  },
  
  [FUNNEL_STAGES.PURCHASE_INTENT]: {
    families: ['REASSURANCE', 'SOCIAL_PROOF', 'URGENCY'],
    intensity: 'medium-high',
    maxPerSession: 3,
    cooldownMs: 10000,
    description: 'Urgencia suave, reassurance, friccion minima',
  },
  
  [FUNNEL_STAGES.CART_REVIEW]: {
    families: ['COMPATIBILITY', 'REASSURANCE', 'SOCIAL_PROOF', 'QUALITY'],
    intensity: 'medium',
    maxPerSession: 3,
    cooldownMs: 15000,
    description: 'Compatibilidad, envio, devolucion, confianza final',
  },
  
  [FUNNEL_STAGES.CHECKOUT_READY]: {
    families: ['REASSURANCE', 'SOCIAL_PROOF'],
    intensity: 'low',
    maxPerSession: 1,
    cooldownMs: 30000,
    description: 'Solo reforzar decision, no interrumpir',
  },
  
  [FUNNEL_STAGES.POST_CART_HESITATION]: {
    families: ['REASSURANCE', 'COMPATIBILITY', 'QUALITY', 'EXPERTISE'],
    intensity: 'medium-high',
    maxPerSession: 4,
    cooldownMs: 8000,
    description: 'Eliminar dudas, reforzar decision, reducir abandono',
  },
});

// ----------------------------------------------------------------------
// Session Funnel State Store
// ----------------------------------------------------------------------

const MAX_SESSIONS = 1000;

class FunnelStore {
  constructor() {
    this.sessions = new Map();
    this.sessionOrder = []; // kept for snapshot compatibility
    this._accessMap = new Map();
    this._accessCount = 0;
  }

  getSession(sessionId, nowMs) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      throw new Error('[funnel-stage-engine] getSession: nowMs is required (determinism P0-4 fix).');
    }
    if (!this.sessions.has(sessionId)) {
      this._evictIfNeeded();
      this.sessions.set(sessionId, this._createSession(nowMs));
    }
    this._touchSession(sessionId);
    return this.sessions.get(sessionId);
  }

  _createSession(nowMs) {
    return {
      currentStage: FUNNEL_STAGES.DISCOVERY,
      stageHistory: [{
        stage: FUNNEL_STAGES.DISCOVERY,
        enteredAt: nowMs,
        reason: 'session_start',
      }],
      
      // Accumulated metrics for stage transitions
      // P0-5 FIX: these are now per-stage and reset on transition
      metrics: this._freshMetrics(),
      
      // Stage-specific message counts
      messagesByStage: {},
      
      // Hysteresis state (P0-6 FIX + P2-STAB enhancement)
      hysteresis: {
        lastTransitionAt: nowMs,
        lastBackwardTransitionAt: 0,
        transitionConfidence: 0,
        pendingTransition: null,       // target stage being accumulated
        pendingTransitionFirstSignalAt: 0,  // P2-STAB: when first signal arrived
        // P2-STAB: Oscillation detection for rapid add/remove
        cartCycles: [],                // timestamps of add/remove cycles
        oscillationLockUntil: 0,       // if >0, stage is locked until this timestamp
      },
      
      // Metadata
      createdAt: nowMs,
      lastActivity: nowMs,
    };
  }

  _freshMetrics() {
    return {
      totalDwellMs: 0,
      productsViewed: new Set(),
      modalOpens: 0,
      modalDwellMs: 0,
      variantChanges: 0,
      ctaHovers: 0,
      cartAdds: 0,
      cartRemoves: 0,
      cartDwellMs: 0,
      checkoutHovers: 0,
      lastCartAddTime: null,
      lastCartRemoveTime: null,
    };
  }

  _touchSession(sessionId) {
    // P1-3 fix: O(1) LRU via access counter instead of O(n) indexOf+splice
    this._accessCount = (this._accessCount || 0) + 1;
    this._accessMap = this._accessMap || new Map();
    this._accessMap.set(sessionId, this._accessCount);
  }

  _evictIfNeeded() {
    // Evict the least-recently-accessed session
    if (this.sessions.size < MAX_SESSIONS) return;
    this._accessMap = this._accessMap || new Map();
    let minAccess = Infinity;
    let evictId = null;
    for (const [id, acc] of this._accessMap.entries()) {
      if (this.sessions.has(id) && acc < minAccess) {
        minAccess = acc;
        evictId = id;
      }
    }
    if (evictId) {
      this.sessions.delete(evictId);
      this._accessMap.delete(evictId);
    }
  }

  snapshot() {
    const sessionsArray = [];
    for (const [id, session] of this.sessions.entries()) {
      sessionsArray.push([id, {
        ...session,
        metrics: {
          ...session.metrics,
          productsViewed: Array.from(session.metrics.productsViewed),
        },
      }]);
    }
    return {
      __schemaVersion: SCHEMA_VERSION,
      sessions: sessionsArray,
      sessionOrder: [...this.sessionOrder],
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.__schemaVersion !== SCHEMA_VERSION) return false;
    this.sessions = new Map();
    for (const [id, session] of snapshot.sessions) {
      this.sessions.set(id, {
        ...session,
        metrics: {
          ...session.metrics,
          productsViewed: new Set(session.metrics.productsViewed),
        },
      });
    }
    this.sessionOrder = [...snapshot.sessionOrder];
    return true;
  }
}

const funnelStore = new FunnelStore();

// ----------------------------------------------------------------------
// Event Processing & Stage Transitions
// ----------------------------------------------------------------------

/**
 * Process an event and potentially transition funnel stage.
 * @param {string} sessionId
 * @param {object} event - Behavioral event
 * @param {number} nowMs - Explicit timestamp
 * @returns {object} Stage update result
 */
function processEvent(sessionId, event, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error('[funnel-stage-engine] processEvent: nowMs is required (determinism).');
  }
  const session = funnelStore.getSession(sessionId, nowMs);
  const previousStage = session.currentStage;
  
  // Update metrics based on event
  _updateMetrics(session, event, nowMs);
  
  // Check for stage transition (with hysteresis)
  const transition = _evaluateTransitionWithHysteresis(session, event, nowMs);
  
  if (transition.shouldTransition) {
    const isBackward = _isBackwardTransition(session.currentStage, transition.newStage);
    _transitionToStage(session, transition.newStage, transition.reason, nowMs, isBackward);
  }
  
  session.lastActivity = nowMs;
  
  return {
    previousStage,
    currentStage: session.currentStage,
    transitioned: previousStage !== session.currentStage,
    reason: transition.reason,
    metrics: { ...session.metrics, productsViewed: session.metrics.productsViewed.size },
    messagePriorities: STAGE_MESSAGE_PRIORITIES[session.currentStage],
    hysteresis: { ...session.hysteresis },
  };
}

function _updateMetrics(session, event, nowMs) {
  const m = session.metrics;
  
  switch (event.type) {
    case 'dwell_tick':
      m.totalDwellMs += event.metadata?.deltaMs || 1000;
      if (event.context === 'modal') {
        m.modalDwellMs += event.metadata?.deltaMs || 1000;
      }
      if (event.context === 'cart') {
        m.cartDwellMs += event.metadata?.deltaMs || 1000;
      }
      break;
      
    case 'product_view':
    case 'product_hover':
      if (event.productId) {
        m.productsViewed.add(event.productId);
      }
      break;
      
    case 'modal_open':
      m.modalOpens++;
      break;
      
    case 'variant_change':
      m.variantChanges++;
      break;
      
    case 'cta_hover':
      m.ctaHovers++;
      break;
      
    case 'cart_add':
      m.cartAdds++;
      m.lastCartAddTime = nowMs;
      break;
      
    case 'cart_remove':
      m.cartRemoves++;
      m.lastCartRemoveTime = nowMs;
      // P2-STAB: Track add/remove cycle for oscillation detection
      if (m.lastCartAddTime) {
        session.hysteresis.cartCycles.push(nowMs);
        // Prune old cycles outside the detection window
        const windowMs = HYSTERESIS.oscillationDetection.windowMs;
        session.hysteresis.cartCycles = session.hysteresis.cartCycles.filter(
          ts => nowMs - ts < windowMs
        );
        // Detect oscillation: too many cycles in window
        if (session.hysteresis.cartCycles.length >= HYSTERESIS.oscillationDetection.maxCyclesInWindow) {
          session.hysteresis.oscillationLockUntil = nowMs + HYSTERESIS.oscillationDetection.lockoutMs;
          session.hysteresis.cartCycles = []; // reset after lockout applied
        }
      }
      break;
      
    case 'checkout_hover':
      m.checkoutHovers++;
      break;
  }
}

function _evaluateTransitionWithHysteresis(session, event, nowMs) {
  const h = session.hysteresis;
  const timeSinceLastTransition = nowMs - h.lastTransitionAt;
  const timeSinceBackward = nowMs - h.lastBackwardTransitionAt;

  // P2-STAB GATE: Oscillation lockout — no transitions during lockout
  if (h.oscillationLockUntil > 0 && nowMs < h.oscillationLockUntil) {
    return { shouldTransition: false, newStage: session.currentStage, reason: 'oscillation_lockout' };
  }

  // HYSTERESIS GATE: Minimum dwell before any transition
  if (timeSinceLastTransition < HYSTERESIS.minDwellBeforeTransitionMs) {
    return { shouldTransition: false, newStage: session.currentStage, reason: 'hysteresis_min_dwell' };
  }

  // HYSTERESIS GATE: After a backward transition, require stabilization window
  if (h.lastBackwardTransitionAt > 0 && timeSinceBackward < HYSTERESIS.stabilizationWindowMs) {
    return { shouldTransition: false, newStage: session.currentStage, reason: 'hysteresis_stabilization' };
  }

  // Evaluate the raw transition (without hysteresis)
  const rawTransition = _evaluateRawTransition(session, event, nowMs);

  if (!rawTransition.shouldTransition) {
    // No qualifying signal: reset pending if target changed
    return rawTransition;
  }

  // P2-STAB: Confidence accumulation
  // If the raw transition target matches the pending transition target,
  // increment confidence; otherwise reset the accumulation.
  const transitionKey = _transitionKey(session.currentStage, rawTransition.newStage);
  const requiredConfidence = HYSTERESIS.confidenceThresholds[transitionKey] || 1;

  if (h.pendingTransition === rawTransition.newStage) {
    h.transitionConfidence++;
  } else {
    // New target: reset accumulation
    h.pendingTransition = rawTransition.newStage;
    h.transitionConfidence = 1;
    h.pendingTransitionFirstSignalAt = nowMs;
  }

  // P2-STAB: Timing validation — consistent signal must persist for minConsistentSignalMs
  const signalDuration = nowMs - h.pendingTransitionFirstSignalAt;
  if (signalDuration < HYSTERESIS.minConsistentSignalMs && requiredConfidence > 1) {
    return { shouldTransition: false, newStage: session.currentStage, reason: 'timing_validation_pending' };
  }

  // Check if confidence threshold met
  if (h.transitionConfidence < requiredConfidence) {
    return { shouldTransition: false, newStage: session.currentStage, reason: 'confidence_accumulating' };
  }

  // For POST_CART_HESITATION: apply hesitation gap check (P0-6)
  if (rawTransition.newStage === FUNNEL_STAGES.POST_CART_HESITATION) {
    const m = session.metrics;
    if (m.lastCartAddTime && m.lastCartRemoveTime) {
      const hesitationGap = m.lastCartRemoveTime - m.lastCartAddTime;
      if (hesitationGap < HYSTERESIS.minHesitationGapMs) {
        return { shouldTransition: false, newStage: session.currentStage, reason: 'hesitation_gap_too_short' };
      }
    }
  }

  // All gates passed: allow transition, reset pending
  h.pendingTransition = null;
  h.transitionConfidence = 0;
  h.pendingTransitionFirstSignalAt = 0;
  return rawTransition;
}

/**
 * P2-STAB: Map current->new stage pairs to confidence threshold keys.
 */
function _transitionKey(currentStage, newStage) {
  if (newStage === FUNNEL_STAGES.POST_CART_HESITATION) return 'toPostCartHesitation';
  const map = {
    [`${FUNNEL_STAGES.DISCOVERY}->${FUNNEL_STAGES.CONSIDERATION}`]: 'discoveryToConsideration',
    [`${FUNNEL_STAGES.CONSIDERATION}->${FUNNEL_STAGES.EVALUATION}`]: 'considerationToEvaluation',
    [`${FUNNEL_STAGES.EVALUATION}->${FUNNEL_STAGES.PURCHASE_INTENT}`]: 'evaluationToPurchaseIntent',
    [`${FUNNEL_STAGES.PURCHASE_INTENT}->${FUNNEL_STAGES.CART_REVIEW}`]: 'purchaseIntentToCartReview',
    [`${FUNNEL_STAGES.CART_REVIEW}->${FUNNEL_STAGES.CHECKOUT_READY}`]: 'cartReviewToCheckoutReady',
  };
  return map[`${currentStage}->${newStage}`] || null;
}

/**
 * Determine if a transition is backward in the funnel.
 */
function _isBackwardTransition(currentStage, newStage) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  const newIdx = STAGE_ORDER.indexOf(newStage);
  if (currentIdx === -1 || newIdx === -1) return false;
  return newIdx < currentIdx;
}

function _evaluateRawTransition(session, event, nowMs) {
  const m = session.metrics;
  const currentStage = session.currentStage;
  
  // ---------------------------------------------------------------------------
  // BACKWARD TRANSITIONS (P1-5 fix)
  // ---------------------------------------------------------------------------
  
  // POST_CART_HESITATION -> EVALUATION or CONSIDERATION
  // When user removes all cart items and continues browsing
  if (currentStage === FUNNEL_STAGES.POST_CART_HESITATION) {
    // If user re-adds to cart and hovers checkout, move to CHECKOUT_READY
    if (m.cartAdds > m.cartRemoves && m.checkoutHovers > 0) {
      return { shouldTransition: true, newStage: FUNNEL_STAGES.CHECKOUT_READY, reason: 'hesitation_resolved' };
    }
    // If user re-adds to cart (without checkout hover), move to CART_REVIEW
    if (m.cartAdds > m.cartRemoves && event.type === 'cart_add') {
      return { shouldTransition: true, newStage: FUNNEL_STAGES.CART_REVIEW, reason: 'cart_re_added' };
    }
    // If user continues browsing products (no cart), backward to EVALUATION
    if (m.cartAdds <= m.cartRemoves && m.productsViewed.size >= 2 && m.totalDwellMs >= 5000) {
      return { shouldTransition: true, newStage: FUNNEL_STAGES.EVALUATION, reason: 'browsing_after_hesitation' };
    }
  }

  // CART_REVIEW -> EVALUATION (user removes all items and browses)
  if (currentStage === FUNNEL_STAGES.CART_REVIEW && m.cartRemoves > 0 && m.cartAdds <= m.cartRemoves) {
    if (event.type === 'product_view' || event.type === 'product_hover') {
      return { shouldTransition: true, newStage: FUNNEL_STAGES.EVALUATION, reason: 'cart_emptied_browsing' };
    }
  }

  // ---------------------------------------------------------------------------
  // POST_CART_HESITATION detection (from any cart-active stage)
  // ---------------------------------------------------------------------------
  const hesitationThresholds = TRANSITION_THRESHOLDS.toPostCartHesitation;
  if (m.cartAdds > 0 && m.cartRemoves > 0 && m.lastCartRemoveTime > m.lastCartAddTime) {
    // Only transition if currently in a cart-related stage
    if (currentStage === FUNNEL_STAGES.CART_REVIEW || currentStage === FUNNEL_STAGES.PURCHASE_INTENT) {
      return {
        shouldTransition: true,
        newStage: FUNNEL_STAGES.POST_CART_HESITATION,
        reason: 'cart_remove_after_add',
      };
    }
  }
  
  if (currentStage === FUNNEL_STAGES.CART_REVIEW && m.cartDwellMs > hesitationThresholds.orLongCartDwell) {
    return {
      shouldTransition: true,
      newStage: FUNNEL_STAGES.POST_CART_HESITATION,
      reason: 'long_cart_dwell',
    };
  }
  
  // ---------------------------------------------------------------------------
  // FORWARD PROGRESSION
  // ---------------------------------------------------------------------------
  switch (currentStage) {
    case FUNNEL_STAGES.DISCOVERY: {
      const t = TRANSITION_THRESHOLDS.discoveryToConsideration;
      const modalWithDwell = m.modalOpens > 0 && m.totalDwellMs >= 1500;
      const dwellAndProducts = m.totalDwellMs >= t.minDwellMs && m.productsViewed.size >= t.minProductsViewed;
      if (modalWithDwell || dwellAndProducts) {
        return {
          shouldTransition: true,
          newStage: FUNNEL_STAGES.CONSIDERATION,
          reason: modalWithDwell ? 'modal_opened_with_dwell' : 'dwell_and_products',
        };
      }
      break;
    }
    
    case FUNNEL_STAGES.CONSIDERATION: {
      const t = TRANSITION_THRESHOLDS.considerationToEvaluation;
      if ((m.modalDwellMs >= t.minModalDwellMs && m.variantChanges >= t.minVariantChanges) ||
          m.productsViewed.size >= t.orMultipleProductViews) {
        return {
          shouldTransition: true,
          newStage: FUNNEL_STAGES.EVALUATION,
          reason: 'deep_engagement',
        };
      }
      break;
    }
    
    case FUNNEL_STAGES.EVALUATION: {
      const t = TRANSITION_THRESHOLDS.evaluationToPurchaseIntent;
      if (m.ctaHovers >= t.minCtaHovers || m.totalDwellMs >= t.minDwellMs) {
        return {
          shouldTransition: true,
          newStage: FUNNEL_STAGES.PURCHASE_INTENT,
          reason: m.ctaHovers >= t.minCtaHovers ? 'cta_engagement' : 'high_dwell',
        };
      }
      break;
    }
    
    case FUNNEL_STAGES.PURCHASE_INTENT: {
      if (m.cartAdds > 0) {
        return {
          shouldTransition: true,
          newStage: FUNNEL_STAGES.CART_REVIEW,
          reason: 'cart_add',
        };
      }
      break;
    }
    
    case FUNNEL_STAGES.CART_REVIEW: {
      const t = TRANSITION_THRESHOLDS.cartReviewToCheckoutReady;
      if (m.checkoutHovers > 0 || 
          (m.cartDwellMs >= t.minCartDwellMs && m.cartRemoves === 0)) {
        return {
          shouldTransition: true,
          newStage: FUNNEL_STAGES.CHECKOUT_READY,
          reason: m.checkoutHovers > 0 ? 'checkout_hover' : 'cart_review_complete',
        };
      }
      break;
    }
  }
  
  return { shouldTransition: false, newStage: currentStage, reason: null };
}

function _transitionToStage(session, newStage, reason, nowMs, isBackward = false) {
  session.stageHistory.push({
    stage: newStage,
    enteredAt: nowMs,
    reason,
    fromStage: session.currentStage,
    isBackward,
  });
  // Memory safety: cap stageHistory
  if (session.stageHistory.length > 50) {
    session.stageHistory = session.stageHistory.slice(-50);
  }
  
  session.currentStage = newStage;
  
  // P0-5 FIX: Reset stage-specific metrics on transition
  // Preserve cart state (cartAdds, cartRemoves, lastCartAddTime, lastCartRemoveTime)
  // since cart state is session-global, but reset engagement counters
  const oldMetrics = session.metrics;
  session.metrics = funnelStore._freshMetrics();
  // Carry over cart state (cart is session-global, not stage-specific)
  session.metrics.cartAdds = oldMetrics.cartAdds;
  session.metrics.cartRemoves = oldMetrics.cartRemoves;
  session.metrics.lastCartAddTime = oldMetrics.lastCartAddTime;
  session.metrics.lastCartRemoveTime = oldMetrics.lastCartRemoveTime;
  // Carry over productsViewed (cumulative)
  session.metrics.productsViewed = oldMetrics.productsViewed;
  
  // Reset stage-specific message count
  if (!session.messagesByStage[newStage]) {
    session.messagesByStage[newStage] = 0;
  }
  
  // Update hysteresis state
  session.hysteresis.lastTransitionAt = nowMs;
  session.hysteresis.transitionConfidence = 0;
  if (isBackward) {
    session.hysteresis.lastBackwardTransitionAt = nowMs;
  }
}

// ----------------------------------------------------------------------
// Query Functions
// ----------------------------------------------------------------------

/**
 * Get current funnel stage for a session.
 * @param {string} sessionId
 * @param {number} [nowMs] - Optional for reads (only required for creates)
 */
function getCurrentStage(sessionId, nowMs) {
  const session = funnelStore.getSession(sessionId, nowMs);
  if (typeof nowMs !== 'number') throw new Error('funnel-stage-engine.getCurrentStage requires explicit nowMs');
  return session.currentStage;
}

/**
 * Get message priorities for current stage.
 */
function getMessagePriorities(sessionId, nowMs) {
  const stage = getCurrentStage(sessionId, nowMs);
  return STAGE_MESSAGE_PRIORITIES[stage];
}

/**
 * Check if a message family is appropriate for current stage.
 */
function isFamilyAppropriate(sessionId, family, nowMs) {
  const priorities = getMessagePriorities(sessionId, nowMs);
  return priorities.families.includes(family);
}

/**
 * Check if we can show a message in current stage.
 */
function canShowMessage(sessionId, nowMs) {
  if (typeof nowMs !== 'number') {
    throw new Error('[funnel-stage-engine] canShowMessage: nowMs is required.');
  }
  const session = funnelStore.getSession(sessionId, nowMs);
  const stage = session.currentStage;
  const priorities = STAGE_MESSAGE_PRIORITIES[stage];
  
  // Check stage-specific limits
  const messageCount = session.messagesByStage[stage] || 0;
  if (messageCount >= priorities.maxPerSession) {
    return { allowed: false, reason: 'stage_limit_reached' };
  }
  
  // Check last message time in this stage
  const lastEntry = session.stageHistory[session.stageHistory.length - 1];
  const stageStartTime = lastEntry?.enteredAt || session.createdAt;
  
  return { allowed: true, reason: null };
}

/**
 * Record that a message was shown in current stage.
 */
function recordMessageShown(sessionId, family, nowMs) {
  if (typeof nowMs !== 'number') {
    throw new Error('[funnel-stage-engine] recordMessageShown: nowMs is required.');
  }
  const session = funnelStore.getSession(sessionId, nowMs);
  const stage = session.currentStage;
  
  if (!session.messagesByStage[stage]) {
    session.messagesByStage[stage] = 0;
  }
  session.messagesByStage[stage]++;
}

/**
 * Get funnel analytics for a session.
 */
function getFunnelAnalytics(sessionId, nowMs) {
  const session = funnelStore.getSession(sessionId, nowMs);
  if (typeof nowMs !== 'number') throw new Error('funnel-stage-engine.getFunnelAnalytics requires explicit nowMs');
  
  return {
    currentStage: session.currentStage,
    stageHistory: session.stageHistory,
    metrics: {
      ...session.metrics,
      productsViewed: session.metrics.productsViewed.size,
    },
    messagesByStage: session.messagesByStage,
    funnelProgress: _calculateFunnelProgress(session),
  };
}

function _calculateFunnelProgress(session) {
  const currentIndex = STAGE_ORDER.indexOf(session.currentStage);
  if (currentIndex === -1) {
    // Special stage (like POST_CART_HESITATION)
    return 0.8; // Treat as late-stage
  }
  return (currentIndex + 1) / STAGE_ORDER.length;
}

/**
 * Force transition to a specific stage (for testing/admin).
 */
function forceTransition(sessionId, newStage, nowMs) {
  if (typeof nowMs !== 'number') {
    throw new Error('[funnel-stage-engine] forceTransition: nowMs is required.');
  }
  if (!Object.values(FUNNEL_STAGES).includes(newStage)) {
    return { success: false, error: 'Invalid stage' };
  }
  
  const session = funnelStore.getSession(sessionId, nowMs);
  const isBackward = _isBackwardTransition(session.currentStage, newStage);
  _transitionToStage(session, newStage, 'forced', nowMs, isBackward);
  
  return { success: true, newStage };
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

module.exports = {
  // Constants
  FUNNEL_STAGES,
  STAGE_ORDER,
  STAGE_MESSAGE_PRIORITIES,
  HYSTERESIS,
  TRANSITION_THRESHOLDS,
  
  // Core functions
  processEvent,
  getCurrentStage,
  getMessagePriorities,
  isFamilyAppropriate,
  canShowMessage,
  recordMessageShown,
  getFunnelAnalytics,
  forceTransition,
  
  // Store management
  getStore: () => funnelStore,
  snapshot: () => funnelStore.snapshot(),
  restore: (snap) => funnelStore.restore(snap),
};
