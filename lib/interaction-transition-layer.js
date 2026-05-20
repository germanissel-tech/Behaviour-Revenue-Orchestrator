'use strict';

/**
 * interaction-transition-layer.js — DEPRECATED FACADE (v2 — enterprise restructure)
 *
 * This module has been superseded by unified-intent-engine.js as part of
 * the enterprise architectural restructure. Hysteresis, momentum, oscillation
 * detection, and probabilistic stabilization are now integrated directly into
 * the unified engine.
 *
 * This file provides a backward-compatible shim that wraps unified-intent-engine
 * and exposes the original InteractionTransitionLayer class API.
 *
 * MIGRATION GUIDE:
 *   Replace:  const { InteractionTransitionLayer } = require('./interaction-transition-layer')
 *   With:     const uie = require('./unified-intent-engine')
 *
 * IMPORTANT: No new logic should be added here. This is a compatibility shim.
 */

const {
  INTENT_STATES,
  VALID_INTENT_STATES,
  INTENT_VALENCE,
  normalizeIntentState,
} = require('./ope-constants');

const unifiedEngine = require('./unified-intent-engine');

// ============================================================================
// LEGACY CONSTANTS (re-exported for backward compatibility)
// ============================================================================

const STATE_ORDER = Object.freeze([
  'exploring', 'evaluating', 'comparing', 'hesitating',
  'high_intent', 'purchase_ready', 'disengaging', 'exit_risk'
]);

const DEFAULT_CONFIG = Object.freeze({
  // Hysteresis
  minTimeInState:             5000,
  minConfidenceToTransition:  0.45,
  confidenceDecayRate:        0.03,

  // Momentum
  momentumDecayRate:          0.15,
  momentumAccelerationFactor: 0.25,

  // Context awareness
  contextWeights: Object.freeze({
    listing:        0.8,
    product_detail: 1.0,
    modal:          1.2,
    hover_cta:      1.5,
    cart:           1.3,
    checkout:       1.6,
  }),

  // Evidence
  evidenceDecayRate:          0.05,
  maxEvidenceBufferSize:      50,

  // Interaction weights
  interactionWeights: Object.freeze({
    click:       0.8,
    hover:       0.3,
    scroll:      0.2,
    modal_open:  0.6,
    cta_click:   0.9,
    cta_hover:   0.5,
    exit_intent: -0.7,
    back_button: -0.4,
  }),

  // Oscillation
  oscillationWindowMs:          60000,
  maxOscillationsPerWindow:     2,
  oscillationPenaltyFactor:     0.5,

  // Stability
  maxTransitionHistorySize:     20,

  // Snapshot version
  snapshotVersion:              2,
});

// Build a simple transition matrix from the unified engine's ALLOWED_TRANSITIONS
// for backward compatibility. The actual transition logic is now in unified-intent-engine.
const TRANSITION_MATRIX = Object.freeze(
  STATE_ORDER.reduce((matrix, fromState) => {
    matrix[fromState] = STATE_ORDER.reduce((row, toState) => {
      if (fromState === toState) {
        row[toState] = 0.5; // self-transition (stay)
      } else {
        const edges = unifiedEngine.ALLOWED_TRANSITIONS[fromState] || [];
        const hasEdge = edges.some(e => e.to === toState);
        row[toState] = hasEdge ? 0.1 : 0.0;
      }
      return row;
    }, {});
    return matrix;
  }, {})
);

// ============================================================================
// COMPATIBILITY SHIM: InteractionTransitionLayer class
// ============================================================================

class InteractionTransitionLayer {
  /**
   * @param {object} [config] - Configuration overrides (mapped to unified engine config)
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._session = null;
    this._initialized = false;
    this._lastResult = null;
  }

  /**
   * Initialize with a starting state.
   * @param {string} initialState
   * @param {number} now - Current timestamp in ms
   */
  initialize(initialState = 'exploring', now) {
    const normalized = normalizeIntentState(initialState);
    this._session = unifiedEngine.createSession(`itl-${now || 0}`, {
      hysteresisTimeMs:           this.config.minTimeInState,
      confidenceToTransition:     this.config.minConfidenceToTransition,
      oscillationWindowMs:        this.config.oscillationWindowMs,
      maxOscillationsPerWindow:   this.config.maxOscillationsPerWindow,
      oscillationPenaltyFactor:   this.config.oscillationPenaltyFactor,
      contextWeights:             this.config.contextWeights,
    });

    // Force initial state if different from default
    if (normalized !== 'exploring') {
      // Warm up the session by setting its internal state
      this._session.currentState = normalized;
      this._session.stateEnteredAt = now || 0;
    }
    if (now) {
      this._session.lastUpdate = now;
      this._session.stateEnteredAt = this._session.stateEnteredAt || now;
    }

    this._initialized = true;
    this._lastResult = {
      previousState: normalized,
      currentState: normalized,
      transitionProbability: 1.0,
      confidence: this._session.confidence,
      momentum: this._session.momentum,
      momentumDirection: 0,
      stateStability: 0.3,
      stateChanged: false,
      hysteresisApplied: false,
      oscillationRisk: false,
      context: 'listing',
    };
    return this._lastResult;
  }

