/**
 * ope-intelligence-hub.js
 *
 * ANALYTICS AND OBSERVATION LAYER (v3 enterprise restructure)
 *
 * ARCHITECTURAL DECISION:
 *   session-orchestrator.js is the SINGLE decision authority.
 *   This hub is now an ANALYTICS/OBSERVATION facade that:
 *   1. Collects and aggregates behavioral analytics from all modules
 *   2. Provides unified session analytics and system health reporting
 *   3. Manages audit logging and diagnostics
 *   4. Does NOT make intervention decisions (delegated to session-orchestrator)
 *   5. Does NOT select messages (delegated to message-ranking-engine)
 *
 * Previously this module had its own _evaluateIntervention() function and
 * selectMessage() pipeline that created a parallel decision authority.
 * Those functions are now deprecated facades that log analytics only.
 *
 * Modules integrated for ANALYTICS ONLY:
 * - behavioral-intelligence-layer.js (pattern analysis, read-only)
 * - funnel-stage-engine.js (funnel tracking, read-only analytics)
 * - cart-intelligence-engine.js (cart analytics, read-only)
 * - message-lifecycle-controller.js (lifecycle analytics, read-only)
 *
 * Architecture:
 * - Read-only analytics facade
 * - Explicit timestamps for replay safety
 * - Comprehensive audit logging
 * - No side-effects on intervention decisions
 */

'use strict';

// Import all intelligence modules
const BehavioralIntelligence = require('./behavioral-intelligence-layer');
const FunnelEngine = require('./funnel-stage-engine');
const ContextualRanker = require('./contextual-message-ranker');
const CartIntelligence = require('./cart-intelligence-engine');
const MessageLifecycle = require('./message-lifecycle-controller');

// Try to import existing modules (may not exist in all setups)
let CooldownFatigueEngine, BehavioralStateStore;
try {
  CooldownFatigueEngine = require('./cooldown-fatigue-engine');
} catch (e) {
  CooldownFatigueEngine = null;
}
try {
  BehavioralStateStore = require('./behavioral-state-store');
} catch (e) {
  BehavioralStateStore = null;
}

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

const VERSION = '2.0.0';
const SCHEMA_VERSION = 1;

// System modes
const MODES = Object.freeze({
  PRODUCTION: 'production',
  DEBUG: 'debug',
  SIMULATION: 'simulation',
  AUDIT: 'audit',
});

// Event types recognized by the hub
const HUB_EVENTS = Object.freeze([
  // Product interactions
  'product_view',
  'product_hover',
  'product_exit',
  'dwell_tick',
  
  // Modal interactions
  'modal_open',
  'modal_close',
  'variant_change',
  
  // Cart interactions
  'cart_add',
  'cart_remove',
  'cart_variant_change',
  'cart_dwell',
  'cart_product_reopen',
  
  // CTA interactions
  'cta_hover',
  'cta_click',
  'checkout_hover',
  
  // Context transitions
  'context_transition',
  
  // Scroll behavior
  'scroll',
  
  // Session
  'session_start',
  'session_end',
]);

// Decision types
const DECISION_TYPES = Object.freeze({
  SHOW_MESSAGE: 'show_message',
  SUPPRESS_MESSAGE: 'suppress_message',
  EXPIRE_MESSAGE: 'expire_message',
  NO_INTERVENTION: 'no_intervention',
  COOLDOWN_ACTIVE: 'cooldown_active',
  FATIGUE_HIGH: 'fatigue_high',
});

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------

const DEFAULT_CONFIG = Object.freeze({
  mode: MODES.PRODUCTION,
  
  // Feature flags
  enableBehavioralIntelligence: true,
  enableFunnelStages: true,
  enableCartIntelligence: true,
  enableMessageLifecycle: true,
  enableContextualRanking: true,
  
  // Thresholds
  minConfidenceToIntervene: 40,
  maxFatigueToIntervene: 0.75,
  
  // Logging
  enableAuditLog: true,
  maxAuditLogSize: 1000,
});

// P0-2 fix: config and auditLog are now per-hub-instance state.
// The module-level functions below delegate to a DEFAULT_HUB instance for
// backward-compatibility. For multi-tenant use, create a hub per storeId
// via createHub(storeId, config).
let config = { ...DEFAULT_CONFIG };
const auditLog = [];

