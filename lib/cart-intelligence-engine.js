/**
 * cart-intelligence-engine.js
 *
 * Advanced cart behavioral intelligence for the OPE system.
 * Transforms the cart from a simple list to a behavioral context.
 *
 * Features:
 * - Individual message slots per product
 * - Cart type classification (impulsive, premium, exploratory, etc.)
 * - Product compatibility analysis
 * - Cross-sell intelligence
 * - Abandonment risk scoring
 * - Return risk prevention for cart items
 *
 * Message Rules:
 * - Each product has its own independent message slot
 * - Messages render INSIDE the product block, not floating
 * - Cart-level messages are separate from product-level
 * - No global floating messages
 *
 * Architecture:
 * - Pure functions for determinism
 * - Explicit timestamps
 * - Bounded memory
 */

'use strict';

const { INTENT_STATES, FUNNEL_STAGES } = require('./ope-constants');

const BehavioralIntelligence = require('./behavioral-intelligence-layer');

// ----------------------------------------------------------------------
// Constants & Configuration
// ----------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// Cart type classifications
const CART_TYPES = Object.freeze({
  IMPULSIVE: 'impulsive',           // Fast adds, low dwell
  PREMIUM: 'premium',               // High total value
  EXPLORATORY: 'exploratory',       // Many items, browsing behavior
  ABANDONABLE: 'abandonable',       // High abandonment risk signals
  INSECURE: 'insecure',             // Hesitation, uncertainty signals
  DECISIVE: 'decisive',             // Clear purchase intent
});

// Cart signal thresholds
const CART_THRESHOLDS = Object.freeze({
  // Impulsive cart
  FAST_ADD_WINDOW_MS: 30000,        // All adds within 30 seconds
  IMPULSIVE_AVG_DWELL_MS: 3000,     // Average dwell before add < 3s
  
  // Premium cart
  PREMIUM_VALUE_THRESHOLD: 200,     // Cart value > $200
  HIGH_PREMIUM_THRESHOLD: 500,      // Cart value > $500
  
  // Exploratory cart
  EXPLORATORY_ITEM_COUNT: 4,        // 4+ items
  HIGH_CATEGORY_DIVERSITY: 3,       // 3+ different categories
  
  // Abandonable signals
  LONG_CART_DWELL_MS: 120000,       // 2+ minutes in cart
  ITEM_REMOVE_COUNT: 2,             // 2+ items removed
  
  // Insecure signals
  VARIANT_CHANGE_IN_CART: 2,        // Changing variants after adding
  REOPEN_PRODUCT_FROM_CART: 2,      // Going back to product pages
});

// Message priorities by cart type
const CART_TYPE_PRIORITIES = Object.freeze({
  [CART_TYPES.IMPULSIVE]: {
    families: ['compatibility', 'quality', 'expertise', 'reassurance'],
    suppressUrgency: true,
    description: 'Reducir riesgo de devolucion, claridad maxima',
  },
  [CART_TYPES.PREMIUM]: {
    families: ['reassurance', 'quality', 'social', 'compatibility'],
    suppressUrgency: true,
    description: 'Seguridad maxima, confianza en la compra',
  },
  [CART_TYPES.EXPLORATORY]: {
    families: ['comparison', 'compatibility', 'benefit'],
    suppressUrgency: true,
    description: 'Ayudar a decidir, no presionar',
  },
  [CART_TYPES.ABANDONABLE]: {
    families: ['reassurance', 'social', 'compatibility'],
    suppressUrgency: false, // Soft urgency allowed
    description: 'Reducir abandono, reforzar decision',
  },
  [CART_TYPES.INSECURE]: {
    families: ['reassurance', 'compatibility', 'quality', 'expertise'],
    suppressUrgency: true,
    description: 'Eliminar dudas, clarificar',
  },
  [CART_TYPES.DECISIVE]: {
    families: ['social', 'benefit', 'lifestyle'],
    suppressUrgency: false,
    description: 'Reforzar decision, suave urgencia permitida',
  },
});

// Product-level message priorities for cart
const CART_PRODUCT_MESSAGES = Object.freeze({
  // Based on product position and characteristics
  first_item: {
    families: ['quality', 'compatibility'],
    priority: 'high',
  },
  high_value_item: {
    families: ['reassurance', 'quality', 'social'],
    priority: 'highest',
  },
  recently_added: {
    families: ['compatibility', 'benefit'],
    priority: 'medium',
  },
  duplicate_category: {
    families: ['comparison', 'compatibility'],
    priority: 'high',
  },
  variant_changed: {
    families: ['compatibility', 'expertise'],
    priority: 'high',
  },
});