  /**
   * Process an intent state observation.
   * Maps the old API (receives a state suggestion) to the unified engine
   * (receives signals).
   *
   * @param {string} observedState - The state suggested by the caller
   * @param {number} now - Current timestamp in ms
   * @returns {object} Transition result
   */
  processIntentState(observedState, now) {
    if (!this._initialized || !this._session) {
      return this.initialize(observedState, now);
    }

    const previousState = this._session.currentState;

    // Map observed state to a synthetic signal that the unified engine understands.
    // The unified engine uses engagement/uncertainty axes, so we synthesize
    // signals that push toward the observed state's valence.
    const valence = INTENT_VALENCE[observedState] || 0;
    const syntheticSignals = [];

    if (valence > 0) {
      syntheticSignals.push({ type: 'view_reviews', ts: now });
      syntheticSignals.push({ type: 'variant_click', ts: now });
      if (valence > 0.5 || observedState === 'high_intent' || observedState === 'purchase_ready') {
        syntheticSignals.push({ type: 'add_to_cart', ts: now });
      }
      if (observedState === 'purchase_ready') {
        syntheticSignals.push({ type: 'start_checkout', ts: now });
      }
    } else if (valence < 0) {
      syntheticSignals.push({ type: 'exit_intent', ts: now });
      syntheticSignals.push({ type: 'back_button', ts: now });
    } else {
      syntheticSignals.push({ type: 'page_scroll', ts: now });
      syntheticSignals.push({ type: 'search', ts: now });
    }

    const result = this._session.update(syntheticSignals, now);

    this._lastResult = {
      previousState,
      currentState: result.state,
      transitionProbability: result.confidence,
      confidence: result.confidence,
      momentum: result.momentum,
      momentumDirection: result.momentumDirection,
      stateStability: result.stateStability,
      stateChanged: result.stateChanged,
      hysteresisApplied: result.hysteresisApplied,
      oscillationRisk: result.oscillationRisk,
      context: result.context,
    };
    return this._lastResult;
  }

  /**
   * Record an interaction event.
   * @param {string} interactionType
   * @param {number} now
   */
  recordInteraction(interactionType, now) {
    if (!this._session) return;
    // Map interaction type to a recognized signal if possible
    const mapped = this._mapInteraction(interactionType);
    if (mapped) {
      this._session.update([{ type: mapped, ts: now }], now);
    }
  }

  /**
   * Set the current UI context.
   * @param {string} ctx - listing, product_detail, modal, cart, checkout, etc.
   * @param {number} now
   */
  setContext(ctx, now) {
    if (!this._session) return;
    this._session.setContext(ctx);
  }

  /**
   * Get the current state without mutation.
   * @param {number} now
   */
  getCurrentState(now) {
    if (!this._session) return 'exploring';
    return this._session.currentState;
  }

  /**
   * Get diagnostics.
   * @param {number} now
   */
  getDiagnostics(now) {
    if (!this._session) {
      return { state: 'exploring', confidence: 0, momentum: 0, stateStability: 0 };
    }
    const snap = this._session.decayedSnapshot(now);
    return {
      state: snap.state,
      confidence: snap.confidence,
      momentum: snap.momentum,
      stateStability: snap.stateStability,
      oscillationRisk: snap.oscillationRisk,
      momentumDirection: snap.momentumDirection,
      engagement: snap.engagement,
      uncertainty: snap.uncertainty,
    };
  }

  /**
   * Serialize state for persistence.
   */
  snapshot() {
    if (!this._session) return null;
    return {
      ...this._session.serialize(),
      _facade: 'interaction-transition-layer',
      _facadeVersion: 2,
    };
  }

  /**
   * Restore from a snapshot.
   * @param {object} snapshot
   * @param {number} now
   */
  restore(snapshot, now) {
    if (!snapshot) return;
    try {
      this._session = unifiedEngine.restoreSession(snapshot, {
        hysteresisTimeMs:         this.config.minTimeInState,
        confidenceToTransition:   this.config.minConfidenceToTransition,
        oscillationWindowMs:      this.config.oscillationWindowMs,
        oscillationPenaltyFactor: this.config.oscillationPenaltyFactor,
        contextWeights:           this.config.contextWeights,
      });
      this._initialized = true;
    } catch (_) {
      // If restore fails, re-initialize
      this.initialize(snapshot.currentState || 'exploring', now);
    }
  }

  /**
   * Reset to initial state.
   * @param {number} now
   */
  reset(now) {
    this.initialize('exploring', now);
  }

  // --- Private helpers ---

  _mapInteraction(type) {
    const MAP = {
      click:       'variant_click',
      hover:       'hover',
      scroll:      'page_scroll',
      modal_open:  'modal_open',
      cta_click:   'cta_click',
      cta_hover:   'cta_hover',
      exit_intent: 'exit_intent',
      back_button: 'back_button',
    };
    return MAP[type] || null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  InteractionTransitionLayer,
  DEFAULT_CONFIG,
  TRANSITION_MATRIX,
  STATE_ORDER,
};
module.exports.default = InteractionTransitionLayer;