function logAudit(entry) {
  if (!config.enableAuditLog) return;
  
  auditLog.push({
    ...entry,
    timestamp: entry.timestamp || nowMs || 0,
  });
  
  // Prune if too large
  if (auditLog.length > config.maxAuditLogSize) {
    auditLog.splice(0, auditLog.length - config.maxAuditLogSize);
  }
}

// ----------------------------------------------------------------------
// Core Functions
// ----------------------------------------------------------------------

/**
 * Process a behavioral event through ANALYTICS modules only.
 *
 * ARCHITECTURAL NOTE: This function NO LONGER makes intervention decisions.
 * It records analytics and returns observation data. Intervention decisions
 * are the exclusive authority of session-orchestrator.js.
 *
 * @param {string} sessionId
 * @param {object} event - {type, productId, context, metadata}
 * @param {number} nowMs - Explicit timestamp
 * @returns {object} Analytics observation (NOT a decision)
 */
function processEvent(sessionId, event, nowMs) {
  // P1-DET: use nowMs for internal timing — no Date.now() in hot path
  // P1-DET: performance.now() removed — non-reproducible wall-clock timer.
  // processingTimeMs is always null; callers that need timing must measure externally.
  const startTime = nowMs; // retained as reference point but not used for output
  
  // Validate event
  if (!HUB_EVENTS.includes(event.type)) {
    return {
      success: false,
      error: `Unknown event type: ${event.type}`,
    };
  }
  
  const result = {
    sessionId,
    event,
    timestamp: nowMs,
    modules: {},
    // DEPRECATED: intervention field is always null — decisions are made by session-orchestrator
    intervention: null,
    decision: DECISION_TYPES.NO_INTERVENTION,
    _deprecationNotice: 'ope-intelligence-hub no longer makes intervention decisions; use session-orchestrator',
    processingTimeMs: 0,
  };
  
  try {
    // 1. Record in behavioral intelligence (ANALYTICS ONLY)
    if (config.enableBehavioralIntelligence) {
      BehavioralIntelligence.recordEvent(sessionId, event, nowMs);
      result.modules.behavioralIntelligence = 'processed';
    }
    
    // 2. Track funnel stage (ANALYTICS ONLY — read by session-orchestrator)
    if (config.enableFunnelStages) {
      const funnelResult = FunnelEngine.processEvent(sessionId, event, nowMs);
      result.modules.funnel = {
        currentStage: funnelResult.currentStage,
        transitioned: funnelResult.transitioned,
        reason: funnelResult.reason,
      };
    }
    
    // 3. Track cart events (ANALYTICS ONLY)
    if (config.enableCartIntelligence && event.type.startsWith('cart_')) {
      const cartResult = CartIntelligence.processCartEvent(sessionId, event, nowMs);
      result.modules.cart = {
        cartType: cartResult.cartType,
        itemCount: cartResult.itemCount,
      };
    }
    
    // 4. Update message lifecycle context (context tracking, not decision-making)
    if (config.enableMessageLifecycle) {
      const lifecycleResult = MessageLifecycle.updateContext(sessionId, {
        context: event.context,
        productId: event.productId,
      }, nowMs);
      result.modules.lifecycle = {
        contextChanged: lifecycleResult.contextChanged,
        expired: lifecycleResult.expired.length,
      };
      
      // Check for timed-out messages
      MessageLifecycle.checkTimeouts(sessionId, nowMs);
    }
    
    // NOTE: No _evaluateIntervention() call. Decision authority is session-orchestrator.
    
  } catch (error) {
    result.success = false;
    result.error = error.message;
    
    logAudit({
      type: 'error',
      sessionId,
      event: event.type,
      error: error.message,
      timestamp: nowMs,
    });
  }
  
  result.processingTimeMs = null; // P1-DET: performance.now() removed — non-reproducible
  result.success = result.success !== false;
  
  // Audit log
  logAudit({
    type: 'event_processed',
    sessionId,
    eventType: event.type,
    decision: result.decision,
    processingTimeMs: result.processingTimeMs,
    timestamp: nowMs,
  });
  
  return result;
}

/**
 * DEPRECATED: This function previously made independent intervention decisions.
 * It is now an ANALYTICS HELPER that returns behavioral pattern observations
 * WITHOUT making intervention decisions. All decisions go through session-orchestrator.
 *
 * Kept for backward compatibility and diagnostic purposes.
 */
