/**
 * product-relationship-intervention-engine.js
 *
 * PRODUCT RELATIONSHIP INTERVENTION ENGINE — Main coordinator for cautious interventions.
 *
 * This is the central engine that:
 *   - Evaluates product relationships for potential interventions
 *   - Enforces ALL constraints (category, confidence, session limits, etc.)
 *   - Returns SIGNALS only (does not render UI or trigger side effects)
 *   - Integrates with OPE's single-authority architecture
 *
 * Integration with OPE:
 *   - session-orchestrator remains SINGLE ORCHESTRATION AUTHORITY
 *   - cooldown-fatigue-engine handles all fatigue/cooldown logic
 *   - This engine provides relationship-specific SIGNALS
 *   - Deterministic: NO Date.now(), NO Math.random()
 *   - Replay-safe: snapshot/restore
 *
 * Flow:
 *   1. Receive relationship evaluation request
 *   2. Check category allowlist (FOOD/GROCERY/DELIVERY only)
 *   3. Check relationship type permission
 *   4. Check completion confidence (>0.85)
 *   5. Check negative preference memory
 *   6. Check session intervention limits
 *   7. Return signal (INTERVENE, BLOCK_*, or SUPPRESS)
 */

'use strict';

const { RELATIONSHIP_TYPES, validateInterventionPermission } = require('./product-relationship-types');
const { CompletionConfidenceEngine } = require('./completion-confidence-engine');
const { NegativePreferenceMemory } = require('./negative-preference-memory');
const { generateCautiousMessage, createMessageContext } = require('./cautious-message-templates');

// ============================================================================
// CONFIGURATION
// ============================================================================

const SNAPSHOT_SCHEMA_VERSION = 1;

const DEFAULT_CONFIG = Object.freeze({
  // Confidence threshold for automatic intervention
  confidenceThreshold: 0.85,

  // Maximum interventions per relationship type per session
  maxInterventionsPerTypePerSession: 1,

  // Maximum total relationship interventions per session
  maxTotalInterventionsPerSession: 3,

  // Minimum time between interventions (ms)
  minInterventionIntervalMs: 60000, // 1 minute

  // Session state capacity
  sessionHistoryCapacity: 100,

  // Enable/disable debug logging
  enableDebugLogging: false,
});

// ============================================================================
// INTERVENTION DECISIONS
// ============================================================================

const INTERVENTION_DECISIONS = Object.freeze({
  // Positive decision - intervention is allowed
  INTERVENE: 'INTERVENE',

  // Blocked by category restriction
  BLOCK_CATEGORY: 'BLOCK_CATEGORY',

  // Blocked by relationship type restriction
  BLOCK_TYPE: 'BLOCK_TYPE',

  // Blocked by forbidden pattern
  BLOCK_PATTERN: 'BLOCK_PATTERN',

  // Confidence below threshold
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',

  // Suppressed by negative preference memory
  SUPPRESS_NEGATIVE_MEMORY: 'SUPPRESS_NEGATIVE_MEMORY',

  // Session limit reached
  SESSION_LIMIT: 'SESSION_LIMIT',

  // Too soon since last intervention
  COOLDOWN: 'COOLDOWN',

  // Generic suppression
  SUPPRESS: 'SUPPRESS',
});

// ============================================================================
// LRU MAP (for bounded memory)
// ============================================================================

class LRUMap {
  constructor(maxSize) {
    this._max = Math.max(1, maxSize | 0);
    this._map = new Map();
  }

  get size() { return this._map.size; }
  has(key) { return this._map.has(key); }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }

  peek(key) { return this._map.get(key); }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this._max) {
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }

  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }

  toObject() {
    const obj = {};
    for (const [k, v] of this._map.entries()) obj[k] = v;
    return obj;
  }

  loadFromObject(obj) {
    this._map.clear();
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      this.set(k, obj[k]);
    }
  }
}

// ============================================================================
// PRODUCT RELATIONSHIP INTERVENTION ENGINE
// ============================================================================

