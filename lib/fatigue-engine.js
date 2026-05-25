'use strict';

/**
 * fatigue-engine.js — DEPRECATED FACADE (v2 — enterprise restructure)
 *
 * This module has been superseded by cooldown-fatigue-engine.js as part of
 * the enterprise architectural restructure.
 *
 * SINGLE FATIGUE AUTHORITY: CooldownFatigueEngine
 *
 * The original fatigue-engine was a projection-based, stateless scorer.
 * The cooldown-fatigue-engine is the enterprise-grade authority with:
 *   - Global + context + family fatigue decomposition
 *   - Exponential decay with materialized anchors
 *   - Atomic acquire/commit/rollback
 *   - LRU eviction, idempotency, sliding windows
 *   - Saturation detection
 *
 * This file re-exports a compatibility shim that maps the original API
 * to cooldown-fatigue-engine calls. Callers should migrate directly to
 * CooldownFatigueEngine.
 *
 * MIGRATION GUIDE:
 *   Replace:  const fe = require('./fatigue-engine')
 *   With:     const { CooldownFatigueEngine } = require('./cooldown-fatigue-engine')
 */

const { CooldownFatigueEngine, DEFAULT_CONFIG: CFE_CONFIG } = require('./cooldown-fatigue-engine');

// ============================================================================
// LEGACY CONFIG (mapped to cooldown-fatigue-engine equivalents)
// ============================================================================

const CONFIG = Object.freeze({
  baseCooldownSec: Math.round(CFE_CONFIG.globalCooldownMs / 1000),
  minCooldownSec: 10,
  maxCooldownSec: 300,
  suppressionCooldownMultiplier: 1.5,

  fatigueMin: 0.0,
  fatigueMax: CFE_CONFIG.fatigueMax,

  pressureLow: 0.2,
  pressureModerate: 0.4,
  pressureHigh: 0.65,
  pressureExtreme: 0.85,

  pressureHysteresis: 0.07,
  regimeHysteresis: 0.07,

  decayHalfLifeSec: Math.round(CFE_CONFIG.fatigueHalfLifeMs / 1000),
  saturationHalfLifeSec: 180,

  densityWindowSec: 120,
  maxDensity: 5,

  overMessagingWindowSec: 300,
  overMessagingMaxCount: 8,
  overMessagingDismissRatio: 0.5,

  engagementRecoveryFactor: 0.15,
  dismissalAmplificationFactor: 1.5,
  contextWeightListing: 1.0,
  contextWeightModal: 0.7,
  contextWeightCheckout: 0.3,
});

// ============================================================================
// PURE HELPERS (preserved for backward compatibility)
// ============================================================================

