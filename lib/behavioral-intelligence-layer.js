/**
 * behavioral-intelligence-layer.js (v2 — enterprise restructure)
 *
 * ENRICHMENT-ONLY LAYER for the OPE system.
 *
 * This module provides READ-ONLY behavioral pattern detection:
 * - Hesitation patterns
 * - Comparison behavior
 * - Return-risk prevention
 * - Impulsive vs analytical behavior
 *
 * ARCHITECTURAL CONTRACT (enterprise restructure):
 *   - This module does NOT determine intent state. Intent is determined
 *     exclusively by unified-intent-engine.js.
 *   - This module provides ENRICHMENT signals (micro-intentions, hesitation
 *     score, comparison depth, return risk) that are read-only context for
 *     consumers (e.g., message ranking, intervention policy).
 *   - Consumers may use these signals to MODULATE messages, but never
 *     to override the authoritative intent state.
 *
 * Architecture:
 * - Pure functions for determinism
 * - No side effects on intent state
 * - Replay-safe (explicit timestamps)
 * - Bounded memory (LRU eviction, all histories capped)
 */

'use strict';

const { INTENT_STATES } = require('./ope-constants');

// ----------------------------------------------------------------------
// Constants & Configuration
// ----------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// Micro-intention states (extends existing intent states)
const MICRO_INTENTIONS = Object.freeze({
  // Hesitation patterns
  HESITATING: 'hesitating',
  COMPARING: 'comparing',
  UNCERTAIN: 'uncertain',
  HIGH_INTENT_LOW_CONFIDENCE: 'high_intent_low_confidence',
  
  // Decision patterns
  IMPULSIVE: 'impulsive',
  ANALYTICAL: 'analytical',
  EXPLORATORY: 'exploratory',
  
  // Risk patterns
  RETURN_RISK_HIGH: 'return_risk_high',
  RETURN_RISK_MEDIUM: 'return_risk_medium',
  RETURN_RISK_LOW: 'return_risk_low',
  
  // Confidence patterns
  CONFIDENT_BUYER: 'confident_buyer',
  NEEDS_REASSURANCE: 'needs_reassurance',
  PRICE_SENSITIVE: 'price_sensitive',
});

// Thresholds for pattern detection
const THRESHOLDS = Object.freeze({
  // Hesitation detection
  MODAL_REOPEN_HESITATION: 2,           // reopens to consider hesitating
  MODAL_REOPEN_HIGH_HESITATION: 4,      // reopens for high hesitation
  HOVER_WITHOUT_CLICK_MS: 3000,         // prolonged hover without click
  SCROLL_OSCILLATION_COUNT: 3,          // up/down scroll pattern
  DWELL_WITHOUT_ACTION_MS: 8000,        // long dwell without add-to-cart
  PRODUCT_REVISIT_COUNT: 2,             // times returning to same product
  
  // Comparison detection
  SIMILAR_PRODUCTS_VIEWED: 3,           // products in same category
  VARIANT_SWITCH_COUNT: 3,              // variant changes for comparison
  CATEGORY_RETURN_COUNT: 2,             // returns to same category
  PRICE_COMPARISON_WINDOW_MS: 60000,    // time window for price comparison
  
  // Return-risk detection
  FAST_ADD_TO_CART_MS: 2000,            // too fast = impulsive
  SHALLOW_BROWSE_PRODUCTS: 2,           // few products viewed
  LOW_DETAIL_ENGAGEMENT_MS: 1500,       // not reading details
  VARIANT_CHURN_COUNT: 4,               // excessive variant switching
  QUICK_ABANDON_AFTER_ADD_MS: 5000,     // abandon quickly after add
  
  // Confidence thresholds
  HIGH_CONFIDENCE: 0.75,
  MEDIUM_CONFIDENCE: 0.50,
  LOW_CONFIDENCE: 0.30,
});

// Pattern weights for scoring
const PATTERN_WEIGHTS = Object.freeze({
  // Hesitation signals
  modalReopen: 0.25,
  hoverWithoutClick: 0.15,
  scrollOscillation: 0.20,
  dwellWithoutAction: 0.15,
  productRevisit: 0.25,
  
  // Comparison signals
  similarProductsViewed: 0.30,
  variantSwitching: 0.25,
  categoryReturns: 0.25,
  priceChecking: 0.20,
  
  // Return-risk signals
  fastAddToCart: 0.30,
  shallowBrowse: 0.25,
  lowDetailEngagement: 0.25,
  variantChurn: 0.10,
  quickAbandon: 0.10,
});