// ----------------------------------------------------------------------
// Cart State Store
// ----------------------------------------------------------------------

const MAX_CARTS = 500;

class CartStore {
  constructor() {
    this.carts = new Map();
    this.cartOrder = [];
  }

  getCart(sessionId, nowMs) {
    // P1-6 fix: accept nowMs for replay-safe session creation
    const ts = nowMs;
    if (typeof ts !== 'number') throw new Error('CartStore.getCart requires explicit nowMs');
    if (!this.carts.has(sessionId)) {
      this._evictIfNeeded();
      this.carts.set(sessionId, this._createCart(ts));
    }
    this._touchCart(sessionId);
    return this.carts.get(sessionId);
  }

  _createCart(nowMs) {
    return {
      items: [],                    // [{productId, variantId, addedAt, dwellBeforeAdd, category, price}]
      removedItems: [],             // [{productId, variantId, removedAt, wasInCartMs}]
      
      // Cart signals
      signals: {
        totalValue: 0,
        itemCount: 0,
        uniqueCategories: new Set(),
        addTimestamps: [],
        variantChangesInCart: 0,
        productReopensFromCart: 0,
        cartDwellMs: 0,
        lastActivityAt: null,
      },
      
      // Classification
      cartType: null,
      cartTypeConfidence: 0,
      
      // Per-product message state
      productMessages: new Map(),   // productId -> {lastMessage, shownFamilies, cooldownUntil}
      
      // Cart-level message state
      cartMessage: null,
      cartMessageCooldownUntil: 0,
      
      // Metadata
      createdAt: nowMs,
      lastActivity: nowMs,
    };
  }

  _touchCart(sessionId) {
    // P1-3 fix: O(1) LRU via access counter instead of O(n) indexOf+splice
    this._accessCount = (this._accessCount || 0) + 1;
    this._accessMap = this._accessMap || new Map();
    this._accessMap.set(sessionId, this._accessCount);
  }

  _evictIfNeeded() {
    if (this.carts.size < MAX_CARTS) return;
    this._accessMap = this._accessMap || new Map();
    let minAccess = Infinity; let evictId = null;
    for (const [id, acc] of this._accessMap.entries()) {
      if (this.carts.has(id) && acc < minAccess) { minAccess = acc; evictId = id; }
    }
    if (evictId) { this.carts.delete(evictId); this._accessMap.delete(evictId); }
  }

  snapshot() {
    const cartsArray = [];
    for (const [id, cart] of this.carts.entries()) {
      cartsArray.push([id, {
        ...cart,
        signals: {
          ...cart.signals,
          uniqueCategories: Array.from(cart.signals.uniqueCategories),
        },
        productMessages: Array.from(cart.productMessages.entries()).map(([k,v]) => [k, v]),
      }]);
    }
    return {
      __schemaVersion: SCHEMA_VERSION,
      carts: cartsArray,
      cartOrder: [...this.cartOrder],
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.__schemaVersion !== SCHEMA_VERSION) return false;
    this.carts = new Map();
    for (const [id, cart] of snapshot.carts) {
      this.carts.set(id, {
        ...cart,
        signals: {
          ...cart.signals,
          uniqueCategories: new Set(cart.signals.uniqueCategories),
        },
        productMessages: new Map(Array.isArray(cart.productMessages) ? cart.productMessages : []),
      });
    }
    this.cartOrder = [...snapshot.cartOrder];
    return true;
  }
}

const cartStore = new CartStore();

// ----------------------------------------------------------------------
// Cart Event Processing
// ----------------------------------------------------------------------

/**
 * Process a cart-related event.
 * @param {string} sessionId
 * @param {object} event
 * @param {number} nowMs
 * @returns {object} Cart state update
 */