class ProductRelationshipInterventionEngine {
  /**
   * @param {object} [options]
   * @param {object} [options.config] - Override default configuration
   * @param {object} [options.confidenceEngine] - Inject CompletionConfidenceEngine
   * @param {object} [options.negativeMemory] - Inject NegativePreferenceMemory
   * @param {object} [options.logger] - Logger compatible with logger-v2
   */
  constructor(options = {}) {
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...options.config });

    // Inject or create sub-engines
    this._confidenceEngine = options.confidenceEngine || new CompletionConfidenceEngine({
      confidenceThreshold: this.config.confidenceThreshold,
    });
    this._negativeMemory = options.negativeMemory || new NegativePreferenceMemory();

    this._logger = options.logger || null;

    // Session state
    this._sessionId = null;
    this._sessionStartedAt = 0;
    this._lastInterventionAt = 0;
    this._sessionInterventionCount = 0;
    this._interventionsByType = new Map();
    this._interventionHistory = [];

    this._version = 1;
    this._disposed = false;
  }

  // =========================================================================
  // SESSION LIFECYCLE
  // =========================================================================

  /**
   * Begins a new session.
   */
  beginSession(sessionId, nowMs) {
    this._assertAlive();
    if (!Number.isFinite(nowMs)) {
      throw new TypeError('ProductRelationshipInterventionEngine: nowMs must be a finite number');
    }

    this._sessionId = sessionId;
    this._sessionStartedAt = nowMs;
    this._lastInterventionAt = 0;
    this._sessionInterventionCount = 0;
    this._interventionsByType.clear();
    this._interventionHistory.length = 0;
    this._version++;

    this._log('info', `Session started: ${sessionId}`);
  }

  /**
   * Ends the current session.
   */
  endSession(nowMs) {
    this._assertAlive();

    this._log('info', `Session ended: ${this._sessionId}, interventions: ${this._sessionInterventionCount}`);

    this._sessionId = null;
    this._sessionStartedAt = 0;
    this._lastInterventionAt = 0;
    this._sessionInterventionCount = 0;
    this._interventionsByType.clear();
    this._interventionHistory.length = 0;
    this._version++;
  }

  // =========================================================================
  // MAIN EVALUATION API
  // =========================================================================

  /**
   * Evaluates whether an intervention should occur for a product relationship.
   *
   * This is the MAIN entry point. It returns a SIGNAL, not a UI action.
   *
   * @param {object} params
   * @param {string} params.triggerProductId - Product that triggered evaluation
   * @param {string} params.suggestedProductId - Product being suggested
   * @param {string} params.relationshipType - One of RELATIONSHIP_TYPES
   * @param {string} params.fromCategory - Trigger product category
   * @param {string} params.toCategory - Suggested product category
   * @param {string} [params.fromSubcategory] - Trigger product subcategory
   * @param {string} [params.toSubcategory] - Suggested product subcategory
   * @param {object} params.confidenceSignals - Signals for confidence computation
   * @param {number} [params.dismissalCount=0] - User dismissal count
   * @param {string} [params.triggerProductName] - For message generation
   * @param {string} [params.suggestedProductName] - For message generation
   * @param {string} [params.language='es'] - Language for messages
   * @param {number} params.nowMs - Current timestamp
   * @returns {object} Intervention decision signal
   */
  evaluate(params) {
    this._assertAlive();
    const { nowMs } = params;

    if (!Number.isFinite(nowMs)) {
      throw new TypeError('ProductRelationshipInterventionEngine: nowMs must be a finite number');
    }

    const rationale = [];
    const relationshipId = `${params.triggerProductId}:${params.suggestedProductId}`;

    // 1. Check category and relationship type permission
    const permissionCheck = validateInterventionPermission({
      fromCategory: params.fromCategory,
      toCategory: params.toCategory,
      relationshipType: params.relationshipType,
      fromSubcategory: params.fromSubcategory,
      toSubcategory: params.toSubcategory,
    });

    if (!permissionCheck.allowed) {
      rationale.push(permissionCheck.reason);

      let decision;
      if (permissionCheck.reason.includes('category') || permissionCheck.reason.includes('not_allowed_category')) {
        decision = INTERVENTION_DECISIONS.BLOCK_CATEGORY;
      } else if (permissionCheck.reason.includes('forbidden_pattern')) {
        decision = INTERVENTION_DECISIONS.BLOCK_PATTERN;
      } else if (permissionCheck.reason.includes('relationship_type')) {
        decision = INTERVENTION_DECISIONS.BLOCK_TYPE;
      } else {
        // Default to BLOCK_CATEGORY for unknown reasons since we're conservative
        decision = INTERVENTION_DECISIONS.BLOCK_CATEGORY;
      }

      return this._buildResult(
        decision,
        `Permission denied: ${permissionCheck.reason}`,
        rationale,
        nowMs
      );
    }

    // 2. Check negative preference memory
    const negativeCheck = this._negativeMemory.shouldSuppress(relationshipId, nowMs);
    if (negativeCheck.suppressed) {
      rationale.push(`suppressed_by_negative_memory:${negativeCheck.reason}`);
      return this._buildResult(
        INTERVENTION_DECISIONS.SUPPRESS_NEGATIVE_MEMORY,
        `Suppressed by negative preference memory: ${negativeCheck.reason}`,
        rationale,
        nowMs
      );
    }

    // 3. Check session intervention limits
    const sessionLimitCheck = this._checkSessionLimits(params.relationshipType, nowMs);
    if (!sessionLimitCheck.allowed) {
      rationale.push(sessionLimitCheck.reason);
      return this._buildResult(
        sessionLimitCheck.decision,
        sessionLimitCheck.reason,
        rationale,
        nowMs
      );
    }

    // 4. Check completion confidence
    const confidenceResult = this._confidenceEngine.computeConfidence({
      triggerProductId: params.triggerProductId,
      suggestedProductId: params.suggestedProductId,
      signals: params.confidenceSignals || {},
      dismissalCount: params.dismissalCount || 0,
      nowMs,
    });

    rationale.push(`confidence:${confidenceResult.confidence.toFixed(3)}`);
    rationale.push(...confidenceResult.rationale);

    if (!confidenceResult.meetsThreshold) {
      return this._buildResult(
        INTERVENTION_DECISIONS.LOW_CONFIDENCE,
        `Confidence ${confidenceResult.confidence.toFixed(3)} below threshold ${confidenceResult.threshold}`,
        rationale,
        nowMs,
        { confidence: confidenceResult }
      );
    }

    // 5. All checks passed - generate message
    const messageResult = generateCautiousMessage({
      relationshipType: params.relationshipType,
      suggestedProduct: params.suggestedProductName || params.suggestedProductId,
      triggerProduct: params.triggerProductName || params.triggerProductId,
      category: params.fromCategory,
      language: params.language || 'es',
      seed: this._hashString(relationshipId),
    });

    if (!messageResult.valid) {
      rationale.push(`invalid_message:${messageResult.forbiddenFound}`);
      return this._buildResult(
        INTERVENTION_DECISIONS.SUPPRESS,
        `Generated message contains forbidden phrase: ${messageResult.forbiddenFound}`,
        rationale,
        nowMs
      );
    }

    // 6. Record the intervention
    this._recordIntervention(params.relationshipType, relationshipId, nowMs);

    const messageContext = createMessageContext({
      relationshipId,
      triggerProductId: params.triggerProductId,
      suggestedProductId: params.suggestedProductId,
      relationshipType: params.relationshipType,
      nowMs,
    });

    return this._buildResult(
      INTERVENTION_DECISIONS.INTERVENE,
      'Intervention approved',
      rationale,
      nowMs,
      {
        confidence: confidenceResult,
        message: messageResult.message,
        messageContext,
        relationshipId,
        relationshipType: params.relationshipType,
      }
    );
  }

  // =========================================================================
  // FEEDBACK RECORDING
  // =========================================================================

  /**
   * Records user dismissal of an intervention.
   */
  recordDismissal(params) {
    this._assertAlive();
    this._negativeMemory.recordDismissal(params);
    this._version++;
  }

  /**
   * Records user skip (saw but didn't act).
   */
  recordSkip(params) {
    this._assertAlive();
    this._negativeMemory.recordSkip(params);
    this._version++;
  }

  /**
   * Records user purchase after seeing suggestion.
   */
  recordPurchase(params) {
    this._assertAlive();
    this._negativeMemory.recordPurchase(params);
    this._version++;
  }

  // =========================================================================
  // SESSION LIMIT CHECKS
  // =========================================================================

  _checkSessionLimits(relationshipType, nowMs) {
    // Check total session limit
    if (this._sessionInterventionCount >= this.config.maxTotalInterventionsPerSession) {
      return {
        allowed: false,
        decision: INTERVENTION_DECISIONS.SESSION_LIMIT,
        reason: `session_total_limit_reached:${this._sessionInterventionCount}`,
      };
    }

    // Check per-type limit
    const typeCount = this._interventionsByType.get(relationshipType) || 0;
    if (typeCount >= this.config.maxInterventionsPerTypePerSession) {
      return {
        allowed: false,
        decision: INTERVENTION_DECISIONS.SESSION_LIMIT,
        reason: `session_type_limit_reached:${relationshipType}:${typeCount}`,
      };
    }

    // Check cooldown
    if (this._lastInterventionAt > 0) {
      const elapsed = nowMs - this._lastInterventionAt;
      if (elapsed < this.config.minInterventionIntervalMs) {
        return {
          allowed: false,
          decision: INTERVENTION_DECISIONS.COOLDOWN,
          reason: `intervention_cooldown:${elapsed}ms<${this.config.minInterventionIntervalMs}ms`,
        };
      }
    }

    return { allowed: true };
  }

  _recordIntervention(relationshipType, relationshipId, nowMs) {
    this._sessionInterventionCount++;
    this._lastInterventionAt = nowMs;

    const typeCount = this._interventionsByType.get(relationshipType) || 0;
    this._interventionsByType.set(relationshipType, typeCount + 1);

    this._interventionHistory.push({
      relationshipType,
      relationshipId,
      timestamp: nowMs,
    });

    // Bounded history
    while (this._interventionHistory.length > this.config.sessionHistoryCapacity) {
      this._interventionHistory.shift();
    }

    this._version++;
  }

  // =========================================================================
  // RESULT BUILDING
  // =========================================================================

  _buildResult(decision, reason, rationale, nowMs, extra = {}) {
    return {
      decision,
      shouldIntervene: decision === INTERVENTION_DECISIONS.INTERVENE,
      reason,
      rationale,
      timestamp: nowMs,
      sessionId: this._sessionId,
      sessionInterventionCount: this._sessionInterventionCount,
      engineVersion: 'v3.0.0',
      ...extra,
    };
  }

  // =========================================================================
  // SNAPSHOT / RESTORE
  // =========================================================================

  snapshot() {
    return {
      __type: 'ProductRelationshipInterventionEngine',
      __schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      sessionId: this._sessionId,
      sessionStartedAt: this._sessionStartedAt,
      lastInterventionAt: this._lastInterventionAt,
      sessionInterventionCount: this._sessionInterventionCount,
      interventionsByType: Object.fromEntries(this._interventionsByType),
      interventionHistory: this._interventionHistory.slice(),
      confidenceEngine: this._confidenceEngine.snapshot(),
      negativeMemory: this._negativeMemory.snapshot(),
      version: this._version,
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== 'ProductRelationshipInterventionEngine') return;
    if (snap.__schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return;

    this._sessionId = snap.sessionId;
    this._sessionStartedAt = snap.sessionStartedAt || 0;
    this._lastInterventionAt = snap.lastInterventionAt || 0;
    this._sessionInterventionCount = snap.sessionInterventionCount || 0;

    this._interventionsByType.clear();
    if (snap.interventionsByType) {
      for (const [k, v] of Object.entries(snap.interventionsByType)) {
        this._interventionsByType.set(k, v);
      }
    }

    this._interventionHistory = Array.isArray(snap.interventionHistory)
      ? snap.interventionHistory.slice()
      : [];

    if (snap.confidenceEngine) {
      this._confidenceEngine.restore(snap.confidenceEngine);
    }
    if (snap.negativeMemory) {
      this._negativeMemory.restore(snap.negativeMemory);
    }

    this._version = snap.version || 1;
  }

  // =========================================================================
  // DIAGNOSTICS
  // =========================================================================

  getDiagnostics(nowMs) {
    return {
      sessionId: this._sessionId,
      sessionStartedAt: this._sessionStartedAt,
      sessionInterventionCount: this._sessionInterventionCount,
      lastInterventionAt: this._lastInterventionAt,
      interventionsByType: Object.fromEntries(this._interventionsByType),
      historySize: this._interventionHistory.length,
      confidenceEngine: this._confidenceEngine.getDiagnostics(),
      negativeMemory: this._negativeMemory.getDiagnostics(),
      version: this._version,
      config: this.config,
      disposed: this._disposed,
    };
  }

  // =========================================================================
  // LIFECYCLE
  // =========================================================================

  reset(nowMs) {
    this._sessionId = null;
    this._sessionStartedAt = 0;
    this._lastInterventionAt = 0;
    this._sessionInterventionCount = 0;
    this._interventionsByType.clear();
    this._interventionHistory.length = 0;
    this._confidenceEngine.reset();
    this._negativeMemory.reset();
    this._version = 1;
  }

  dispose() {
    if (this._disposed) return;
    this._confidenceEngine.dispose();
    this._negativeMemory.dispose();
    this._interventionsByType.clear();
    this._interventionHistory.length = 0;
    this._disposed = true;
  }

  // =========================================================================
  // HELPERS
  // =========================================================================

  _assertAlive() {
    if (this._disposed) {
      throw new Error('ProductRelationshipInterventionEngine: instance has been disposed');
    }
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  _log(level, message, meta = {}) {
    if (!this._logger) return;
    if (typeof this._logger[level] === 'function') {
      this._logger[level](`[product-relationship-intervention] ${message}`, {
        sessionId: this._sessionId,
        ...meta,
      });
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  ProductRelationshipInterventionEngine,
  INTERVENTION_DECISIONS,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
};