// Message priorities by micro-intention
const MESSAGE_PRIORITIES = Object.freeze({
  [MICRO_INTENTIONS.RETURN_RISK_HIGH]: {
    families: ['compatibility', 'quality', 'reassurance', 'expertise'],
    urgency: 'suppress', // NO urgency messages
    priority: 'clarity_first',
  },
  [MICRO_INTENTIONS.HESITATING]: {
    families: ['reassurance', 'social', 'quality', 'compatibility'],
    urgency: 'soft', // soft urgency only
    priority: 'confidence_building',
  },
  [MICRO_INTENTIONS.COMPARING]: {
    families: ['comparison', 'benefit', 'expertise', 'quality'],
    urgency: 'none',
    priority: 'differentiation',
  },
  [MICRO_INTENTIONS.UNCERTAIN]: {
    families: ['reassurance', 'compatibility', 'expertise', 'social'],
    urgency: 'suppress',
    priority: 'doubt_resolution',
  },
  [MICRO_INTENTIONS.HIGH_INTENT_LOW_CONFIDENCE]: {
    families: ['reassurance', 'social', 'quality'],
    urgency: 'soft',
    priority: 'final_push',
  },
  [MICRO_INTENTIONS.IMPULSIVE]: {
    families: ['compatibility', 'quality', 'expertise'],
    urgency: 'suppress', // Critical: no urgency for impulsive buyers
    priority: 'return_prevention',
  },
  [MICRO_INTENTIONS.ANALYTICAL]: {
    families: ['expertise', 'comparison', 'quality', 'compatibility'],
    urgency: 'none',
    priority: 'deep_info',
  },
  [MICRO_INTENTIONS.CONFIDENT_BUYER]: {
    families: ['benefit', 'lifestyle', 'social'],
    urgency: 'soft',
    priority: 'reinforce_decision',
  },
  [MICRO_INTENTIONS.NEEDS_REASSURANCE]: {
    families: ['reassurance', 'social', 'quality', 'compatibility'],
    urgency: 'suppress',
    priority: 'trust_building',
  },
});

// ----------------------------------------------------------------------
// Session Pattern Store (bounded memory)
// ----------------------------------------------------------------------

const MAX_SESSIONS = 1000;
const MAX_PRODUCT_HISTORY = 50;
const MAX_EVENT_HISTORY = 200;
const MAX_VARIANT_HISTORY = 100;
const MAX_MODAL_HISTORY = 50;
const MAX_CART_HISTORY = 100;
const MAX_SCROLL_HISTORY = 50;
const MAX_CATEGORY_HISTORY = 50;

class PatternStore {
  constructor() {
    this.sessions = new Map();
    this.sessionOrder = []; // LRU tracking
  }

  getSession(sessionId, nowMs) {
    // P1-6 fix: accept nowMs so session creation timestamps are replay-safe
    const ts = nowMs;
    if (typeof ts !== 'number') throw new Error('BIL.getSession requires explicit nowMs');
    if (!this.sessions.has(sessionId)) {
      this._evictIfNeeded();
      this.sessions.set(sessionId, this._createSession(ts));
    }
    this._touchSession(sessionId);
    return this.sessions.get(sessionId);
  }

  _createSession(nowMs) {
    const ts = nowMs;
    if (typeof ts !== 'number') throw new Error('BIL._createSession requires explicit nowMs');
    return {
      productHistory: [],
      categoryHistory: [],
      variantHistory: [],
      scrollHistory: [],
      modalHistory: [],
      cartHistory: [],
      patterns: {
        hesitation: null, comparison: null, returnRisk: null, buyerType: null, lastComputed: 0,
      },
      eventBuffer: [],
      createdAt: ts,
      lastActivity: ts,
    };
  }

  _touchSession(sessionId) {
    // P1-3 fix: O(1) LRU via access counter
    this._accessCount = (this._accessCount || 0) + 1;
    this._accessMap = this._accessMap || new Map();
    this._accessMap.set(sessionId, this._accessCount);
  }