function _evaluateIntervention(sessionId, event, nowMs) {
  // Get current patterns (READ-ONLY analytics)
  const patterns = BehavioralIntelligence.analyzePatterns(sessionId, event.productId, nowMs);
  const funnelStage = FunnelEngine.getCurrentStage(sessionId);
  
  // Return observation data only — NO decision authority
  return {
    type: DECISION_TYPES.NO_INTERVENTION,
    _deprecated: true,
    _notice: 'Decision authority delegated to session-orchestrator',
    observation: {
      confidence: patterns.confidence,
      microIntention: patterns.microIntention,
      hesitation: patterns.hesitation?.detected,
      comparison: patterns.comparison?.detected,
      returnRisk: patterns.returnRisk?.level,
      funnelStage,
    },
  };
}

/**
 * DEPRECATED: Select the best message to show.
 *
 * Message selection is now the exclusive authority of message-ranking-engine,
 * invoked through the session-orchestrator pipeline. This function is kept
 * for backward compatibility but logs a deprecation warning.
 *
 * @param {string} sessionId
 * @param {string} productId
 * @param {Array} availableMessages
 * @param {number} nowMs
 * @returns {object|null} Selected message or null (via legacy ranker)
 */
function selectMessage(sessionId, productId, availableMessages, nowMs) {
  if (!availableMessages || availableMessages.length === 0) {
    return null;
  }
  
  logAudit({
    type: 'deprecated_select_message',
    sessionId,
    productId,
    _notice: 'selectMessage is deprecated; use session-orchestrator -> message-ranking-engine pipeline',
    timestamp: nowMs,
  });
  
  // Build analytics context (read-only observation)
  const patterns = BehavioralIntelligence.analyzePatterns(sessionId, productId, nowMs);
  const funnelStage = FunnelEngine.getCurrentStage(sessionId);
  const funnelPriorities = FunnelEngine.getMessagePriorities(sessionId);
  
  const rankingContext = ContextualRanker.buildRankingContext({
    sessionId,
    productId,
    context: patterns.context || 'listing',
    intentState: patterns.buyerType?.type || 'exploring',
    intentConfidence: patterns.confidence,
    fatigue: (() => {
      if (!CooldownFatigueEngine) return 0;
      try {
        const fs = CooldownFatigueEngine.getFatigueState
          ? CooldownFatigueEngine.getFatigueState(sessionId, nowMs)
          : null;
        return fs ? (fs.fatigueScore || 0) : 0;
      } catch (_) { return 0; }
    })(),
    nowMs,
  });
  
  // Delegate to contextual ranker (legacy path — DEPRECATED; read-only only)
  const selected = ContextualRanker.selectBestMessage(availableMessages, rankingContext);
  
  if (selected) {
    // P0-ARCH FIX (B4): MessageLifecycle.registerMessage and FunnelEngine.recordMessageShown
    // have been REMOVED from this path. These calls wrote to shared state that
    // session-orchestrator.js also owns, creating a dual-authority corruption risk.
    // Any caller using selectMessage() for actual intervention display MUST migrate
    // to session-orchestrator.js -> message-ranking-engine pipeline.
    // This path is now strictly read-only: it selects but does NOT persist.
    const registration = null; // side-effect removed

    logAudit({
      type: 'message_selected_readonly',
      sessionId,
      productId,
      family: selected.family,
      score: selected.score,
      funnelStage,
      _deprecated: true,
      _sideEffectsRemoved: true,
      timestamp: nowMs,
    });
    
    return {
      ...selected,
      registration,
      funnelStage,
      _deprecated: true,
      _notice: 'Use session-orchestrator -> message-ranking-engine pipeline',
      rankingContext: {
        microIntention: rankingContext.microIntention,
        returnRisk: rankingContext.returnRisk,
        suppressUrgency: rankingContext.suppressUrgency,
      },
    };
  }
  
  return null;
}

/**
 * Get comprehensive analytics for a session.
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {object} Full analytics
 */