function processCartEvent(sessionId, event, nowMs) {
  const cart = cartStore.getCart(sessionId);
  
  switch (event.type) {
    case 'cart_add':
      _handleCartAdd(cart, event, nowMs);
      break;
      
    case 'cart_remove':
      _handleCartRemove(cart, event, nowMs);
      break;
      
    case 'cart_variant_change':
      _handleCartVariantChange(cart, event, nowMs);
      break;
      
    case 'cart_dwell':
      _handleCartDwell(cart, event, nowMs);
      break;
      
    case 'cart_product_reopen':
      _handleCartProductReopen(cart, event, nowMs);
      break;
  }
  
  // Update cart type classification
  _classifyCart(cart, sessionId, nowMs);
  
  cart.lastActivity = nowMs;
  
  return {
    cartType: cart.cartType,
    cartTypeConfidence: cart.cartTypeConfidence,
    itemCount: cart.items.length,
    totalValue: cart.signals.totalValue,
    priorities: CART_TYPE_PRIORITIES[cart.cartType],
  };
}

function _handleCartAdd(cart, event, nowMs) {
  const { productId, variantId, category, price, dwellBeforeAdd } = event.metadata || {};
  
  cart.items.push({
    productId,
    variantId,
    addedAt: nowMs,
    dwellBeforeAdd: dwellBeforeAdd || 0,
    category: category || 'unknown',
    price: price || 0,
  });
  
  cart.signals.addTimestamps.push(nowMs);
  cart.signals.totalValue += price || 0;
  cart.signals.itemCount = cart.items.length;
  cart.signals.lastActivityAt = nowMs;
  
  if (category) {
    cart.signals.uniqueCategories.add(category);
  }
  
  // Initialize product message state
  if (!cart.productMessages.has(productId)) {
    cart.productMessages.set(productId, {
      lastMessage: null,
      shownFamilies: [],
      cooldownUntil: 0,
    });
  }
}

function _handleCartRemove(cart, event, nowMs) {
  const { productId, variantId } = event.metadata || {};
  
  const itemIndex = cart.items.findIndex(i => i.productId === productId);
  if (itemIndex > -1) {
    const removed = cart.items.splice(itemIndex, 1)[0];
    
    cart.removedItems.push({
      ...removed,
      removedAt: nowMs,
      wasInCartMs: nowMs - removed.addedAt,
    });
    
    cart.signals.totalValue -= removed.price || 0;
    cart.signals.itemCount = cart.items.length;
    cart.signals.lastActivityAt = nowMs;
  }
}

function _handleCartVariantChange(cart, event, nowMs) {
  cart.signals.variantChangesInCart++;
  cart.signals.lastActivityAt = nowMs;
}

function _handleCartDwell(cart, event, nowMs) {
  const deltaMs = event.metadata?.deltaMs || 1000;
  cart.signals.cartDwellMs += deltaMs;
  cart.signals.lastActivityAt = nowMs;
}

function _handleCartProductReopen(cart, event, nowMs) {
  cart.signals.productReopensFromCart++;
  cart.signals.lastActivityAt = nowMs;
}

// ----------------------------------------------------------------------
// Cart Classification
// ----------------------------------------------------------------------

function _classifyCart(cart, sessionId, nowMs) {
  const signals = cart.signals;
  const scores = {};
  
  // Impulsive cart score
  scores.impulsive = _scoreImpulsiveCart(cart, signals, nowMs);
  
  // Premium cart score
  scores.premium = _scorePremiumCart(signals);
  
  // Exploratory cart score
  scores.exploratory = _scoreExploratoryCart(cart, signals);
  
  // Abandonable cart score
  scores.abandonable = _scoreAbandonableCart(cart, signals, nowMs);
  
  // Insecure cart score
  scores.insecure = _scoreInsecureCart(signals);
  
  // Decisive cart score
  scores.decisive = _scoreDecisiveCart(cart, signals, sessionId, nowMs);
  
  // Find highest score
  let maxType = CART_TYPES.DECISIVE;
  let maxScore = 0;
  
  for (const [type, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxType = type;
    }
  }
  
  cart.cartType = maxType;
  cart.cartTypeConfidence = Math.min(1, maxScore);
}

function _scoreImpulsiveCart(cart, signals, nowMs) {
  if (cart.items.length === 0) return 0;
  
  let score = 0;
  
  // Check if all adds were within a short window
  if (signals.addTimestamps.length > 1) {
    const span = Math.max(...signals.addTimestamps) - Math.min(...signals.addTimestamps);
    if (span < CART_THRESHOLDS.FAST_ADD_WINDOW_MS) {
      score += 0.4;
    }
  }
  
  // Check average dwell before add
  const avgDwell = cart.items.reduce((sum, i) => sum + (i.dwellBeforeAdd || 0), 0) / cart.items.length;
  if (avgDwell < CART_THRESHOLDS.IMPULSIVE_AVG_DWELL_MS) {
    score += 0.4;
  }
  
  // Low category diversity for impulsive
  if (signals.uniqueCategories.size === 1) {
    score += 0.2;
  }
  
  return score;
}

