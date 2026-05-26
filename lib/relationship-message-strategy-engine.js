'use strict';

/**
 * relationship-message-strategy-engine.js
 *
 * Translates product relationship intelligence into strategy candidates
 * for the existing message-ranking-engine and session-orchestrator pipeline.
 *
 * Responsibilities:
 *  - Consume opportunities from intent-completion-engine.
 *  - Consume risk assessments from return-risk-intelligence-engine.
 *  - Produce strategy candidates with strategyType, priority, confidence,
 *    and explainable rationale.
 *  - Map relationship opportunities to MESSAGE_FAMILIES in ope-constants.js.
 *  - Respect cooldown-fatigue-engine and intervention-policy-engine:
 *    does NOT inject messages directly.
 *
 * Design guarantees:
 *  - NO Date.now() — all timestamps from injected nowMs.
 *  - NO external APIs, no LLMs.
 *  - Fully deterministic.
 *  - Bounded memory — strategy history capped at maxStrategyHistory.
 *  - snapshot() / restore() — full replay support.
 *  - No side effects. No direct message emission.
 *
 * Authority: STRATEGY GENERATION only. Does NOT decide final intervention.
 *   Final decision remains with: session-orchestrator → policy → fatigue → ranking.
 *
 * Integration:
 *  - Called by session-orchestrator enrichment layer (injected dependency).
 *  - Output is ADDED to candidateProvider candidates (not replacing them).
 *  - Uses MESSAGE_FAMILIES from ope-constants.js (single taxonomy authority).
 *  - Passes rationale to decision-explainability-engine via candidate metadata.
 */

// ============================================================================
// Strategy types
// ============================================================================

const STRATEGY_TYPES = Object.freeze({
  COMPLEMENT:       'complement',       // Suggest a missing complement
  COMPATIBILITY:    'compatibility',    // Surface a compatibility check
  PREVENTION:       'prevention',       // Prevent likely return (risk-driven)
  BUNDLE:           'bundle',           // Complete a bundle
  REASSURANCE:      'reassurance',      // Reduce subjective-fit fear
  COMPLETION:       'completion',       // Complete meal/outfit/routine
  RECOVERY:         'recovery',         // Re-engage partial-abandon
  SETUP_ASSISTANCE: 'setup_assistance', // Guide through technical setup
  SIZE_GUIDANCE:    'size_guidance',    // Guide to correct size selection
});

// Strategy → MESSAGE_FAMILY mapping
// All families are from ope-constants.js MESSAGE_FAMILIES (single taxonomy authority)
const STRATEGY_TO_FAMILY = Object.freeze({
  [STRATEGY_TYPES.COMPLEMENT]:       'COMPATIBILITY',   // Product fit / accessory
  [STRATEGY_TYPES.COMPATIBILITY]:    'COMPATIBILITY',
  [STRATEGY_TYPES.PREVENTION]:       'REASSURANCE',     // Prevention via reassurance
  [STRATEGY_TYPES.BUNDLE]:           'BENEFIT',         // Bundle value proposition
  [STRATEGY_TYPES.REASSURANCE]:      'REASSURANCE',
  [STRATEGY_TYPES.COMPLETION]:       'EXPERTISE',       // Expert guidance on completion
  [STRATEGY_TYPES.RECOVERY]:         'RECOVERY',
  [STRATEGY_TYPES.SETUP_ASSISTANCE]: 'EXPERTISE',
  [STRATEGY_TYPES.SIZE_GUIDANCE]:    'COMPATIBILITY',
});

// Strategy intensity defaults (aligns with message-ranking-engine intensity schema)
const STRATEGY_INTENSITY = Object.freeze({
  [STRATEGY_TYPES.COMPLEMENT]:       0.5,
  [STRATEGY_TYPES.COMPATIBILITY]:    0.4,
  [STRATEGY_TYPES.PREVENTION]:       0.6,
  [STRATEGY_TYPES.BUNDLE]:           0.4,
  [STRATEGY_TYPES.REASSURANCE]:      0.3,
  [STRATEGY_TYPES.COMPLETION]:       0.5,
  [STRATEGY_TYPES.RECOVERY]:         0.6,
  [STRATEGY_TYPES.SETUP_ASSISTANCE]: 0.5,
  [STRATEGY_TYPES.SIZE_GUIDANCE]:    0.4,
});

// ============================================================================
// Constants
// ============================================================================

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE    = 'RelationshipMessageStrategyEngine';