  _evictIfNeeded() {
    if (this.sessions.size < MAX_SESSIONS) return;
    this._accessMap = this._accessMap || new Map();
    let minAccess = Infinity;
    let evictId = null;
    for (const [id, acc] of this._accessMap.entries()) {
      if (this.sessions.has(id) && acc < minAccess) { minAccess = acc; evictId = id; }
    }
    if (evictId) { this.sessions.delete(evictId); this._accessMap.delete(evictId); }
  }

  pruneSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    
    // Prune ALL histories to bounded size (P1-2 fix)
    if (session.productHistory.length > MAX_PRODUCT_HISTORY) {
      session.productHistory = session.productHistory.slice(-MAX_PRODUCT_HISTORY);
    }
    if (session.eventBuffer.length > MAX_EVENT_HISTORY) {
      session.eventBuffer = session.eventBuffer.slice(-MAX_EVENT_HISTORY);
    }
    if (session.variantHistory.length > MAX_VARIANT_HISTORY) {
      session.variantHistory = session.variantHistory.slice(-MAX_VARIANT_HISTORY);
    }
    if (session.modalHistory.length > MAX_MODAL_HISTORY) {
      session.modalHistory = session.modalHistory.slice(-MAX_MODAL_HISTORY);
    }
    if (session.cartHistory.length > MAX_CART_HISTORY) {
      session.cartHistory = session.cartHistory.slice(-MAX_CART_HISTORY);
    }
    if (session.scrollHistory.length > MAX_SCROLL_HISTORY) {
      session.scrollHistory = session.scrollHistory.slice(-MAX_SCROLL_HISTORY);
    }
    if (session.categoryHistory.length > MAX_CATEGORY_HISTORY) {
      session.categoryHistory = session.categoryHistory.slice(-MAX_CATEGORY_HISTORY);
    }
  }

  snapshot() {
    return {
      __schemaVersion: SCHEMA_VERSION,
      sessions: Array.from(this.sessions.entries()),
      sessionOrder: [...this.sessionOrder],
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.__schemaVersion !== SCHEMA_VERSION) return false;
    this.sessions = new Map(snapshot.sessions);
    this.sessionOrder = [...snapshot.sessionOrder];
    return true;
  }
}

// Global store instance
const patternStore = new PatternStore();

// ----------------------------------------------------------------------
// Event Recording
// ----------------------------------------------------------------------

/**
 * Record a behavioral event for pattern analysis.
 * @param {string} sessionId
 * @param {object} event - {type, productId, context, metadata, timestamp}
 * @param {number} nowMs - Explicit timestamp
 */
function recordEvent(sessionId, event, nowMs) {
  const session = patternStore.getSession(sessionId, nowMs);
  
  const normalizedEvent = {
    type: event.type,
    productId: event.productId || null,
    context: event.context || 'listing',
    metadata: event.metadata || {},
    timestamp: nowMs,
  };
  
  session.eventBuffer.push(normalizedEvent);
  session.lastActivity = nowMs;
  
  // Process specific event types
  switch (event.type) {
    case 'product_view':
    case 'product_hover':
    case 'dwell_tick':
      _recordProductInteraction(session, normalizedEvent, nowMs);
      break;
      
    case 'modal_open':
    case 'modal_close':
      _recordModalInteraction(session, normalizedEvent, nowMs);
      break;
      
    case 'variant_change':
      _recordVariantChange(session, normalizedEvent, nowMs);
      break;
      
    case 'cart_add':
    case 'cart_remove':
      _recordCartAction(session, normalizedEvent, nowMs);
      break;
      
    case 'scroll':
      _recordScroll(session, normalizedEvent, nowMs);
      break;
  }
  
  // Invalidate cached patterns
  session.patterns.lastComputed = 0;
  
  // Prune if needed
  patternStore.pruneSession(sessionId);
}

function _recordProductInteraction(session, event, nowMs) {
  const lastEntry = session.productHistory[session.productHistory.length - 1];
  
  if (lastEntry && lastEntry.productId === event.productId) {
    // P2-4 fix: accumulate dwell from dwell_tick metadata instead of time-since-first-seen.
    // time-since-first-seen inflates dwell when the user visits other products between revisits.
    const delta = event.metadata?.deltaMs || (event.type === 'dwell_tick' ? 1000 : 0);
    lastEntry.dwellMs = (lastEntry.dwellMs || 0) + delta;
    lastEntry.lastSeenAt = nowMs;
    lastEntry.actions.push({ type: event.type, timestamp: nowMs });
  } else {
    // New product entry — if it's a revisit, push a new entry (enables revisit detection)
    session.productHistory.push({
      productId: event.productId,
      timestamp: nowMs,
      lastSeenAt: nowMs,
      context: event.context,
      dwellMs: 0,
      actions: [{ type: event.type, timestamp: nowMs }],
      category: event.metadata?.category || null,
    });
  }
}

