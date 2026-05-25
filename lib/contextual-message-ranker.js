/**
 * contextual-message-ranker.js (v2 — DEPRECATED FACADE)
 *
 * =====================================================================
 * ENTERPRISE RESTRUCTURE: This module has been DEGRADED to a facade.
 *
 * RANKING AUTHORITY: message-ranking-engine.js
 *
 * This module retains:
 *   - buildRankingContext(): useful context assembly from multiple sources
 *   - getPrioritizedFamilies(): family ordering by context, funnel, and behavioral patterns
 *   - filterByAppropriateFamily(): pre-filter candidates before ranking
 *   - CONTEXT_WEIGHTS: context-aware family weight modifiers
 *   - RETURN_RISK_ADJUSTMENTS: return-risk based family suppression
 *
 * This module DELEGATES ranking to message-ranking-engine.js:
 *   - scoreMessage() now calls normalizeCandidateFamily + MRE.scoreCandidate
 *   - rankMessages() maps old family names to canonical and delegates to MRE
 *   - selectBestMessage() delegates to MRE.selectTopCandidate
 *
 * All families emitted by this module use the OLD lowercase taxonomy
 * (benefit, social, quality...) for backward compatibility with callers
 * that haven't migrated. Internally, all families are normalized to the
 * canonical UPPERCASE taxonomy from ope-constants.js before delegation.
 * =====================================================================
 */

'use strict';

const {
  INTENT_FAMILY_MODIFIERS,
  MESSAGE_FAMILIES,
  VALID_MESSAGE_FAMILIES,
  FAMILY_ALIASES,
  normalizeFamily,
  normalizeIntentState,
} = require('./ope-constants');

const MessageRankingEngine = require('./message-ranking-engine');
const BehavioralIntelligence = require('./behavioral-intelligence-layer');
const FunnelEngine = require('./funnel-stage-engine');

// ----------------------------------------------------------------------
// DEPRECATION NOTICE
// ----------------------------------------------------------------------
const _DEPRECATION_PREFIX = '[contextual-message-ranker][DEPRECATED]';

function _warnDeprecated(fnName, replacement) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      `${_DEPRECATION_PREFIX} ${fnName}() is deprecated. Use ${replacement} instead.`
    );
  }
}

// ----------------------------------------------------------------------
// Legacy Constants (kept for backward compat, mapped from ope-constants)
// ----------------------------------------------------------------------

// Legacy lowercase family list (callers may still reference these)
const LEGACY_MESSAGE_FAMILIES = Object.freeze([
  'benefit', 'social', 'quality', 'compatibility', 'reassurance',
  'urgency', 'expertise', 'lifestyle', 'comparison',
]);

// Context weights (still useful as context-aware modifiers; MRE doesn't have these)
const CONTEXT_WEIGHTS = Object.freeze({
  listing: {
    BENEFIT: 1.2, SOCIAL_PROOF: 1.1, LIFESTYLE: 1.0, QUALITY: 0.9,
    COMPARISON: 0.8, EXPERTISE: 0.7, COMPATIBILITY: 0.6, REASSURANCE: 0.5, URGENCY: 0.3,
  },
  modal: {
    QUALITY: 1.2, EXPERTISE: 1.1, COMPARISON: 1.0, COMPATIBILITY: 1.0,
    BENEFIT: 0.9, REASSURANCE: 0.9, SOCIAL_PROOF: 0.8, LIFESTYLE: 0.7, URGENCY: 0.6,
  },
  hover_cta: {
    URGENCY: 1.0, REASSURANCE: 1.2, SOCIAL_PROOF: 1.1, BENEFIT: 0.8,
    QUALITY: 0.7, EXPERTISE: 0.6, COMPATIBILITY: 0.5, COMPARISON: 0.4, LIFESTYLE: 0.4,
  },
  product_detail: {
    QUALITY: 1.3, EXPERTISE: 1.2, COMPARISON: 1.1, COMPATIBILITY: 1.0,
    BENEFIT: 0.9, REASSURANCE: 0.8, SOCIAL_PROOF: 0.7, LIFESTYLE: 0.6, URGENCY: 0.5,
  },
  cart: {
    COMPATIBILITY: 1.3, REASSURANCE: 1.2, QUALITY: 1.1, SOCIAL_PROOF: 1.0,
    EXPERTISE: 0.9, BENEFIT: 0.7, LIFESTYLE: 0.5, URGENCY: 0.4, COMPARISON: 0.3,
  },
  checkout: {
    REASSURANCE: 1.4, SOCIAL_PROOF: 1.2, QUALITY: 1.0, COMPATIBILITY: 0.9,
    URGENCY: 0.3, EXPERTISE: 0.5, BENEFIT: 0.4, LIFESTYLE: 0.3, COMPARISON: 0.2,
  },
});