const DEFAULT_CONFIG = Object.freeze({
  maxStrategyHistory:    256,
  maxCandidatesPerCycle: 5,    // max strategy candidates to produce per evaluate() call
  minOpportunityScore:   0.40, // minimum completionScore to consider an opportunity
  minRiskTierForPrevention: 'moderate', // 'moderate' | 'high'
});

// ============================================================================
// Helpers
// ============================================================================

function _assertFiniteNumber(val, label) {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new TypeError(`RelationshipMessageStrategyEngine: ${label} must be a finite number, got ${val}`);
  }
}

class LRUMap {
  constructor(cap) {
    this._cap = cap;
    this._map = new Map();
  }
  get size() { return this._map.size; }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    while (this._map.size > this._cap) {
      this._map.delete(this._map.keys().next().value);
    }
  }
  has(key) { return this._map.has(key); }
  delete(key) { return this._map.delete(key); }
  clear() { this._map.clear(); }
  entries() { return this._map.entries(); }
}

function _safeArrayPush(arr, item, cap) {
  arr.push(item);
  while (arr.length > cap) arr.shift();
}

// Imports from existing runtime
let _ope_constants = null;
function _getOPEConstants() {
  if (!_ope_constants) {
    try { _ope_constants = require('./ope-constants'); } catch { _ope_constants = {}; }
  }
  return _ope_constants;
}

// ============================================================================
// RelationshipMessageStrategyEngine
// ============================================================================

class RelationshipMessageStrategyEngine {
  /**
   * @param {object} intentCompletionEngine     — IntentCompletionEngine instance
   * @param {object} returnRiskEngine           — ReturnRiskIntelligenceEngine instance
   * @param {object} [config]
   */
  constructor(intentCompletionEngine, returnRiskEngine, config = {}) {
    if (!intentCompletionEngine || typeof intentCompletionEngine.getOpportunities !== 'function') {
      throw new TypeError('RelationshipMessageStrategyEngine: intentCompletionEngine required');
    }
    if (!returnRiskEngine || typeof returnRiskEngine.assess !== 'function') {
      throw new TypeError('RelationshipMessageStrategyEngine: returnRiskEngine required');
    }

    this._intentEngine  = intentCompletionEngine;
    this._riskEngine    = returnRiskEngine;
    this._config        = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    /** Log of produced strategy candidates */
    this._strategyHistory = [];

    this._seq      = 0;
    this._disposed = false;
  }

  // ==========================================================================
  // Core API
  // ==========================================================================