function _recordModalInteraction(session, event, nowMs) {
  if (event.type === 'modal_open') {
    const existing = session.modalHistory.find(m => m.productId === event.productId && !m.closeTime);
    if (existing) {
      // Reopen
      existing.reopenCount = (existing.reopenCount || 0) + 1;
      existing.lastOpenTime = nowMs;
    } else {
      session.modalHistory.push({
        productId: event.productId,
        openTime: nowMs,
        closeTime: null,
        reopenCount: 0,
        lastOpenTime: nowMs,
      });
    }
  } else if (event.type === 'modal_close') {
    const existing = session.modalHistory.find(m => m.productId === event.productId && !m.closeTime);
    if (existing) {
      existing.closeTime = nowMs;
    }
  }
}

function _recordVariantChange(session, event, nowMs) {
  session.variantHistory.push({
    productId: event.productId,
    variantId: event.metadata?.variantId,
    fromVariantId: event.metadata?.fromVariantId,
    timestamp: nowMs,
  });
}

function _recordCartAction(session, event, nowMs) {
  const lastProduct = session.productHistory.find(p => p.productId === event.productId);
  const dwellBeforeAdd = lastProduct ? (nowMs - lastProduct.timestamp) : null;
  
  session.cartHistory.push({
    productId: event.productId,
    action: event.type === 'cart_add' ? 'add' : 'remove',
    timestamp: nowMs,
    dwellBeforeAdd,
    variantId: event.metadata?.variantId,
  });
}

function _recordScroll(session, event, nowMs) {
  session.scrollHistory.push({
    direction: event.metadata?.direction || 'down',
    timestamp: nowMs,
    productId: event.productId,
    velocity: event.metadata?.velocity || 0,
  });
  
  // Keep only recent scrolls (last 30 seconds)
  const cutoff = nowMs - 30000;
  session.scrollHistory = session.scrollHistory.filter(s => s.timestamp > cutoff);
}

// ----------------------------------------------------------------------
// Pattern Detection
// ----------------------------------------------------------------------

/**
 * Analyze patterns for a session and return micro-intentions.
 * @param {string} sessionId
 * @param {string} productId - Current product context (optional)
 * @param {number} nowMs - Explicit timestamp
 * @returns {object} Pattern analysis result
 */
function analyzePatterns(sessionId, productId, nowMs) {
  const session = patternStore.getSession(sessionId);
  
  // Use cache if recent (within 500ms)
  if (session.patterns.lastComputed && nowMs - session.patterns.lastComputed < 500) {
    return session.patterns;
  }
  
  // Compute all patterns
  const hesitation = _detectHesitation(session, productId, nowMs);
  const comparison = _detectComparison(session, productId, nowMs);
  const returnRisk = _detectReturnRisk(session, productId, nowMs);
  const buyerType = _detectBuyerType(session, nowMs);
  
  // Determine primary micro-intention
  const microIntention = _determineMicroIntention(hesitation, comparison, returnRisk, buyerType);
  
  // Get message priorities
  const messagePriorities = MESSAGE_PRIORITIES[microIntention] || MESSAGE_PRIORITIES[MICRO_INTENTIONS.NEEDS_REASSURANCE];
  
  session.patterns = {
    hesitation,
    comparison,
    returnRisk,
    buyerType,
    microIntention,
    messagePriorities,
    confidence: _computeOverallConfidence(hesitation, comparison, returnRisk, buyerType),
    lastComputed: nowMs,
  };
  
  return session.patterns;
}

