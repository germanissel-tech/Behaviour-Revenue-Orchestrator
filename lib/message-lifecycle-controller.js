/**
 * message-lifecycle-controller.js
 *
 * Controls the complete lifecycle of OPE advisor messages.
 * Ensures messages appear and disappear naturally based on context.
 *
 * Features:
 * - Context-aware expiration (messages disappear on context change)
 * - Anti-repetition (same-message cooldown only — family/context fatigue delegated)
 * - Placement consistency enforcement
 * - Natural timing and pacing
 *
 * ARCHITECTURAL DECISION (v3 enterprise restructure):
 *   Fatigue authority is EXCLUSIVELY owned by cooldown-fatigue-engine.
 *   This controller no longer computes contextFatigue, family cooldowns,
 *   or per-context message limits independently.
 *   The canShowMessage() method checks same-message dedup only; all other
 *   fatigue/cooldown checks are delegated to cooldown-fatigue-engine via
 *   the session-orchestrator pipeline.
 *
 * Rules:
 * 1. Messages expire immediately when context changes
 * 2. Same-message dedup prevents exact repeats within a window
 * 3. Placement must be consistent per context type
 * 4. Messages feel natural, not intrusive
 *
 * Architecture:
 * - Pure functions for determinism
 * - Explicit timestamps
 * - Event-driven expiration
 * - Bounded memory
 */

'use strict';

// ----------------------------------------------------------------------
// Constants & Configuration
// ----------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// Message expiration triggers
const EXPIRATION_TRIGGERS = Object.freeze({
  CONTEXT_CHANGE: 'context_change',
  PRODUCT_CHANGE: 'product_change',
  MODAL_CLOSE: 'modal_close',
  CART_CHANGE: 'cart_change',
  STAGE_CHANGE: 'stage_change',
  TIMEOUT: 'timeout',
  USER_DISMISS: 'user_dismiss',
  NEW_MESSAGE: 'new_message',
});

// Context types for placement
const CONTEXT_PLACEMENTS = Object.freeze({
  listing: {
    position: 'inside_product_card',
    alignment: 'bottom',
    floating: false,
    maxMessages: 1,
  },
  modal: {
    position: 'below_cta',
    alignment: 'center',
    floating: false,
    maxMessages: 1,
  },
  cart: {
    position: 'inside_product_block',
    alignment: 'bottom',
    floating: false,
    maxMessages: 1, // Per product
  },
  checkout: {
    position: 'below_summary',
    alignment: 'center',
    floating: false,
    maxMessages: 1,
  },
});

// Anti-repetition configuration
// NOTE: Family cooldowns, context fatigue, and per-context limits are
// EXCLUSIVELY handled by cooldown-fatigue-engine. This config only
// controls same-message dedup and memory window for history pruning.
const REPETITION_CONFIG = Object.freeze({
  // Minimum time before same message can repeat (ms)
  sameMessageCooldownMs: 300000,  // 5 minutes
  
  // Memory window for history tracking (ms) — used for analytics/pruning only
  memoryWindowMs: 600000,         // 10 minutes

  // --- DEPRECATED (fatigue authority delegated to cooldown-fatigue-engine) ---
  // These remain for backward compatibility of the export shape but are
  // NOT evaluated in canShowMessage(). The cooldown-fatigue-engine is the
  // single authority for family cooldowns, context saturation, and pacing.
  sameFamilyCooldownMs: 60000,    // DEPRECATED: delegated to cooldown-fatigue-engine
  maxFamilyPerSession: 5,         // DEPRECATED: delegated to cooldown-fatigue-engine
  contextFatigueWindowMs: 120000, // DEPRECATED: delegated to cooldown-fatigue-engine
  maxMessagesPerContextWindow: 3, // DEPRECATED: delegated to cooldown-fatigue-engine
});

// Default message timeouts by context (ms)
const DEFAULT_TIMEOUTS = Object.freeze({
  listing: 8000,
  modal: 12000,
  cart: 15000,
  checkout: 10000,
  hover_cta: 6000,
});

// ----------------------------------------------------------------------
// Message State Store
// ----------------------------------------------------------------------

const MAX_SESSIONS = 1000;
const MAX_MESSAGE_HISTORY = 100;

class MessageLifecycleStore {
  constructor() {
    this.sessions = new Map();
    this.sessionOrder = [];
  }

  getSession(sessionId, nowMs) {
    // P1-6 fix: accept nowMs for replay-safe session creation
    const ts = nowMs;
    if (typeof ts !== 'number') throw new Error('MLC.getSession requires explicit nowMs');
    if (!this.sessions.has(sessionId)) {
      this._evictIfNeeded();
      this.sessions.set(sessionId, this._createSession(ts));
    }
    this._touchSession(sessionId);
    return this.sessions.get(sessionId);
  }