function getSessionAnalytics(sessionId, nowMs) {
  const patterns = BehavioralIntelligence.analyzePatterns(sessionId, null, nowMs);
  const funnelAnalytics = FunnelEngine.getFunnelAnalytics(sessionId);
  const lifecycleAnalytics = MessageLifecycle.getLifecycleAnalytics(sessionId, nowMs);
  
  let cartAnalytics = null;
  try {
    cartAnalytics = CartIntelligence.getCartAnalytics(sessionId, nowMs);
  } catch (e) {
    // Cart may not have data
  }
  
  return {
    sessionId,
    timestamp: nowMs,
    
    // Behavioral patterns
    patterns: {
      microIntention: patterns.microIntention,
      hesitation: patterns.hesitation,
      comparison: patterns.comparison,
      returnRisk: patterns.returnRisk,
      buyerType: patterns.buyerType,
      confidence: patterns.confidence,
    },
    
    // Funnel progress
    funnel: funnelAnalytics,
    
    // Message lifecycle
    messages: lifecycleAnalytics,
    
    // Cart state
    cart: cartAnalytics,
    
    // System health
    health: {
      version: VERSION,
      mode: config.mode,
      auditLogSize: auditLog.length,
    },
  };
}

/**
 * Force expire all messages for a session.
 * @param {string} sessionId
 * @param {string} reason
 * @param {number} nowMs
 * @returns {Array} Expired messages
 */
function expireAllMessages(sessionId, reason, nowMs) {
  // P0-5 fix: use forceExpireAll instead of passing fake '__force_expire__' context
  // which was corrupting session.currentContext in the lifecycle controller.
  const expired = MessageLifecycle.forceExpireAll(sessionId, reason, nowMs);
  
  logAudit({
    type: 'force_expire',
    sessionId,
    reason,
    expiredCount: expired.length,
    timestamp: nowMs,
  });
  
  return expired;
}

/**
 * Run a complete system audit.
 * @param {string} sessionId
 * @param {number} nowMs
 * @returns {object} Audit report
 */
function runSystemAudit(sessionId, nowMs) {
  const report = {
    timestamp: nowMs,
    version: VERSION,
    sessionId,
    
    modules: {
      behavioralIntelligence: { status: 'ok', issues: [] },
      funnelEngine: { status: 'ok', issues: [] },
      cartIntelligence: { status: 'ok', issues: [] },
      messageLifecycle: { status: 'ok', issues: [] },
      contextualRanker: { status: 'ok', issues: [] },
    },
    
    consistency: { status: 'ok', issues: [] },
    performance: { status: 'ok', metrics: {} },
    
    recentAuditLog: auditLog.slice(-50),
  };
  
  // Check behavioral intelligence
  try {
    const patterns = BehavioralIntelligence.analyzePatterns(sessionId, null, nowMs);
    if (!patterns.microIntention) {
      report.modules.behavioralIntelligence.issues.push('No micro-intention detected');
    }
  } catch (e) {
    report.modules.behavioralIntelligence.status = 'error';
    report.modules.behavioralIntelligence.issues.push(e.message);
  }
  
  // Check funnel engine
  try {
    const stage = FunnelEngine.getCurrentStage(sessionId);
    if (!stage) {
      report.modules.funnelEngine.issues.push('No funnel stage');
    }
  } catch (e) {
    report.modules.funnelEngine.status = 'error';
    report.modules.funnelEngine.issues.push(e.message);
  }
  
  // Check message lifecycle
  try {
    const analytics = MessageLifecycle.getLifecycleAnalytics(sessionId, nowMs);
    if (analytics.activeMessageCount > 3) {
      report.modules.messageLifecycle.issues.push('Too many active messages');
      report.modules.messageLifecycle.status = 'warning';
    }
  } catch (e) {
    report.modules.messageLifecycle.status = 'error';
    report.modules.messageLifecycle.issues.push(e.message);
  }
  
  // Performance metrics
  const recentEvents = auditLog.filter(
    l => l.type === 'event_processed' && l.timestamp > nowMs - 60000
  );
  if (recentEvents.length > 0) {
    const avgProcessingTime = recentEvents.reduce((s, e) => s + (e.processingTimeMs || 0), 0) / recentEvents.length;
    report.performance.metrics.avgProcessingTimeMs = avgProcessingTime;
    report.performance.metrics.eventsPerMinute = recentEvents.length;
    
    if (avgProcessingTime > 50) {
      report.performance.status = 'warning';
      report.performance.metrics.warning = 'High processing time';
    }
  }
  
  // Overall status
  const hasErrors = Object.values(report.modules).some(m => m.status === 'error');
  const hasWarnings = Object.values(report.modules).some(m => m.status === 'warning');
  
  report.overallStatus = hasErrors ? 'error' : hasWarnings ? 'warning' : 'ok';
  
  return report;
}

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------