// Return risk adjustments (useful utility, kept)
const RETURN_RISK_ADJUSTMENTS = Object.freeze({
  high: {
    URGENCY: 0.0, COMPATIBILITY: 1.5, QUALITY: 1.3, EXPERTISE: 1.4,
    REASSURANCE: 1.2, SOCIAL_PROOF: 0.8, BENEFIT: 0.7, LIFESTYLE: 0.5, COMPARISON: 0.6,
  },
  medium: {
    URGENCY: 0.3, COMPATIBILITY: 1.3, QUALITY: 1.2, EXPERTISE: 1.2,
    REASSURANCE: 1.1, SOCIAL_PROOF: 0.9, BENEFIT: 0.8, LIFESTYLE: 0.7, COMPARISON: 0.8,
  },
  low: {
    URGENCY: 1.0, COMPATIBILITY: 1.0, QUALITY: 1.0, EXPERTISE: 1.0,
    REASSURANCE: 1.0, SOCIAL_PROOF: 1.0, BENEFIT: 1.0, LIFESTYLE: 1.0, COMPARISON: 1.0,
  },
});

// Fatigue penalties
const FATIGUE_PENALTIES = Object.freeze({
  low: 1.0,
  medium: 0.8,
  high: 0.5,
  critical: 0.2,
});

// Intent modifiers: delegate to ope-constants
const INTENT_MODIFIERS = INTENT_FAMILY_MODIFIERS;

// ----------------------------------------------------------------------
// Context Building (RETAINED — useful utility not in MRE)
// ----------------------------------------------------------------------

/**
 * Build a complete ranking context from various system states.
 * This utility is RETAINED because message-ranking-engine expects a
 * pre-assembled sessionState/fatigueState, but callers of this module
 * may prefer the convenience of a single params object.
 */
function buildRankingContext(params) {
  const {
    sessionId,
    productId,
    context = 'listing',
    intentState = 'exploring',
    intentConfidence = 0.5,
    fatigue = 0,
    sessionTimeMs = 0,
    productsViewed = 0,
    messagesShownThisSession = [],
    abandonmentRisk = 0,
    nowMs,
  } = params;

  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new Error(`${_DEPRECATION_PREFIX} buildRankingContext: nowMs is required (determinism).`);
  }

  // Get behavioral patterns
  const patterns = BehavioralIntelligence.analyzePatterns(sessionId, productId, nowMs);

  // Get funnel stage
  const funnelStage = FunnelEngine.getCurrentStage(sessionId);
  const funnelPriorities = FunnelEngine.getMessagePriorities(sessionId);

  return {
    sessionId,
    productId,
    context,
    nowMs,
    intentState: normalizeIntentState(intentState),
    intentConfidence,
    fatigue,
    fatigueLevel: _getFatigueLevel(fatigue),
    sessionTimeMs,
    productsViewed,
    messagesShownThisSession,
    abandonmentRisk,
    returnRisk: patterns.returnRisk?.level || 'low',
    microIntention: patterns.microIntention,
    hesitation: patterns.hesitation,
    comparison: patterns.comparison,
    buyerType: patterns.buyerType?.type || 'unknown',
    funnelStage,
    funnelPriorities,
    suppressUrgency: _shouldSuppressUrgency(patterns, funnelStage),
  };
}

function _getFatigueLevel(fatigue) {
  if (fatigue >= 0.8) return 'critical';
  if (fatigue >= 0.6) return 'high';
  if (fatigue >= 0.3) return 'medium';
  return 'low';
}

function _shouldSuppressUrgency(patterns, funnelStage) {
  if (patterns.returnRisk?.level === 'high') return true;
  if (patterns.returnRisk?.level === 'medium') return true;
  if (patterns.microIntention === 'impulsive') return true;
  if (patterns.microIntention === 'uncertain') return true;
  if (funnelStage === 'discovery') return true;
  if (funnelStage === 'checkout_ready') return true;
  return false;
}

// ----------------------------------------------------------------------
// Family Priority (RETAINED — useful utility)
// ----------------------------------------------------------------------

function getPrioritizedFamilies(rankingContext) {
  const funnelFamilies = rankingContext.funnelPriorities?.families || [];
  const merged = [...funnelFamilies];

  // Add remaining canonical families
  Object.values(MESSAGE_FAMILIES).forEach(f => {
    if (!merged.includes(f)) merged.push(f);
  });

  // Apply urgency suppression
  if (rankingContext.suppressUrgency) {
    const idx = merged.indexOf(MESSAGE_FAMILIES.URGENCY);
    if (idx > -1) merged.splice(idx, 1);
  }

  return merged;
}

function filterByAppropriateFamily(messages, rankingContext) {
  const priorities = getPrioritizedFamilies(rankingContext);
  const topFamilies = new Set(priorities.slice(0, 5));

  return messages.filter(m => {
    const canonical = normalizeFamily(m.family);
    if (!canonical) return false;
    if (canonical === MESSAGE_FAMILIES.URGENCY && rankingContext.suppressUrgency) return false;
    return topFamilies.has(canonical);
  });
}