  _createSession(nowMs) {
    const ts = nowMs;
    if (typeof ts !== 'number') throw new Error('MLC._createSession requires explicit nowMs');
    return {
      activeMessages: new Map(),
      messageHistory: [],
      familyCounts: {},
      familyLastShown: {},
      currentContext: null,
      currentProductId: null,
      contextEnteredAt: null,
      contextFatigue: {}, // DEPRECATED: fatigue tracked by cooldown-fatigue-engine
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
    let minAccess = Infinity; let evictId = null;
    for (const [id, acc] of this._accessMap.entries()) {
      if (this.sessions.has(id) && acc < minAccess) { minAccess = acc; evictId = id; }
    }
    if (evictId) { this.sessions.delete(evictId); this._accessMap.delete(evictId); }
  }

  snapshot() {
    const sessionsArray = [];
    for (const [id, session] of this.sessions.entries()) {
      sessionsArray.push([id, {
        ...session,
        activeMessages: Array.from(session.activeMessages.entries()),
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
        activeMessages: new Map(session.activeMessages),
      });
    }
    this.sessionOrder = [...snapshot.sessionOrder];
    return true;
  }
}

const lifecycleStore = new MessageLifecycleStore();

// ----------------------------------------------------------------------
// Context Change Detection
// ----------------------------------------------------------------------

/**
 * Update context and trigger expirations as needed.
 * @param {string} sessionId
 * @param {object} newContext - {context, productId, funnelStage}
 * @param {number} nowMs
 * @returns {object} Expiration results
 */
function updateContext(sessionId, newContext, nowMs) {
  const session = lifecycleStore.getSession(sessionId, nowMs);
  const previousContext = session.currentContext;
  const previousProductId = session.currentProductId;
  
  const expired = [];
  
  // Check what changed
  const contextChanged = previousContext !== newContext.context;
  const productChanged = previousProductId !== newContext.productId;
  
  // Expire messages based on changes
  if (contextChanged) {
    // Expire ALL messages on context change
    expired.push(..._expireAllMessages(session, EXPIRATION_TRIGGERS.CONTEXT_CHANGE, nowMs));
  } else if (productChanged) {
    // Expire messages for old product
    expired.push(..._expireProductMessages(session, previousProductId, EXPIRATION_TRIGGERS.PRODUCT_CHANGE, nowMs));
  }
  
  // Update context state
  session.currentContext = newContext.context;
  session.currentProductId = newContext.productId;
  if (contextChanged) {
    session.contextEnteredAt = nowMs;
  }
  session.lastActivity = nowMs;
  
  return {
    contextChanged,
    productChanged,
    expired,
    previousContext,
    previousProductId,
    newContext: newContext.context,
    newProductId: newContext.productId,
  };
}

function _expireAllMessages(session, reason, nowMs) {
  const expired = [];
  
  for (const [key, msg] of session.activeMessages.entries()) {
    expired.push({
      key,
      message: msg.message,
      context: msg.context,
      productId: msg.productId,
      reason,
      expiredAt: nowMs,
      lifespan: nowMs - msg.shownAt,
    });
    
    // Record in history
    _recordExpiration(session, msg, reason, nowMs);
  }
  
  session.activeMessages.clear();
  return expired;
}

function _expireProductMessages(session, productId, reason, nowMs) {
  const expired = [];
  const keysToRemove = [];
  
  for (const [key, msg] of session.activeMessages.entries()) {
    if (msg.productId === productId) {
      expired.push({
        key,
        message: msg.message,
        context: msg.context,
        productId: msg.productId,
        reason,
        expiredAt: nowMs,
        lifespan: nowMs - msg.shownAt,
      });
      
      _recordExpiration(session, msg, reason, nowMs);
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => session.activeMessages.delete(key));
  return expired;
}

function _recordExpiration(session, msg, reason, nowMs) {
  session.messageHistory.push({
    messageId: msg.message.id || _generateMessageId(msg.message),
    family: msg.message.family,
    content: msg.message.content,
    shownAt: msg.shownAt,
    context: msg.context,
    productId: msg.productId,
    expiredAt: nowMs,
    reason,
  });
  
  // Prune history
  if (session.messageHistory.length > MAX_MESSAGE_HISTORY) {
    session.messageHistory = session.messageHistory.slice(-MAX_MESSAGE_HISTORY);
  }
}

// ----------------------------------------------------------------------
// Anti-Repetition Checks
// ----------------------------------------------------------------------

/**
 * Check if a message can be shown (same-message dedup only).
 *
 * ARCHITECTURAL NOTE: Family cooldowns, context fatigue, per-context limits,
 * and family session limits are the exclusive authority of cooldown-fatigue-engine.
 * This method ONLY checks same-message dedup to prevent exact repeat content.
 * All other fatigue/pacing decisions must go through the canonical pipeline:
 *   session-orchestrator -> cooldown-fatigue-engine.canIntervene()
 *
 * @param {string} sessionId
 * @param {object} message
 * @param {number} nowMs
 * @returns {object} {allowed, reason, cooldownRemaining}
 */
function canShowMessage(sessionId, message, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  const config = REPETITION_CONFIG;
  
  const messageId = message.id || _generateMessageId(message);
  
  // Check same message cooldown (dedup — this is lifecycle's responsibility)
  const sameMessageHistory = session.messageHistory.filter(h => h.messageId === messageId);
  const lastSameMessage = sameMessageHistory[sameMessageHistory.length - 1];
  if (lastSameMessage) {
    const cooldownRemaining = config.sameMessageCooldownMs - (nowMs - lastSameMessage.shownAt);
    if (cooldownRemaining > 0) {
      return {
        allowed: false,
        reason: 'same_message_cooldown',
        cooldownRemaining,
      };
    }
  }
  
  // All other fatigue checks (family cooldown, family session limit,
  // context fatigue) are DELEGATED to cooldown-fatigue-engine.
  // They are NOT evaluated here to prevent double-gating.
  
  return { allowed: true, reason: null, cooldownRemaining: 0 };
}

/**
 * Check repetition for a specific family.
 * @param {string} sessionId
 * @param {string} family
 * @param {number} nowMs
 * @returns {object} Repetition status
 */
function checkFamilyRepetition(sessionId, family, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  const config = REPETITION_CONFIG;
  
  const windowStart = nowMs - config.memoryWindowMs;
  const recentFamilyMessages = session.messageHistory.filter(
    h => h.family === family && h.shownAt > windowStart
  );
  
  return {
    family,
    recentCount: recentFamilyMessages.length,
    totalCount: session.familyCounts[family] || 0,
    lastShownAt: session.familyLastShown[family] || null,
    canShow: recentFamilyMessages.length < 3,
  };
}

// ----------------------------------------------------------------------
// Message Registration
// ----------------------------------------------------------------------

/**
 * Register a message as being shown.
 * @param {string} sessionId
 * @param {object} message
 * @param {object} context - {context, productId}
 * @param {number} nowMs
 * @returns {object} Registration result
 */
function registerMessage(sessionId, message, context, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  const messageId = message.id || _generateMessageId(message);
  const family = message.family;
  
  // Generate unique key for this message instance
  const key = `${context.context}:${context.productId || 'global'}:${messageId}`;
  
  // Expire any existing message in same slot
  if (session.activeMessages.has(key)) {
    const existing = session.activeMessages.get(key);
    _recordExpiration(session, existing, EXPIRATION_TRIGGERS.NEW_MESSAGE, nowMs);
  }
  
  // Calculate expiration time
  const timeout = DEFAULT_TIMEOUTS[context.context] || 10000;
  const expiresAt = nowMs + timeout;
  
  // Register new message
  session.activeMessages.set(key, {
    message: { ...message, id: messageId },
    context: context.context,
    productId: context.productId,
    shownAt: nowMs,
    expiresAt,
  });
  
  // Update family tracking
  session.familyCounts[family] = (session.familyCounts[family] || 0) + 1;
  session.familyLastShown[family] = nowMs;
  
  // Update contextual fatigue
  if (!session.contextFatigue[context.context]) {
    session.contextFatigue[context.context] = { messagesShown: 0, lastMessageAt: null };
  }
  session.contextFatigue[context.context].messagesShown++;
  session.contextFatigue[context.context].lastMessageAt = nowMs;
  
  session.lastActivity = nowMs;
  
  return {
    key,
    messageId,
    family,
    expiresAt,
    placement: CONTEXT_PLACEMENTS[context.context],
  };
}

/**
 * Expire a message manually.
 * @param {string} sessionId
 * @param {string} key
 * @param {string} reason
 * @param {number} nowMs
 * @returns {object|null} Expired message or null
 */
function expireMessage(sessionId, key, reason, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  
  if (!session.activeMessages.has(key)) {
    return null;
  }
  
  const msg = session.activeMessages.get(key);
  session.activeMessages.delete(key);
  
  _recordExpiration(session, msg, reason, nowMs);
  
  return {
    key,
    message: msg.message,
    context: msg.context,
    productId: msg.productId,
    reason,
    expiredAt: nowMs,
    lifespan: nowMs - msg.shownAt,
  };
}

/**
 * Check and expire timed-out messages.
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {Array} Expired messages
 */
function checkTimeouts(sessionId, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  const expired = [];
  const keysToRemove = [];
  
  for (const [key, msg] of session.activeMessages.entries()) {
    if (nowMs >= msg.expiresAt) {
      expired.push({
        key,
        message: msg.message,
        context: msg.context,
        productId: msg.productId,
        reason: EXPIRATION_TRIGGERS.TIMEOUT,
        expiredAt: nowMs,
        lifespan: nowMs - msg.shownAt,
      });
      
      _recordExpiration(session, msg, EXPIRATION_TRIGGERS.TIMEOUT, nowMs);
      keysToRemove.push(key);
    }
  }
  
  keysToRemove.forEach(key => session.activeMessages.delete(key));
  return expired;
}

// ----------------------------------------------------------------------
// Active Message Queries
// ----------------------------------------------------------------------

/**
 * Get active messages for current context.
 * @param {string} sessionId
 * @param {string} context - Optional filter by context
 * @param {string} productId - Optional filter by product
 * @returns {Array} Active messages
 */
function getActiveMessages(sessionId, context, productId) {
  const session = lifecycleStore.getSession(sessionId);
  const results = [];
  
  for (const [key, msg] of session.activeMessages.entries()) {
    if (context && msg.context !== context) continue;
    if (productId && msg.productId !== productId) continue;
    
    results.push({
      key,
      ...msg,
      placement: CONTEXT_PLACEMENTS[msg.context],
    });
  }
  
  return results;
}

/**
 * Get message for a specific product.
 * @param {string} sessionId
 * @param {string} productId
 * @returns {object|null} Active message or null
 */
function getProductMessage(sessionId, productId) {
  const messages = getActiveMessages(sessionId, null, productId);
  return messages.length > 0 ? messages[0] : null;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function _generateMessageId(message) {
  const content = message.content || '';
  const family = message.family || 'unknown';
  // Simple hash-like ID
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash |= 0;
  }
  return `${family}_${Math.abs(hash).toString(36)}`;
}

// ----------------------------------------------------------------------
// Analytics
// ----------------------------------------------------------------------

/**
 * Get lifecycle analytics for a session.
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {object} Analytics
 */
function getLifecycleAnalytics(sessionId, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  
  const windowStart = nowMs - REPETITION_CONFIG.memoryWindowMs;
  const recentHistory = session.messageHistory.filter(h => h.shownAt > windowStart);
  
  // Compute average lifespan
  const lifespans = recentHistory.filter(h => h.expiredAt).map(h => h.expiredAt - h.shownAt);
  const avgLifespan = lifespans.length > 0 ? lifespans.reduce((a, b) => a + b, 0) / lifespans.length : 0;
  
  // Expiration reasons breakdown
  const expirationReasons = {};
  recentHistory.forEach(h => {
    if (h.reason) {
      expirationReasons[h.reason] = (expirationReasons[h.reason] || 0) + 1;
    }
  });
  
  return {
    activeMessageCount: session.activeMessages.size,
    totalMessagesShown: session.messageHistory.length,
    recentMessagesShown: recentHistory.length,
    familyCounts: { ...session.familyCounts },
    avgLifespan,
    expirationReasons,
    contextFatigue: { ...session.contextFatigue }, // DEPRECATED: informational only, authority is cooldown-fatigue-engine
    currentContext: session.currentContext,
    currentProductId: session.currentProductId,
  };
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * forceExpireAll — P0-5 fix: dedicated method that expires all active messages
 * WITHOUT corrupting session.currentContext by setting it to '__force_expire__'.
 * Use this instead of passing a fake context to updateContext().
 * @param {string} sessionId
 * @param {string} reason
 * @param {number} nowMs
 * @returns {Array} expired messages
 */
function forceExpireAll(sessionId, reason, nowMs) {
  const session = lifecycleStore.getSession(sessionId);
  const expired = _expireAllMessages(session, reason || EXPIRATION_TRIGGERS.USER_DISMISS, nowMs);
  session.lastActivity = nowMs;
  return expired;
}

module.exports = {
  // Constants
  EXPIRATION_TRIGGERS,
  CONTEXT_PLACEMENTS,
  REPETITION_CONFIG,
  DEFAULT_TIMEOUTS,
  
  // Context management
  updateContext,
  
  // Anti-repetition
  canShowMessage,
  checkFamilyRepetition,
  
  // Message lifecycle
  registerMessage,
  expireMessage,
  checkTimeouts,
  
  // Queries
  getActiveMessages,
  getProductMessage,
  
  // Analytics
  getLifecycleAnalytics,
  
  // Force expire (P0-5 fix)
  forceExpireAll,

  // Store management
  getSession: (sessionId) => lifecycleStore.getSession(sessionId),
  snapshot: () => lifecycleStore.snapshot(),
  restore: (snap) => lifecycleStore.restore(snap),
};