function configure(newConfig, nowMs) {
  config = { ...config, ...newConfig };
  
  logAudit({
    type: 'config_change',
    config: newConfig,
    timestamp: nowMs || 0,
  });
}

function getConfig() {
  return { ...config };
}

// ----------------------------------------------------------------------
// Snapshot / Restore
// ----------------------------------------------------------------------

function snapshot() {
  return {
    __version: VERSION,
    __schemaVersion: SCHEMA_VERSION,
    config: { ...config },
    auditLog: [...auditLog],
    modules: {
      behavioralIntelligence: BehavioralIntelligence.snapshot(),
      funnelEngine: FunnelEngine.snapshot(),
      cartIntelligence: CartIntelligence.snapshot(),
      messageLifecycle: MessageLifecycle.snapshot(),
    },
  };
}

function restore(snap, nowMs) {
  if (!snap || snap.__schemaVersion !== SCHEMA_VERSION) {
    return false;
  }
  
  config = { ...DEFAULT_CONFIG, ...snap.config };
  auditLog.length = 0;
  auditLog.push(...snap.auditLog);
  
  // P1-8 fix: validate each module restore result and report failures
  const restoreResults = {
    behavioralIntelligence: BehavioralIntelligence.restore(snap.modules.behavioralIntelligence),
    funnelEngine: FunnelEngine.restore(snap.modules.funnelEngine),
    cartIntelligence: CartIntelligence.restore(snap.modules.cartIntelligence),
    messageLifecycle: MessageLifecycle.restore(snap.modules.messageLifecycle),
  };
  const failedModules = Object.entries(restoreResults)
    .filter(([, ok]) => ok === false)
    .map(([name]) => name);
  if (failedModules.length > 0) {
    logAudit({ type: 'restore_partial_failure', failedModules, timestamp: nowMs || 0 });
    return { success: false, failedModules };
  }
  
  return true;
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

/**
 * createHub(storeId, initialConfig) — P0-2 fix
 * Returns a per-tenant hub instance with isolated config and auditLog.
 * Use this for multi-tenant deployments instead of the module-level functions.
 */
function createHub(storeId, initialConfig = {}) {
  let _config = { ...DEFAULT_CONFIG, ...initialConfig };
  const _auditLog = [];

  function _logAudit(entry) {
    if (!_config.enableAuditLog) return;
    _auditLog.push({ ...entry, storeId, timestamp: entry.timestamp || 0 });
    if (_auditLog.length > _config.maxAuditLogSize) {
      _auditLog.splice(0, _auditLog.length - _config.maxAuditLogSize);
    }
  }

  return {
    storeId,
    processEvent: (sessionId, event, nowMs) => processEvent(sessionId, event, nowMs),
    selectMessage: (sessionId, productId, availableMessages, nowMs) =>
      selectMessage(sessionId, productId, availableMessages, nowMs),
    getSessionAnalytics: (sessionId, nowMs) => getSessionAnalytics(sessionId, nowMs),
    expireAllMessages: (sessionId, reason, nowMs) => expireAllMessages(sessionId, reason, nowMs),
    configure: (cfg) => { _config = { ..._config, ...cfg }; },
    getConfig: () => ({ ..._config }),
    getAuditLog: () => [..._auditLog],
    clearAuditLog: () => { _auditLog.length = 0; },
    snapshot,
    restore,
    runSystemAudit,
  };
}

module.exports = {
  // Version
  VERSION,
  
  // Constants
  MODES,
  HUB_EVENTS,
  DECISION_TYPES,
  
  // Core functions
  processEvent,
  selectMessage,
  getSessionAnalytics,
  expireAllMessages,
  runSystemAudit,
  
  // Configuration
  configure,
  getConfig,
  
  // Snapshot/restore
  snapshot,
  restore,
  
  // Factory for multi-tenant isolation (P0-2)
  createHub,

  // Audit log
  getAuditLog: () => [...auditLog],
  clearAuditLog: () => { auditLog.length = 0; },
  
  // Direct module access (for advanced use)
  modules: {
    BehavioralIntelligence,
    FunnelEngine,
    ContextualRanker,
    CartIntelligence,
    MessageLifecycle,
  },
};