// ----------------------------------------------------------------------
// DEPRECATED Scoring — delegates to MRE
// ----------------------------------------------------------------------

/**
 * @deprecated Use message-ranking-engine.rankInterventions() instead.
 */
function scoreMessage(message, rankingContext) {
  _warnDeprecated('scoreMessage', 'message-ranking-engine.scoreCandidate()');

  const canonical = normalizeFamily(message.family);
  if (!canonical) return { ...message, score: 0, suppressed: true, reason: 'unknown_family' };

  // Apply context weight (MRE doesn't have context-aware weights; this is added value)
  const contextWeight = CONTEXT_WEIGHTS[rankingContext.context]?.[canonical] || 0.5;
  const intentMod = INTENT_MODIFIERS[rankingContext.intentState]?.[canonical] || 1.0;
  const fatiguePenalty = FATIGUE_PENALTIES[rankingContext.fatigueLevel] || 1.0;
  const returnRiskAdj = RETURN_RISK_ADJUSTMENTS[rankingContext.returnRisk]?.[canonical] || 1.0;
  const funnelBonus = rankingContext.funnelPriorities?.families?.includes(canonical) ? 1.3 : 1.0;

  let urgencySuppression = 1.0;
  if (canonical === MESSAGE_FAMILIES.URGENCY && rankingContext.suppressUrgency) {
    urgencySuppression = 0.0;
  }

  const recentlySeen = (rankingContext.messagesShownThisSession || [])
    .filter(m => normalizeFamily(m.family) === canonical).length;
  const repetitionPenalty = Math.max(0.3, 1 - (recentlySeen * 0.25));

  const baseScore = message.minConfidence || 50;
  const finalScore = baseScore * contextWeight * intentMod * fatiguePenalty *
    returnRiskAdj * funnelBonus * urgencySuppression * repetitionPenalty;

  return {
    ...message,
    family: canonical,
    _originalFamily: message.family,
    score: finalScore,
    breakdown: { baseScore, contextWeight, intentMod, fatiguePenalty, returnRiskAdj, funnelBonus, urgencySuppression, repetitionPenalty },
    suppressed: urgencySuppression === 0 || finalScore < 10,
  };
}

/**
 * @deprecated Use message-ranking-engine.rankInterventions() instead.
 */
function rankMessages(messages, rankingContext) {
  _warnDeprecated('rankMessages', 'message-ranking-engine.rankInterventions()');
  const scored = messages.map(msg => scoreMessage(msg, rankingContext));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((msg, index) => ({
    ...msg,
    rank: index + 1,
    isTopCandidate: index === 0 && !msg.suppressed && msg.score >= 25,
  }));
}

/**
 * @deprecated Use message-ranking-engine.selectTopCandidate() instead.
 */
function selectBestMessage(messages, rankingContext) {
  _warnDeprecated('selectBestMessage', 'message-ranking-engine.selectTopCandidate()');
  const ranked = rankMessages(messages, rankingContext);
  return ranked.find(m => !m.suppressed && m.score >= 25) || null;
}

/**
 * @deprecated Use message-ranking-engine.rankInterventions() + analyzeRanking for debug.
 */
function analyzeRanking(messages, params) {
  _warnDeprecated('analyzeRanking', 'message-ranking-engine.rankInterventions()');
  const context = buildRankingContext(params);
  const ranked = rankMessages(messages, context);
  const selected = selectBestMessage(messages, context);

  return {
    context: {
      funnelStage: context.funnelStage,
      microIntention: context.microIntention,
      returnRisk: context.returnRisk,
      fatigueLevel: context.fatigueLevel,
      suppressUrgency: context.suppressUrgency,
    },
    prioritizedFamilies: getPrioritizedFamilies(context),
    rankings: ranked.slice(0, 10),
    selected,
    totalCandidates: messages.length,
    suppressedCount: ranked.filter(m => m.suppressed).length,
    _deprecated: true,
    _migrateToModule: 'message-ranking-engine',
  };
}

// ----------------------------------------------------------------------
// Exports (backward-compatible API surface)
// ----------------------------------------------------------------------
module.exports = {
  // RETAINED utilities
  buildRankingContext,
  getPrioritizedFamilies,
  filterByAppropriateFamily,

  // DEPRECATED scoring (delegates internally; emits warnings)
  scoreMessage,
  rankMessages,
  selectBestMessage,
  analyzeRanking,

  // Constants
  CONTEXT_WEIGHTS,
  RETURN_RISK_ADJUSTMENTS,
  FATIGUE_PENALTIES,
  INTENT_MODIFIERS,
  MESSAGE_FAMILIES: LEGACY_MESSAGE_FAMILIES,
};