function _scorePremiumCart(signals) {
  if (signals.totalValue >= CART_THRESHOLDS.HIGH_PREMIUM_THRESHOLD) {
    return 0.9;
  }
  if (signals.totalValue >= CART_THRESHOLDS.PREMIUM_VALUE_THRESHOLD) {
    return 0.7;
  }
  return 0;
}

function _scoreExploratoryCart(cart, signals) {
  let score = 0;
  
  if (cart.items.length >= CART_THRESHOLDS.EXPLORATORY_ITEM_COUNT) {
    score += 0.5;
  }
  
  if (signals.uniqueCategories.size >= CART_THRESHOLDS.HIGH_CATEGORY_DIVERSITY) {
    score += 0.4;
  }
  
  return score;
}

function _scoreAbandonableCart(cart, signals, nowMs) {
  let score = 0;
  
  if (signals.cartDwellMs > CART_THRESHOLDS.LONG_CART_DWELL_MS) {
    score += 0.4;
  }
  
  if (cart.removedItems.length >= CART_THRESHOLDS.ITEM_REMOVE_COUNT) {
    score += 0.4;
  }
  
  // No recent activity
  if (signals.lastActivityAt && nowMs - signals.lastActivityAt > 60000) {
    score += 0.2;
  }
  
  return score;
}

function _scoreInsecureCart(signals) {
  let score = 0;
  
  if (signals.variantChangesInCart >= CART_THRESHOLDS.VARIANT_CHANGE_IN_CART) {
    score += 0.5;
  }
  
  if (signals.productReopensFromCart >= CART_THRESHOLDS.REOPEN_PRODUCT_FROM_CART) {
    score += 0.4;
  }
  
  return score;
}

function _scoreDecisiveCart(cart, signals, sessionId, nowMs) {
  // P2-1 fix: guard against BehavioralIntelligence unavailable — never default to decisive on error
  let patterns = null;
  if (BehavioralIntelligence && typeof BehavioralIntelligence.analyzePatterns === 'function') {
    try {
      patterns = BehavioralIntelligence.analyzePatterns(sessionId, null, nowMs);
    } catch (_) {
      // neutral on error
    }
  }
  
  if (patterns) {
    if (patterns.hesitation?.detected) return 0;
    if (patterns.returnRisk?.level === 'high') return 0;
  }
  
  // Has items, no removes, reasonable dwell
  if (cart.items.length > 0 && cart.removedItems.length === 0) {
    return 0.6;
  }
  
  return 0.3;
}

// ----------------------------------------------------------------------
// Per-Product Message Management
// ----------------------------------------------------------------------

/**
 * Get message state for a specific product in cart.
 * @param {string} sessionId
 * @param {string} productId
 * @returns {object} Product message state
 */
function getProductMessageState(sessionId, productId) {
  const cart = cartStore.getCart(sessionId);
  
  if (!cart.productMessages.has(productId)) {
    cart.productMessages.set(productId, {
      lastMessage: null,
      shownFamilies: [],
      cooldownUntil: 0,
    });
  }
  
  return cart.productMessages.get(productId);
}

/**
 * Check if a product can show a message.
 * @param {string} sessionId
 * @param {string} productId
 * @param {number} nowMs
 * @returns {object} {allowed, reason}
 */
function canShowProductMessage(sessionId, productId, nowMs) {
  const state = getProductMessageState(sessionId, productId);
  
  if (nowMs < state.cooldownUntil) {
    return { allowed: false, reason: 'product_cooldown' };
  }
  
  // Max 3 different families shown per product
  if (state.shownFamilies.length >= 3) {
    return { allowed: false, reason: 'family_limit_reached' };
  }
  
  return { allowed: true, reason: null };
}

/**
 * Record that a message was shown for a product.
 * @param {string} sessionId
 * @param {string} productId
 * @param {object} message
 * @param {number} nowMs
 */