  /**
   * Generate strategy candidates based on current session context.
   * This is the primary output that gets injected into the
   * candidateProvider pipeline consumed by session-orchestrator.
   *
   * IMPORTANT: This method does NOT trigger interventions.
   * It returns strategy candidates that pass through the full
   * session-orchestrator → policy → fatigue → ranking pipeline.
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.context          — current context (from OPE_VALID_CONTEXTS)
   * @param {string} params.intentState      — current intent state from unified-intent-engine
   * @param {number} params.fatigueScore     — from cooldown-fatigue-engine
   * @param {object[]} params.cartProducts   — for risk assessment
   * @param {object[]} params.viewedProducts — for risk assessment
   * @param {number} params.nowMs
   * @returns {StrategyCandidate[]}
   */
  generateCandidates({
    sessionId,
    context,
    intentState,
    fatigueScore = 0,
    cartProducts = [],
    viewedProducts = [],
    nowMs,
  }) {
    _assertFiniteNumber(nowMs, 'generateCandidates.nowMs');
    if (this._disposed) throw new Error('RelationshipMessageStrategyEngine: disposed');

    const candidates = [];

    // ── 1. Intent completion opportunities ───────────────────────────────────
    const opportunities = this._intentEngine.getOpportunities(nowMs);

    for (const opp of opportunities) {
      if (opp.completionScore < this._config.minOpportunityScore) continue;

      const strategyType = this._opportunityTypeToStrategy(opp.opportunityType);
      if (!strategyType) continue;

      const family    = STRATEGY_TO_FAMILY[strategyType];
      const intensity = STRATEGY_INTENSITY[strategyType];

      // Adjust priority by intent state
      const intentMultiplier = this._intentMultiplier(intentState);
      const priority = Math.min(1, opp.completionScore * intentMultiplier);

      candidates.push({
        // Required by message-ranking-engine schema
        id:       `rel_${strategyType}_${opp.opportunityId}`,
        family,
        subtype:  strategyType,
        intensity,

        // Strategy metadata
        strategyType,
        priority: Math.round(priority * 1000) / 1000,
        confidence: opp.completionScore,
        confidenceTier: opp.confidenceTier,

        // Explainability (causal audit trail)
        rationale: [
          ...opp.rationale,
          `strategy_type:${strategyType}`,
          `intent_state:${intentState || 'unknown'}`,
          `context:${context || 'unknown'}`,
          `opportunity_type:${opp.opportunityType}`,
          `missing_subcategory:${opp.missingSubcategory}`,
          `triggered_by:${opp.triggeredBySubcategory}`,
        ],

        // Relationship-specific payload (consumed by human-message-engine)
        relationshipContext: {
          opportunityType:          opp.opportunityType,
          missingSubcategory:       opp.missingSubcategory,
          triggeredBySubcategory:   opp.triggeredBySubcategory,
          relationshipType:         opp.relationshipType,
          inCartContext:            opp.inCartContext,
          revisitContext:           opp.revisitContext,
        },

        // Source
        source: 'relationship_intelligence',
        generatedAt: nowMs,
      });
    }

    // ── 2. Return risk prevention candidates ──────────────────────────────────
    if (cartProducts.length > 0 || viewedProducts.length > 0) {
      const riskAssessment = this._riskEngine.assess({ cartProducts, viewedProducts, nowMs });

      const { RISK_TIERS } = require('./return-risk-intelligence-engine');

      const riskThresholdMet = riskAssessment.riskTier === RISK_TIERS.HIGH ||
        (this._config.minRiskTierForPrevention === 'moderate' && riskAssessment.riskTier === RISK_TIERS.MODERATE);

      if (riskThresholdMet) {
        for (const prevention of riskAssessment.preventionOpportunities.slice(0, 2)) {
          const strategyType = this._preventionToStrategy(prevention.type);
          const family    = STRATEGY_TO_FAMILY[strategyType];
          const intensity = STRATEGY_INTENSITY[strategyType];

          // Prevention candidates are priority-boosted when risk is HIGH
          const riskPriorityBoost = riskAssessment.riskTier === RISK_TIERS.HIGH ? 1.2 : 1.0;
          const priority = Math.min(1, prevention.priority * riskPriorityBoost);

          candidates.push({
            id:       `rel_prevention_${strategyType}_${this._seq++}`,
            family,
            subtype:  strategyType,
            intensity,

            strategyType,
            priority: Math.round(priority * 1000) / 1000,
            confidence: riskAssessment.riskScore,

            rationale: [
              ...prevention.rationale,
              `risk_tier:${riskAssessment.riskTier}`,
              `risk_score:${riskAssessment.riskScore}`,
              `prevention_type:${prevention.type}`,
              `strategy_type:${strategyType}`,
              `intent_state:${intentState || 'unknown'}`,
            ],

            relationshipContext: {
              opportunityType:         prevention.type,
              missingSubcategory:      prevention.missingSubcategory || null,
              triggeredBySubcategory:  prevention.fromSubcategory || null,
              relationshipType:        null,
              riskTier:                riskAssessment.riskTier,
              riskScore:               riskAssessment.riskScore,
            },

            source: 'relationship_risk_intelligence',
            generatedAt: nowMs,
          });
        }
      }
    }

    // Sort by priority desc, cap output
    candidates.sort((a, b) => b.priority - a.priority);
    const result = candidates.slice(0, this._config.maxCandidatesPerCycle);

    // Log to strategy history (bounded)
    _safeArrayPush(this._strategyHistory, {
      sessionId,
      context,
      intentState,
      fatigueScore,
      generatedCount: result.length,
      nowMs,
    }, this._config.maxStrategyHistory);

    return result;
  }

  // ==========================================================================
  // Mapping helpers
  // ==========================================================================