function exponentialDecay(value, halfLifeSec, elapsedSec) {
  if (elapsedSec <= 0 || !Number.isFinite(elapsedSec)) return value;
  return value * Math.pow(0.5, elapsedSec / halfLifeSec);
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

function _isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ============================================================================
// PRESSURE LEVEL (pure function, same as original)
// ============================================================================

function computePressureLevel(fatigueScore, previousLevel = null) {
  const hyst = CONFIG.pressureHysteresis;
  let level;

  if (fatigueScore >= CONFIG.pressureExtreme) level = 'extreme';
  else if (fatigueScore >= CONFIG.pressureHigh) level = 'high';
  else if (fatigueScore >= CONFIG.pressureModerate) level = 'moderate';
  else if (fatigueScore >= CONFIG.pressureLow) level = 'low';
  else level = 'none';

  // Hysteresis: require dropping below threshold - margin to downgrade
  if (previousLevel) {
    const thresholds = {
      extreme: CONFIG.pressureExtreme,
      high: CONFIG.pressureHigh,
      moderate: CONFIG.pressureModerate,
      low: CONFIG.pressureLow,
    };
    const prevThreshold = thresholds[previousLevel];
    if (prevThreshold !== undefined && fatigueScore >= prevThreshold - hyst) {
      const order = ['none', 'low', 'moderate', 'high', 'extreme'];
      const prevIdx = order.indexOf(previousLevel);
      const newIdx = order.indexOf(level);
      if (newIdx < prevIdx) level = previousLevel;
    }
  }

  return level;
}

// ============================================================================
// FATIGUE REGIME (pure function, same as original)
// ============================================================================

function classifyFatigueRegime(fatigueScore, saturationScore, previousRegime = null) {
  const h = CONFIG.regimeHysteresis;
  const combined = fatigueScore * 0.7 + saturationScore * 0.3;

  let regime;
  if (combined >= 0.8) regime = 'exhausted';
  else if (combined >= 0.6) regime = 'saturated';
  else if (combined >= 0.35) regime = 'recovering';
  else regime = 'fresh';

  if (previousRegime) {
    const order = ['fresh', 'recovering', 'saturated', 'exhausted'];
    const prevIdx = order.indexOf(previousRegime);
    const newIdx = order.indexOf(regime);
    if (newIdx < prevIdx) {
      const thresholds = { exhausted: 0.8, saturated: 0.6, recovering: 0.35 };
      const prevT = thresholds[previousRegime];
      if (prevT !== undefined && combined >= prevT - h) regime = previousRegime;
    }
  }

  return regime;
}

// ============================================================================
// SHIM: Main API mapped to CooldownFatigueEngine
// ============================================================================

/**
 * computeFatigueScore — Legacy shim.
 * Creates a temporary CooldownFatigueEngine instance and computes effective fatigue.
 */
function computeFatigueScore({ recentMessages = [], recentSignals = [], sessionState = {}, fatigueMemory = {}, nowTs } = {}) {
  if (typeof nowTs !== 'number') throw new Error('fatigue-engine.computeFatigueScore requires nowTs');
  const engine = new CooldownFatigueEngine();
  // Restore from memory if available
  if (fatigueMemory && fatigueMemory.__schemaVersion) {
    try { engine.restore(fatigueMemory, nowTs); } catch (_) {}
  }

  const diag = engine.getDiagnostics(nowTs);
  return clamp(diag.effectiveFatigue, CONFIG.fatigueMin, CONFIG.fatigueMax);
}

function decayFatigue(fatigueMemory, nowTs) {
  if (typeof nowTs !== 'number') throw new Error('fatigue-engine.decayFatigue requires nowTs');
  if (!fatigueMemory || !_isFiniteNumber(fatigueMemory.saturationScore)) {
    return fatigueMemory || {};
  }
  const elapsed = (nowTs - (fatigueMemory.lastUpdate || nowTs)) / 1000;
  return {
    ...fatigueMemory,
    saturationScore: exponentialDecay(
      fatigueMemory.saturationScore,
      CONFIG.saturationHalfLifeSec,
      elapsed
    ),
    lastUpdate: nowTs,
  };
}

function computeSessionSaturation(recentMessages, nowTs) {
  if (!Array.isArray(recentMessages) || recentMessages.length === 0) return 0;
  const windowMs = CONFIG.densityWindowSec * 1000;
  const recent = recentMessages.filter(m => m && m.timestamp && (nowTs - m.timestamp) < windowMs);
  return clamp(recent.length / CONFIG.maxDensity, 0, 1);
}

function detectOverMessaging(recentMessages, nowTs) {
  const windowMs = CONFIG.overMessagingWindowSec * 1000;
  const recent = recentMessages.filter(m => m && m.timestamp && (nowTs - m.timestamp) < windowMs);
  const count = recent.length;
  const dismissals = recent.filter(m => m.interaction === 'dismiss' || m.interaction === 'close').length;
  const ratio = count > 0 ? dismissals / count : 0;

  const reasons = [];
  if (count > CONFIG.overMessagingMaxCount) reasons.push('excessive_count');
  if (ratio > CONFIG.overMessagingDismissRatio) reasons.push('high_dismiss_ratio');

  return {
    overMessaging: reasons.length > 0,
    reasons,
    count,
    dismissals,
    ratio,
  };
}

function computeDynamicCooldown({ fatigueScore, intentState, context, nowTs }) {
  let base = CONFIG.baseCooldownSec;
  if (fatigueScore > CONFIG.pressureHigh) base *= 2;
  else if (fatigueScore > CONFIG.pressureModerate) base *= 1.5;

  const contextWeights = {
    listing: CONFIG.contextWeightListing,
    modal: CONFIG.contextWeightModal,
    checkout: CONFIG.contextWeightCheckout,
  };
  const cw = contextWeights[context] || 1.0;
  base = Math.round(base * cw);

  return clamp(base, CONFIG.minCooldownSec, CONFIG.maxCooldownSec) * 1000;
}

function updateFatigueMemory(fatigueMemory, event, nowTs, expectedVersion) {
  const mem = { ...(fatigueMemory || {}), lastUpdate: nowTs };
  mem.version = (mem.version || 0) + 1;

  if (expectedVersion !== undefined && expectedVersion !== (fatigueMemory?.version || 0)) {
    return { memory: mem, conflict: true };
  }

  if (event.type === 'message_shown') {
    mem.saturationScore = clamp((mem.saturationScore || 0) + 0.05, 0, 1);
    mem.cumulativeMessages = (mem.cumulativeMessages || 0) + 1;
  } else if (event.type === 'dismiss') {
    mem.saturationScore = clamp((mem.saturationScore || 0) + 0.15, 0, 1);
    mem.cumulativeDismissals = (mem.cumulativeDismissals || 0) + 1;
  } else if (event.type === 'positive_signal') {
    mem.saturationScore = clamp((mem.saturationScore || 0) - 0.1, 0, 1);
  }

  return { memory: mem, conflict: false };
}

function shouldSuppressMessage({ sessionState = {}, recentSignals = [], recentMessages = [], fatigueMemory = {}, previousPressureLevel = null, nowTs } = {}) {
  if (typeof nowTs !== 'number') throw new Error('fatigue-engine.shouldSuppressMessage requires nowTs');
  const fatigueScore = computeFatigueScore({ recentMessages, recentSignals, sessionState, fatigueMemory, nowTs });
  const pressureLevel = computePressureLevel(fatigueScore, previousPressureLevel);
  const saturationScore = computeSessionSaturation(recentMessages, nowTs);
  const overMessaging = detectOverMessaging(recentMessages, nowTs);
  const cooldownMs = computeDynamicCooldown({ fatigueScore, intentState: sessionState.intentState, context: sessionState.context, nowTs });

  const decayedMemory = decayFatigue(fatigueMemory, nowTs);

  let suppress = false;
  let reason = null;

  if (decayedMemory.cooldownUntil && nowTs < decayedMemory.cooldownUntil) {
    suppress = true;
    reason = 'cooldown_active';
  } else if (pressureLevel === 'extreme') {
    suppress = true;
    reason = 'extreme_fatigue';
  } else if (overMessaging.overMessaging) {
    suppress = true;
    reason = 'over_messaging';
  } else if (saturationScore > 0.8) {
    suppress = true;
    reason = 'excessive_density';
  }

  if (suppress && reason !== 'cooldown_active') {
    const armed = nowTs + Math.round(cooldownMs * CONFIG.suppressionCooldownMultiplier);
    decayedMemory.cooldownUntil = Math.max(decayedMemory.cooldownUntil || 0, armed);
  } else if (!suppress && fatigueScore > 0.3) {
    decayedMemory.cooldownUntil = nowTs + cooldownMs;
  }

  return {
    suppress,
    reason: suppress ? reason : null,
    fatigueScore,
    cooldownMs,
    nextEvaluateAt: decayedMemory.cooldownUntil || nowTs + cooldownMs,
    pressureLevel,
    saturationScore,
    overMessaging,
    updatedFatigueMemory: decayedMemory,
  };
}

/**
 * calculateFatigueState — Legacy main orchestrator.
 * This is the primary API for backward compatibility.
 */
function calculateFatigueState({
  sessionState = {},
  recentSignals = [],
  recentMessages = [],
  fatigueMemory = {},
  previousPressureLevel = null,
  previousFatigueRegime = null,
  nowTs,
} = {}) {
  if (typeof nowTs !== 'number') throw new Error('fatigue-engine.calculateFatigueState requires nowTs');
  const decision = shouldSuppressMessage({
    sessionState,
    recentSignals,
    recentMessages,
    fatigueMemory,
    previousPressureLevel,
    nowTs,
  });

  const fatigueRegime = classifyFatigueRegime(
    decision.fatigueScore,
    decision.saturationScore,
    previousFatigueRegime
  );

  const featureVector = {
    fatigueScore: decision.fatigueScore,
    saturationScore: decision.saturationScore,
    pressureLevel: decision.pressureLevel,
    fatigueRegime,
    cooldownMs: decision.cooldownMs,
    suppress: decision.suppress ? 1 : 0,
    intent: sessionState.intentState || null,
    emotionalState: sessionState.emotionalState || null,
    frictionLevel: _isFiniteNumber(sessionState.frictionLevel) ? sessionState.frictionLevel : 0,
    momentumScore: _isFiniteNumber(sessionState.momentumScore) ? sessionState.momentumScore : 0,
    recentMessagesCount: recentMessages.length,
    recentDismissals: recentMessages.filter(
      m => m && (m.interaction === 'dismiss' || m.interaction === 'close')
    ).length,
    recentClicks: recentMessages.filter(m => m && m.interaction === 'click').length,
    overMessaging: decision.overMessaging.overMessaging ? 1 : 0,
    nowTs,
  };

  return {
    fatigueScore: decision.fatigueScore,
    pressureLevel: decision.pressureLevel,
    cooldownMs: decision.cooldownMs,
    nextEvaluateAt: decision.nextEvaluateAt,
    suppress: decision.suppress,
    suppressionReason: decision.reason,
    saturationScore: decision.saturationScore,
    fatigueRegime,
    overMessaging: decision.overMessaging.overMessaging,
    overMessagingDetails: decision.overMessaging.reasons,
    diagnostics: {
      totalMessages: recentMessages.length,
      dismissals: featureVector.recentDismissals,
      clicks: featureVector.recentClicks,
      friction: featureVector.frictionLevel,
      intent: featureVector.intent,
      memoryVersion: decision.updatedFatigueMemory.version,
    },
    featureVector,
    updatedFatigueMemory: decision.updatedFatigueMemory,
  };
}

// ============================================================================
// EXPORTS (backward compatible)
// ============================================================================

module.exports = {
  calculateFatigueState,
  computeFatigueScore,
  shouldSuppressMessage,
  computeDynamicCooldown,
  computePressureLevel,
  updateFatigueMemory,
  decayFatigue,
  computeSessionSaturation,
  detectOverMessaging,
  classifyFatigueRegime,
  exponentialDecay,
  CONFIG,
};