function _detectHesitation(session, productId, nowMs) {
  const signals = {
    modalReopens: 0,
    hoverWithoutClick: false,
    scrollOscillations: 0,
    dwellWithoutAction: 0,
    productRevisits: 0,
  };
  
  // Modal reopens for current product
  const modalEntry = session.modalHistory.find(m => m.productId === productId);
  if (modalEntry) {
    signals.modalReopens = modalEntry.reopenCount || 0;
  }
  
  // Scroll oscillation detection (up-down-up pattern)
  const recentScrolls = session.scrollHistory.filter(s => nowMs - s.timestamp < 10000);
  let oscillations = 0;
  for (let i = 2; i < recentScrolls.length; i++) {
    if (recentScrolls[i].direction !== recentScrolls[i-1].direction &&
        recentScrolls[i-1].direction !== recentScrolls[i-2].direction) {
      oscillations++;
    }
  }
  signals.scrollOscillations = oscillations;
  
  // Dwell without action
  const productEntry = session.productHistory.find(p => p.productId === productId);
  if (productEntry) {
    const hasCartAction = session.cartHistory.some(c => c.productId === productId);
    if (!hasCartAction && productEntry.dwellMs > THRESHOLDS.DWELL_WITHOUT_ACTION_MS) {
      signals.dwellWithoutAction = productEntry.dwellMs;
    }
  }
  
  // Product revisits
  const revisits = session.productHistory.filter(p => p.productId === productId).length;
  signals.productRevisits = Math.max(0, revisits - 1);
  
  // Compute hesitation score
  let score = 0;
  if (signals.modalReopens >= THRESHOLDS.MODAL_REOPEN_HESITATION) {
    score += PATTERN_WEIGHTS.modalReopen * Math.min(1, signals.modalReopens / THRESHOLDS.MODAL_REOPEN_HIGH_HESITATION);
  }
  if (signals.scrollOscillations >= THRESHOLDS.SCROLL_OSCILLATION_COUNT) {
    score += PATTERN_WEIGHTS.scrollOscillation;
  }
  if (signals.dwellWithoutAction > 0) {
    score += PATTERN_WEIGHTS.dwellWithoutAction * Math.min(1, signals.dwellWithoutAction / 15000);
  }
  if (signals.productRevisits >= THRESHOLDS.PRODUCT_REVISIT_COUNT) {
    score += PATTERN_WEIGHTS.productRevisit * Math.min(1, signals.productRevisits / 4);
  }
  
  return {
    detected: score >= 0.3,
    score: Math.min(1, score),
    signals,
    level: score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low',
  };
}

function _detectComparison(session, productId, nowMs) {
  const signals = {
    similarProductsViewed: 0,
    variantSwitches: 0,
    categoryReturns: 0,
    priceChecking: false,
  };
  
  // Products in same category (from last 5 minutes)
  const cutoff = nowMs - 300000;
  const currentProduct = session.productHistory.find(p => p.productId === productId);
  const currentCategory = currentProduct?.category;
  
  if (currentCategory) {
    const sameCategoryProducts = new Set(
      session.productHistory
        .filter(p => p.category === currentCategory && p.timestamp > cutoff)
        .map(p => p.productId)
    );
    signals.similarProductsViewed = sameCategoryProducts.size;
  }
  
  // Variant switches for current product
  const variantChanges = session.variantHistory.filter(
    v => v.productId === productId && v.timestamp > cutoff
  );
  signals.variantSwitches = variantChanges.length;
  
  // Category returns
  const categoryVisits = session.productHistory.filter(p => p.category === currentCategory);
  const uniqueVisits = new Map();
  categoryVisits.forEach(v => {
    const existing = uniqueVisits.get(v.category);
    if (!existing || v.timestamp > existing.timestamp + 60000) {
      uniqueVisits.set(v.category, v);
    }
  });
  signals.categoryReturns = Math.max(0, uniqueVisits.size - 1);
  
  // Compute comparison score
  let score = 0;
  if (signals.similarProductsViewed >= THRESHOLDS.SIMILAR_PRODUCTS_VIEWED) {
    score += PATTERN_WEIGHTS.similarProductsViewed * Math.min(1, signals.similarProductsViewed / 6);
  }
  if (signals.variantSwitches >= THRESHOLDS.VARIANT_SWITCH_COUNT) {
    score += PATTERN_WEIGHTS.variantSwitching * Math.min(1, signals.variantSwitches / 6);
  }
  if (signals.categoryReturns >= THRESHOLDS.CATEGORY_RETURN_COUNT) {
    score += PATTERN_WEIGHTS.categoryReturns;
  }
  
  return {
    detected: score >= 0.3,
    score: Math.min(1, score),
    signals,
    comparisonCluster: signals.similarProductsViewed >= 2 ? _getComparisonCluster(session, currentCategory) : null,
  };
}