  _opportunityTypeToStrategy(opportunityType) {
    const { OPPORTUNITY_TYPES } = require('./intent-completion-engine');
    switch (opportunityType) {
      case OPPORTUNITY_TYPES.MEAL_COMPLETION:       return STRATEGY_TYPES.COMPLETION;
      case OPPORTUNITY_TYPES.OUTFIT_COMPLETION:     return STRATEGY_TYPES.COMPLETION;
      case OPPORTUNITY_TYPES.SETUP_COMPLETION:      return STRATEGY_TYPES.SETUP_ASSISTANCE;
      case OPPORTUNITY_TYPES.SKINCARE_ROUTINE:      return STRATEGY_TYPES.COMPLETION;
      case OPPORTUNITY_TYPES.MISSING_ACCESSORY:     return STRATEGY_TYPES.COMPLEMENT;
      case OPPORTUNITY_TYPES.REVISIT_HIGH_INTEREST: return STRATEGY_TYPES.COMPLEMENT;
      case OPPORTUNITY_TYPES.BUNDLE_COMPLETION:     return STRATEGY_TYPES.BUNDLE;
      case OPPORTUNITY_TYPES.CONSUMABLE_DEPENDENCY: return STRATEGY_TYPES.SETUP_ASSISTANCE;
      case OPPORTUNITY_TYPES.PARTIAL_ABANDON:       return STRATEGY_TYPES.RECOVERY;
      case OPPORTUNITY_TYPES.HESITATION_WITH_MISSING: return STRATEGY_TYPES.COMPLEMENT;
      default:                                      return STRATEGY_TYPES.COMPLEMENT;
    }
  }

  _preventionToStrategy(preventionType) {
    const { PREVENTION_OPPORTUNITY_TYPES } = require('./return-risk-intelligence-engine');
    switch (preventionType) {
      case PREVENTION_OPPORTUNITY_TYPES.ADD_MISSING_COMPONENT: return STRATEGY_TYPES.PREVENTION;
      case PREVENTION_OPPORTUNITY_TYPES.VERIFY_COMPATIBILITY:  return STRATEGY_TYPES.COMPATIBILITY;
      case PREVENTION_OPPORTUNITY_TYPES.COMPLETE_SETUP:        return STRATEGY_TYPES.SETUP_ASSISTANCE;
      case PREVENTION_OPPORTUNITY_TYPES.REASSURE_AND_ANCHOR:   return STRATEGY_TYPES.REASSURANCE;
      case PREVENTION_OPPORTUNITY_TYPES.SIZE_GUIDANCE:         return STRATEGY_TYPES.SIZE_GUIDANCE;
      case PREVENTION_OPPORTUNITY_TYPES.SKINCARE_CORRECTION:   return STRATEGY_TYPES.COMPLETION;
      default:                                                 return STRATEGY_TYPES.PREVENTION;
    }
  }

  /**
   * Intent-state multiplier for opportunity priority.
   * High-intent states amplify relationship opportunities.
   */
  _intentMultiplier(intentState) {
    if (!intentState) return 1.0;
    const OPE = _getOPEConstants();
    const STATES = OPE.INTENT_STATES || {};

    switch (intentState) {
      case STATES.PURCHASE_READY:  return 1.30;  // Near purchase: show what's missing
      case STATES.HIGH_INTENT:     return 1.20;  // High interest: complement is valuable
      case STATES.EVALUATING:      return 1.10;  // Evaluating: info helps
      case STATES.HESITATING:      return 1.15;  // Hesitating: missing complement may resolve
      case STATES.EXIT_RISK:       return 0.90;  // Exit risk: don't overwhelm
      case STATES.DISENGAGING:     return 0.70;  // Disengaging: minimal intervention
      default:                     return 1.00;
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  cleanup() {
    // Bounded by safeArrayPush on _strategyHistory; no explicit purge needed.
  }

  dispose() {
    this._disposed = true;
    this._strategyHistory = [];
  }

  // ==========================================================================
  // Snapshot / Restore
  // ==========================================================================

  snapshot() {
    return {
      __type:          SCHEMA_TYPE,
      __version:       SCHEMA_VERSION,
      seq:             this._seq,
      strategyHistory: [...this._strategyHistory],
    };
  }

  restore(snap) {
    if (!snap || snap.__type !== SCHEMA_TYPE) return false;
    if (snap.__version !== SCHEMA_VERSION) return false;

    this._seq             = typeof snap.seq === 'number' ? snap.seq : 0;
    this._strategyHistory = Array.isArray(snap.strategyHistory) ? [...snap.strategyHistory] : [];
    return true;
  }

  getDiagnostics() {
    return {
      strategyHistoryLength: this._strategyHistory.length,
      seq:                   this._seq,
      disposed:              this._disposed,
    };
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  RelationshipMessageStrategyEngine,
  STRATEGY_TYPES,
  STRATEGY_TO_FAMILY,
  STRATEGY_INTENSITY,
};