function recordProductMessage(sessionId, productId, message, nowMs) {
  const state = getProductMessageState(sessionId, productId);
  
  state.lastMessage = {
    family: message.family,
    content: message.content,
    shownAt: nowMs,
  };
  
  if (!state.shownFamilies.includes(message.family)) {
    state.shownFamilies.push(message.family);
  }
  
  // Set cooldown (15 seconds per product)
  state.cooldownUntil = nowMs + 15000;
}

/**
 * Get message priorities for a specific product in cart.
 * @param {string} sessionId
 * @param {string} productId
 * @param {number} nowMs
 * @returns {object} Message priorities
 */
function getProductMessagePriorities(sessionId, productId, nowMs) {
  const cart = cartStore.getCart(sessionId);
  const item = cart.items.find(i => i.productId === productId);
  
  if (!item) {
    return CART_PRODUCT_MESSAGES.recently_added;
  }
  
  // Check product characteristics
  const isHighValue = item.price >= 100;
  const isFirstItem = cart.items[0]?.productId === productId;
  const hasDuplicateCategory = cart.items.filter(i => i.category === item.category).length > 1;
  
  if (isHighValue) {
    return CART_PRODUCT_MESSAGES.high_value_item;
  }
  
  if (hasDuplicateCategory) {
    return CART_PRODUCT_MESSAGES.duplicate_category;
  }
  
  if (isFirstItem) {
    return CART_PRODUCT_MESSAGES.first_item;
  }
  
  return CART_PRODUCT_MESSAGES.recently_added;
}

// ----------------------------------------------------------------------
// Cart Compatibility Analysis
// ----------------------------------------------------------------------

/**
 * Analyze compatibility between cart items.
 * @param {string} sessionId
 * @returns {object} Compatibility analysis
 */
function analyzeCartCompatibility(sessionId) {
  const cart = cartStore.getCart(sessionId);
  
  if (cart.items.length < 2) {
    return { compatible: true, issues: [], suggestions: [] };
  }
  
  const issues = [];
  const suggestions = [];
  
  // Check for duplicate categories (potential comparison)
  const categoryGroups = {};
  cart.items.forEach(item => {
    if (!categoryGroups[item.category]) {
      categoryGroups[item.category] = [];
    }
    categoryGroups[item.category].push(item);
  });
  
  for (const [category, items] of Object.entries(categoryGroups)) {
    if (items.length > 1) {
      issues.push({
        type: 'duplicate_category',
        category,
        productIds: items.map(i => i.productId),
        message: `Multiples productos de ${category}`,
      });
    }
  }
  
  // Suggest combinations
  if (cart.signals.uniqueCategories.size > 1) {
    suggestions.push({
      type: 'good_combination',
      message: 'Buena combinacion de productos',
    });
  }
  
  return {
    compatible: issues.length === 0,
    issues,
    suggestions,
    itemCount: cart.items.length,
    totalValue: cart.signals.totalValue,
  };
}

// ----------------------------------------------------------------------
// Cart Analytics
// ----------------------------------------------------------------------

/**
 * Get full cart analytics.
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {object} Cart analytics
 */
function getCartAnalytics(sessionId, nowMs) {
  const cart = cartStore.getCart(sessionId);
  
  return {
    cartType: cart.cartType,
    cartTypeConfidence: cart.cartTypeConfidence,
    priorities: CART_TYPE_PRIORITIES[cart.cartType],
    
    items: cart.items.map(i => ({
      productId: i.productId,
      category: i.category,
      price: i.price,
      inCartMs: nowMs - i.addedAt,
      messageState: cart.productMessages.get(i.productId),
    })),
    
    signals: {
      ...cart.signals,
      uniqueCategories: Array.from(cart.signals.uniqueCategories),
    },
    
    removedItems: cart.removedItems.length,
    compatibility: analyzeCartCompatibility(sessionId),
  };
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

module.exports = {
  // Constants
  CART_TYPES,
  CART_TYPE_PRIORITIES,
  CART_PRODUCT_MESSAGES,
  
  // Core functions
  processCartEvent,
  
  // Product message management
  getProductMessageState,
  canShowProductMessage,
  recordProductMessage,
  getProductMessagePriorities,
  
  // Compatibility
  analyzeCartCompatibility,
  
  // Analytics
  getCartAnalytics,
  
  // Store management
  getCart: (sessionId, nowMs) => cartStore.getCart(sessionId, nowMs),
  snapshot: () => cartStore.snapshot(),
  restore: (snap) => cartStore.restore(snap),
};