function _getComparisonCluster(session, category) {
  const products = session.productHistory
    .filter(p => p.category === category)
    .map(p => p.productId);
  return [...new Set(products)];
}

function _detectReturnRisk(session, productId, nowMs) {
  const signals = {
    fastAddToCart: false,
    shallowBrowse: false,
    lowDetailEngagement: false,
    variantChurn: false,
    quickAbandon: false,
  };
  
  // Fast add to cart
  const cartAdd = session.cartHistory.find(c => c.productId === productId && c.action === 'add');
  if (cartAdd && cartAdd.dwellBeforeAdd !== null && cartAdd.dwellBeforeAdd < THRESHOLDS.FAST_ADD_TO_CART_MS) {
    signals.fastAddToCart = true;
  }
  
  // Shallow browse (few products viewed)
  const uniqueProducts = new Set(session.productHistory.map(p => p.productId));
  if (uniqueProducts.size <= THRESHOLDS.SHALLOW_BROWSE_PRODUCTS) {
    signals.shallowBrowse = true;
  }
  
  // Low detail engagement
  const productEntry = session.productHistory.find(p => p.productId === productId);
  if (productEntry && productEntry.dwellMs < THRESHOLDS.LOW_DETAIL_ENGAGEMENT_MS) {
    signals.lowDetailEngagement = true;
  }
  
  // Variant churn
  const variantChanges = session.variantHistory.filter(v => v.productId === productId);
  if (variantChanges.length >= THRESHOLDS.VARIANT_CHURN_COUNT) {
    signals.variantChurn = true;
  }
  
  // Quick abandon after add
  if (cartAdd) {
    const removeAfterAdd = session.cartHistory.find(
      c => c.productId === productId && 
           c.action === 'remove' && 
           c.timestamp > cartAdd.timestamp &&
           c.timestamp - cartAdd.timestamp < THRESHOLDS.QUICK_ABANDON_AFTER_ADD_MS
    );
    if (removeAfterAdd) {
      signals.quickAbandon = true;
    }
  }
  
  // Compute return risk score
  let score = 0;
  if (signals.fastAddToCart) score += PATTERN_WEIGHTS.fastAddToCart;
  if (signals.shallowBrowse) score += PATTERN_WEIGHTS.shallowBrowse;
  if (signals.lowDetailEngagement) score += PATTERN_WEIGHTS.lowDetailEngagement;
  if (signals.variantChurn) score += PATTERN_WEIGHTS.variantChurn;
  if (signals.quickAbandon) score += PATTERN_WEIGHTS.quickAbandon;
  
  let level;
  if (score >= 0.6) level = 'high';
  else if (score >= 0.35) level = 'medium';
  else level = 'low';
  
  return {
    detected: score >= 0.35,
    score: Math.min(1, score),
    signals,
    level,
    recommendation: _getReturnRiskRecommendation(level, signals),
  };
}

function _getReturnRiskRecommendation(level, signals) {
  if (level === 'high') {
    const issues = [];
    if (signals.fastAddToCart) issues.push('rapida_decision');
    if (signals.shallowBrowse) issues.push('poca_exploracion');
    if (signals.lowDetailEngagement) issues.push('sin_leer_detalles');
    if (signals.variantChurn) issues.push('indecision_variantes');
    
    return {
      action: 'show_clarity_messages',
      suppressUrgency: true,
      prioritizeFamilies: ['compatibility', 'quality', 'reassurance', 'expertise'],
      issues,
    };
  }
  
  if (level === 'medium') {
    return {
      action: 'soft_reassurance',
      suppressUrgency: true,
      prioritizeFamilies: ['reassurance', 'compatibility', 'quality'],
      issues: [],
    };
  }
  
  return {
    action: 'normal',
    suppressUrgency: false,
    prioritizeFamilies: null,
    issues: [],
  };
}

function _detectBuyerType(session, nowMs) {
  const totalProducts = session.productHistory.length;
  const totalDwell = session.productHistory.reduce((sum, p) => sum + (p.dwellMs || 0), 0);
  const avgDwell = totalProducts > 0 ? totalDwell / totalProducts : 0;
  
  const cartActions = session.cartHistory.length;
  const variantChanges = session.variantHistory.length;
  
  // Impulsive: fast adds, low dwell, few products viewed
  const impulsiveScore = (
    (avgDwell < 3000 ? 0.4 : 0) +
    (totalProducts < 3 ? 0.3 : 0) +
    (cartActions > 0 && avgDwell < 2000 ? 0.3 : 0)
  );
  
  // Analytical: high dwell, many variant changes, multiple products
  const analyticalScore = (
    (avgDwell > 8000 ? 0.4 : avgDwell > 5000 ? 0.2 : 0) +
    (variantChanges > 3 ? 0.3 : variantChanges > 1 ? 0.15 : 0) +
    (totalProducts > 4 ? 0.3 : totalProducts > 2 ? 0.15 : 0)
  );
  
  // Exploratory: many products, low to medium dwell, few cart actions
  const exploratoryScore = (
    (totalProducts > 5 ? 0.4 : totalProducts > 3 ? 0.2 : 0) +
    (avgDwell > 2000 && avgDwell < 6000 ? 0.3 : 0) +
    (cartActions === 0 ? 0.3 : 0)
  );
  
  let type;
  let score;
  if (impulsiveScore > analyticalScore && impulsiveScore > exploratoryScore) {
    type = 'impulsive';
    score = impulsiveScore;
  } else if (analyticalScore > exploratoryScore) {
    type = 'analytical';
    score = analyticalScore;
  } else {
    type = 'exploratory';
    score = exploratoryScore;
  }
  
  return {
    type,
    score: Math.min(1, score),
    metrics: {
      avgDwell,
      totalProducts,
      cartActions,
      variantChanges,
    },
  };
}

function _determineMicroIntention(hesitation, comparison, returnRisk, buyerType) {
  // Priority: Return risk > Hesitation > Comparison > Buyer type
  
  if (returnRisk.level === 'high') {
    return buyerType.type === 'impulsive' 
      ? MICRO_INTENTIONS.IMPULSIVE 
      : MICRO_INTENTIONS.RETURN_RISK_HIGH;
  }
  
  if (returnRisk.level === 'medium') {
    return MICRO_INTENTIONS.RETURN_RISK_MEDIUM;
  }
  
  if (hesitation.level === 'high') {
    return MICRO_INTENTIONS.HIGH_INTENT_LOW_CONFIDENCE;
  }
  
  if (hesitation.detected) {
    return MICRO_INTENTIONS.HESITATING;
  }
  
  if (comparison.detected) {
    return MICRO_INTENTIONS.COMPARING;
  }
  
  if (buyerType.type === 'analytical') {
    return MICRO_INTENTIONS.ANALYTICAL;
  }
  
  if (buyerType.type === 'exploratory') {
    return MICRO_INTENTIONS.EXPLORATORY;
  }
  
  return MICRO_INTENTIONS.NEEDS_REASSURANCE;
}

function _computeOverallConfidence(hesitation, comparison, returnRisk, buyerType) {
  // Weighted average of pattern confidences
  const weights = { hesitation: 0.3, comparison: 0.2, returnRisk: 0.3, buyerType: 0.2 };
  
  return (
    hesitation.score * weights.hesitation +
    comparison.score * weights.comparison +
    returnRisk.score * weights.returnRisk +
    buyerType.score * weights.buyerType
  );
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

module.exports = {
  // Constants
  MICRO_INTENTIONS,
  THRESHOLDS,
  MESSAGE_PRIORITIES,
  
  // Core functions
  recordEvent,
  analyzePatterns,
  
  // Store management
  getPatternStore: () => patternStore,
  
  // Snapshot/restore
  snapshot: () => patternStore.snapshot(),
  restore: (snap) => patternStore.restore(snap),
  
  // Helpers
  getMicroIntention: (sessionId, productId, nowMs) => {
    const patterns = analyzePatterns(sessionId, productId, nowMs);
    return patterns.microIntention;
  },
  
  getMessagePriorities: (sessionId, productId, nowMs) => {
    const patterns = analyzePatterns(sessionId, productId, nowMs);
    return patterns.messagePriorities;
  },
  
  shouldSuppressUrgency: (sessionId, productId, nowMs) => {
    const patterns = analyzePatterns(sessionId, productId, nowMs);
    return patterns.returnRisk?.level === 'high' || 
           patterns.returnRisk?.level === 'medium' ||
           patterns.microIntention === MICRO_INTENTIONS.UNCERTAIN;
  },
};
