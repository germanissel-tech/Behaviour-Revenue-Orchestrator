/**
 * intervention-policy-engine.js
 *
 * Strategic orchestration layer for adaptive intervention decisions.
 *
 * Responsibilities:
 * - Decide WHEN to intervene (timing)
 * - WHY (behavioral reason)
 * - WHAT family of intervention is compatible
 * - With what intensity
 * - Based on intent state, fatigue, signals, transition state, etc.
 *
 * Design contract (post-audit, hardened):
 * - Pure and deterministic: given identical inputs (including `now`), output is identical.
 *   No internal Date.now(), no Math.random() unless a seeded RNG is provided.
 * - Temporal authority: respects `fatigueState.cooldownUntil`. If `now < cooldownUntil`,
 *   the policy refuses to intervene regardless of priority.
 * - Single source of truth for fatigue: fatigue affects exactly two channels
 *   (eligibility soft penalty + window hard SUPPRESS gate). Risk does NOT re-import
 *   dismissals or fatigue scalar. Intensity is not separately capped by fatigue
 *   (the SUPPRESS gate already protects).
 * - Monotonic gating: priority threshold strictly decreases with window leverage
 *   (HIGH_LEVERAGE < ACTIVE_OPPORTUNITY < SOFT_OPPORTUNITY).
 * - Single canonical decision label (`decision`) plus derived boolean views.
 * - Closed-set validation for intent/emotional/family taxonomies (fail closed).
 * - RL-ready surface: experimentVariant passthrough, optional ε-exploration with
 *   injectable seeded RNG, shouldAbstain on degraded inputs, decisionId + policyVersion
 *   on every return.
 *
 * TAXONOMY SOURCE: ope-constants.js (SSOT for families, intents, compatibility matrix).
 * This module imports canonical definitions and re-exports backward-compatible aliases.
 */

"use strict"

// ----------------------------------------------------------------------
// IMPORT CANONICAL TAXONOMY FROM ope-constants.js (SSOT)
// ----------------------------------------------------------------------
const {
  INTENT_STATES: CANONICAL_INTENT_STATES,
  VALID_INTENT_STATES: CANONICAL_VALID_INTENTS,
  MESSAGE_FAMILIES: CANONICAL_FAMILIES,
  MESSAGE_FAMILY_LIST: CANONICAL_FAMILY_LIST,
  VALID_MESSAGE_FAMILIES: CANONICAL_VALID_FAMILIES,
  FAMILY_COMPATIBILITY_MATRIX: CANONICAL_COMPAT_MATRIX,
  EMOTIONAL_STATES: CANONICAL_EMOTIONAL_STATES,
  normalizeIntentState: canonicalNormalizeIntent,
  normalizeFamily: canonicalNormalizeFamily,
} = require('./ope-constants')

// ----------------------------------------------------------------------
// POLICY VERSION (bumped — taxonomy now sourced from ope-constants)
// ----------------------------------------------------------------------

const POLICY_VERSION = "3.0.0"
const MATRIX_VERSION = "3.0.0"

// ----------------------------------------------------------------------
// CLOSED-SET TAXONOMIES — sourced from ope-constants.js
//
// The local INTENT_STATE and EMOTIONAL_STATE enums are preserved for
// backward compatibility but now delegate to the canonical set.
// FAMILY is expanded from 7 to 11 families (canonical).
// ----------------------------------------------------------------------

const INTENT_STATE = Object.freeze({
  EXPLORING:      CANONICAL_INTENT_STATES.EXPLORING,
  EVALUATING:     CANONICAL_INTENT_STATES.EVALUATING,
  COMPARING:      CANONICAL_INTENT_STATES.COMPARING,
  HESITATING:     CANONICAL_INTENT_STATES.HESITATING,
  HIGH_INTENT:    CANONICAL_INTENT_STATES.HIGH_INTENT,
  PURCHASE_READY: CANONICAL_INTENT_STATES.PURCHASE_READY,
  DISENGAGING:    CANONICAL_INTENT_STATES.DISENGAGING,
  EXIT_RISK:      CANONICAL_INTENT_STATES.EXIT_RISK,
  UNKNOWN:        CANONICAL_INTENT_STATES.UNKNOWN,
})

const KNOWN_INTENT_STATES = CANONICAL_VALID_INTENTS

const EMOTIONAL_STATE = Object.freeze({
  NEUTRAL:    CANONICAL_EMOTIONAL_STATES.NEUTRAL,
  CONFIDENT:  CANONICAL_EMOTIONAL_STATES.CONFIDENT,
  HESITANT:   CANONICAL_EMOTIONAL_STATES.HESITANT,
  ANXIOUS:    CANONICAL_EMOTIONAL_STATES.ANXIOUS,
  FRUSTRATED: CANONICAL_EMOTIONAL_STATES.FRUSTRATED,
  ENGAGED:    CANONICAL_EMOTIONAL_STATES.ENGAGED,
  UNKNOWN:    CANONICAL_EMOTIONAL_STATES.UNKNOWN,
})

const KNOWN_EMOTIONAL_STATES = new Set(Object.values(EMOTIONAL_STATE))

// ----------------------------------------------------------------------
// FAMILY — expanded to 11 canonical families from ope-constants
//
// Old 7-family taxonomy:
//   ASSIST, SOCIAL_PROOF, URGENCY, REASSURANCE, EDUCATIONAL, CART_SUPPORT, RECOVERY
//
// New 11-family canonical taxonomy (from ope-constants):
//   BENEFIT, SOCIAL_PROOF, QUALITY, COMPATIBILITY, REASSURANCE, URGENCY,
//   EXPERTISE, LIFESTYLE, COMPARISON, CART_SUPPORT, RECOVERY
//
// ASSIST -> EXPERTISE (backward compat alias)
// EDUCATIONAL -> EXPERTISE (backward compat alias)
// NO_INTERVENTION -> retained as policy-specific sentinel
// ----------------------------------------------------------------------

const FAMILY = Object.freeze({
  // Canonical 11 families from ope-constants
  BENEFIT:        CANONICAL_FAMILIES.BENEFIT,
  SOCIAL_PROOF:   CANONICAL_FAMILIES.SOCIAL_PROOF,
  QUALITY:        CANONICAL_FAMILIES.QUALITY,
  COMPATIBILITY:  CANONICAL_FAMILIES.COMPATIBILITY,
  REASSURANCE:    CANONICAL_FAMILIES.REASSURANCE,
  URGENCY:        CANONICAL_FAMILIES.URGENCY,
  EXPERTISE:      CANONICAL_FAMILIES.EXPERTISE,
  LIFESTYLE:      CANONICAL_FAMILIES.LIFESTYLE,
  COMPARISON:     CANONICAL_FAMILIES.COMPARISON,
  CART_SUPPORT:   CANONICAL_FAMILIES.CART_SUPPORT,
  RECOVERY:       CANONICAL_FAMILIES.RECOVERY,
  // Backward compatibility aliases (deprecated, map to canonical)
  ASSIST:         CANONICAL_FAMILIES.EXPERTISE,
  EDUCATIONAL:    CANONICAL_FAMILIES.EXPERTISE,
  // Policy-specific sentinel
  NO_INTERVENTION: "NO_INTERVENTION",
})

// Active families for iteration (excludes NO_INTERVENTION and deprecated aliases)
const FAMILIES = Object.freeze([
  FAMILY.BENEFIT,
  FAMILY.SOCIAL_PROOF,
  FAMILY.QUALITY,
  FAMILY.COMPATIBILITY,
  FAMILY.REASSURANCE,
  FAMILY.URGENCY,
  FAMILY.EXPERTISE,
  FAMILY.LIFESTYLE,
  FAMILY.COMPARISON,
  FAMILY.CART_SUPPORT,
  FAMILY.RECOVERY,
  FAMILY.NO_INTERVENTION,
])

const KNOWN_FAMILIES = new Set(FAMILIES)

const DECISION = Object.freeze({
  INTERVENE: "INTERVENE",
  DELAY: "DELAY",
  SUPPRESS: "SUPPRESS",
  COOLDOWN: "COOLDOWN",
  OBSERVE: "OBSERVE",
  NO_COMPATIBLE_FAMILY: "NO_COMPATIBLE_FAMILY",
  ABSTAIN: "ABSTAIN",
})

const WINDOW = Object.freeze({
  HIGH_LEVERAGE: "HIGH_LEVERAGE",
  ACTIVE_OPPORTUNITY: "ACTIVE_OPPORTUNITY",
  SOFT_OPPORTUNITY: "SOFT_OPPORTUNITY",
  OBSERVE: "OBSERVE",
  SUPPRESS: "SUPPRESS",
  COOLDOWN: "COOLDOWN",
})

const REASON_CODE = Object.freeze({
  COOLDOWN_ACTIVE: "cooldown_active",
  FATIGUE_SUPPRESS: "fatigue_suppress",
  RISK_SUPPRESS: "risk_suppress",
  ELIGIBILITY_LOW: "eligibility_low",
  PRIORITY_BELOW_THRESHOLD: "priority_below_threshold",
  NO_COMPATIBLE_FAMILY: "no_compatible_family",
  HIGH_LEVERAGE_INTERVENE: "high_leverage_intervene",
  ACTIVE_OPPORTUNITY_INTERVENE: "active_opportunity_intervene",
  SOFT_OPPORTUNITY_INTERVENE: "soft_opportunity_intervene",
  EXPLORATION_OVERRIDE: "exploration_override",
  ABSTAIN_DEGRADED_INPUT: "abstain_degraded_input",
  OSCILLATION_RISK: "oscillation_risk",
})

// ----------------------------------------------------------------------
// CONFIGURATION (every constant referenced)
// ----------------------------------------------------------------------

const CONFIG = Object.freeze({
  // Priority gating per window (monotonic in leverage)
  priorityThresholdHighLeverage: 0.35,
  priorityThresholdActiveOpportunity: 0.5,
  priorityThresholdSoftOpportunity: 0.65,

  // Priority formula
  priorityRiskFloor: 0.1,

  // Window classification thresholds + hysteresis
  fatigueSuppressEnter: 0.8,
  fatigueSuppressExit: 0.72,
  riskSuppressEnter: 0.8,
  riskSuppressExit: 0.72,

  highLeverageUrgencyEnter: 0.7,
  highLeverageUrgencyExit: 0.62,
  highLeverageRiskEnter: 0.3,
  highLeverageRiskExit: 0.38,
  highLeverageEligibilityEnter: 0.6,
  highLeverageEligibilityExit: 0.52,

  activeOpportunityUrgencyEnter: 0.5,
  activeOpportunityUrgencyExit: 0.42,
  activeOpportunityRiskEnter: 0.5,
  activeOpportunityRiskExit: 0.58,

  softOpportunityUrgencyEnter: 0.3,
  softOpportunityUrgencyExit: 0.22,

  observeEligibilityEnter: 0.3,
  observeEligibilityExit: 0.38,

  // Eligibility weights
  eligibilityBaseline: 0.5,
  eligibilityHighIntentBoost: 0.2,
  eligibilityLowIntentPenalty: 0.2,
  eligibilityFatigueHighPenalty: 0.3,
  eligibilityFatigueMediumPenalty: 0.15,
  eligibilityFatigueHighEnter: 0.6,
  eligibilityFatigueMediumEnter: 0.4,
  eligibilityOscillationPenalty: 0.25,
  eligibilityUnknownIntentPenalty: 0.2,

  // Urgency weights
  urgencyBaseline: 0.3,
  urgencyExitRiskBoost: 0.4,
  urgencyDisengagingBoost: 0.3,
  urgencyFrictionHesitationBoost: 0.2,
  urgencyStuckPurchaseBoost: 0.3,
  urgencyMomentumDecayBoost: 0.2,

  // Risk weights (no fatigue, no dismissals — those are upstream's job)
  riskBaseline: 0.2,
  riskFrustrationBoost: 0.3,
  riskAnxiousBoost: 0.2,
  riskHesitationLowConfidenceBoost: 0.2,
  riskOverMessagingBoost: 0.3,
  riskOscillationBoost: 0.15,

  // Intensity (smooth)
  intensityUrgencyBaseline: 0.0,
  intensityFatigueWeight: 0.3,
  intensityRiskWeight: 0.2,
  intensityFloor: 0.0,
  intensityCeiling: 1.0,

  // Family-aware intensity caps — now covers all 11 canonical families
  familyIntensityCap: Object.freeze({
    BENEFIT:        0.75,
    SOCIAL_PROOF:   0.70,
    QUALITY:        0.70,
    COMPATIBILITY:  0.75,
    REASSURANCE:    0.75,
    URGENCY:        0.85,
    EXPERTISE:      0.65,
    LIFESTYLE:      0.60,
    COMPARISON:     0.65,
    CART_SUPPORT:   0.90,
    RECOVERY:       0.95,
    // Backward compat aliases (resolve to same caps as canonical targets)
    ASSIST:         0.65,
    EDUCATIONAL:    0.65,
  }),

  // Compatibility
  compatibilityThreshold: 0.4,
  compatibilityUnknownDefault: 0.0, // fail closed
  compatibilityBoostMax: 0.25,

  // Exploration / abstain
  explorationRate: 0.0, // epsilon-greedy off by default
  abstainOnUnknownIntent: true,
  abstainOnDegradedSignals: true,
})

// ----------------------------------------------------------------------
// COMPATIBILITY MATRIX — DELEGATED TO ope-constants.js (SSOT)
//
// Previously this was a local 7-family matrix. Now we use the canonical
// 11-family FAMILY_COMPATIBILITY_MATRIX from ope-constants.js.
//
// The local reference is kept for backward compatibility of the export
// and for internal lookups, but it IS the canonical matrix.
// ----------------------------------------------------------------------

const COMPATIBILITY_MATRIX = CANONICAL_COMPAT_MATRIX

// ----------------------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------------------

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function safeNum(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Read a signal value, returning both value and presence so missingness
 * is preserved as an explicit feature.
 */
function readSignal(signals, key, fallback = 0) {
  const raw = signals?.[key]?.value
  const present = raw !== undefined && raw !== null && Number.isFinite(raw)
  return { value: present ? raw : fallback, present }
}

/**
 * Deterministic, seeded RNG. Mulberry32. Used only when explorationRate > 0
 * and a seed is provided.
 */
function makeSeededRng(seed) {
  let t = (seed | 0) >>> 0
  return function rng() {
    t = (t + 0x6d2b79f5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Cheap deterministic 32-bit hash for decisionId. Not crypto.
 */
function hash32(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

function normalizeIntentState(value) {
  if (typeof value !== "string") return INTENT_STATE.UNKNOWN
  // Delegate to canonical normalizer for full alias support
  const normalized = canonicalNormalizeIntent(value)
  return KNOWN_INTENT_STATES.has(normalized) ? normalized : INTENT_STATE.UNKNOWN
}

function normalizeEmotionalState(value) {
  if (typeof value !== "string") return EMOTIONAL_STATE.UNKNOWN
  return KNOWN_EMOTIONAL_STATES.has(value) ? value : EMOTIONAL_STATE.UNKNOWN
}

/**
 * Normalize a family string to canonical form.
 * Supports old ASSIST/EDUCATIONAL -> EXPERTISE mapping.
 */
function normalizeFamilyForPolicy(family) {
  if (typeof family !== 'string') return null
  const canonical = canonicalNormalizeFamily(family)
  if (canonical) return canonical
  // Check local NO_INTERVENTION sentinel
  if (family === 'NO_INTERVENTION') return FAMILY.NO_INTERVENTION
  return null
}

/**
 * Compatibility boost shaping that cannot push past 1.0 and preserves
 * resolution near saturation: boost is scaled by remaining headroom.
 */
function applyBoost(score, boost) {
  const headroom = Math.max(0, 1 - score)
  return clamp(score + boost * headroom, 0, 1)
}

// ----------------------------------------------------------------------
// 1. ELIGIBILITY
// ----------------------------------------------------------------------

function computeInterventionEligibility({ intentState, fatigueState, transitionState }) {
  let score = CONFIG.eligibilityBaseline

  const highIntent = intentState === INTENT_STATE.HIGH_INTENT || intentState === INTENT_STATE.PURCHASE_READY
  const lowIntent = intentState === INTENT_STATE.EXIT_RISK || intentState === INTENT_STATE.DISENGAGING

  if (highIntent) score += CONFIG.eligibilityHighIntentBoost
  else if (lowIntent) score -= CONFIG.eligibilityLowIntentPenalty
  else if (intentState === INTENT_STATE.UNKNOWN) score -= CONFIG.eligibilityUnknownIntentPenalty

  // Soft fatigue channel (the ONE soft place where fatigue lives)
  const fatigueScore = safeNum(fatigueState?.fatigueScore, 0)
  if (fatigueScore > CONFIG.eligibilityFatigueHighEnter) {
    score -= CONFIG.eligibilityFatigueHighPenalty
  } else if (fatigueScore > CONFIG.eligibilityFatigueMediumEnter) {
    score -= CONFIG.eligibilityFatigueMediumPenalty
  }

  if (transitionState?.oscillationRisk === true) {
    score -= CONFIG.eligibilityOscillationPenalty
  }

  return clamp(score, 0, 1)
}

// ----------------------------------------------------------------------
// 2. URGENCY
// ----------------------------------------------------------------------

function computeInterventionUrgency({ intentState, signals, sessionState }) {
  let urgency = CONFIG.urgencyBaseline

  if (intentState === INTENT_STATE.EXIT_RISK) urgency += CONFIG.urgencyExitRiskBoost
  else if (intentState === INTENT_STATE.DISENGAGING) urgency += CONFIG.urgencyDisengagingBoost

  const hesitation = readSignal(signals, "hesitation_score")
  const friction = safeNum(sessionState?.frictionLevel, 0)
  if (hesitation.present && hesitation.value > 0.5 && friction > 0.3) {
    urgency += CONFIG.urgencyFrictionHesitationBoost
  }

  const cart = readSignal(signals, "cart_commitment_score")
  const checkout = readSignal(signals, "checkout_progression_score")
  const hasAddToCart = cart.present && cart.value > 0.2
  const hasCheckout = checkout.present && checkout.value > 0.1
  if (intentState === INTENT_STATE.PURCHASE_READY && hasAddToCart && !hasCheckout) {
    urgency += CONFIG.urgencyStuckPurchaseBoost
  }

  const momentum = safeNum(sessionState?.momentumScore, 0)
  const accel = readSignal(signals, "acceleration_score")
  if (momentum < 0.3 && accel.present && accel.value < 0.2) {
    urgency += CONFIG.urgencyMomentumDecayBoost
  }

  return clamp(urgency, 0, 1)
}

// ----------------------------------------------------------------------
// 3. RISK
//
// IMPORTANT: risk no longer imports fatigue scalar or recentDismissals.
// Those are the fatigue engine's responsibility and are already enforced
// via the SUPPRESS window + eligibility soft penalty + cooldown gate.
// ----------------------------------------------------------------------

function computeInterventionRisk({ signals, sessionState, fatigueState, transitionState }) {
  let risk = CONFIG.riskBaseline

  const emotionalState = normalizeEmotionalState(sessionState?.emotionalState)
  if (emotionalState === EMOTIONAL_STATE.FRUSTRATED) risk += CONFIG.riskFrustrationBoost
  else if (emotionalState === EMOTIONAL_STATE.ANXIOUS) risk += CONFIG.riskAnxiousBoost

  const hesitation = readSignal(signals, "hesitation_score")
  const confidence = safeNum(sessionState?.confidence, 0.5)
  if (hesitation.present && hesitation.value > 0.6 && confidence < 0.4) {
    risk += CONFIG.riskHesitationLowConfidenceBoost
  }

  if (fatigueState?.overMessaging === true) {
    risk += CONFIG.riskOverMessagingBoost
  }

  if (transitionState?.oscillationRisk === true) {
    risk += CONFIG.riskOscillationBoost
  }

  return clamp(risk, 0, 1)
}

// ----------------------------------------------------------------------
// 4. BEHAVIORAL COMPATIBILITY (per family)
//
// Now uses CANONICAL_COMPAT_MATRIX from ope-constants.js as SSOT.
// Families are normalized through canonicalNormalizeFamily before lookup.
// ----------------------------------------------------------------------

function computeBehavioralCompatibility(family, intentState, signals) {
  // Normalize family to canonical form
  const canonicalFamily = canonicalNormalizeFamily(family)
  if (!canonicalFamily || family === FAMILY.NO_INTERVENTION) {
    return CONFIG.compatibilityUnknownDefault
  }
  const safeIntent = normalizeIntentState(intentState)
  const row = COMPATIBILITY_MATRIX[canonicalFamily]
  const base = row && Number.isFinite(row[safeIntent]) ? row[safeIntent] : CONFIG.compatibilityUnknownDefault

  let score = base

  const hesitation = readSignal(signals, "hesitation_score")
  const momentum = readSignal(signals, "momentum_score")
  const cart = readSignal(signals, "cart_commitment_score")

  // Boosts use headroom shaping so they cannot saturate to 1.0 silently.
  if (canonicalFamily === FAMILY.REASSURANCE && hesitation.present && hesitation.value > 0.5) {
    score = applyBoost(score, 0.2)
  }
  if (
    canonicalFamily === FAMILY.URGENCY &&
    momentum.present &&
    momentum.value < 0.3 &&
    safeIntent === INTENT_STATE.EXIT_RISK
  ) {
    score = applyBoost(score, 0.2)
  }
  if (canonicalFamily === FAMILY.CART_SUPPORT && cart.present && cart.value > 0.3) {
    score = applyBoost(score, 0.2)
  }
  if (canonicalFamily === FAMILY.SOCIAL_PROOF && hesitation.present && hesitation.value > 0.4) {
    score = applyBoost(score, 0.1)
  }
  // New boosts for expanded families
  if (canonicalFamily === FAMILY.COMPATIBILITY && hesitation.present && hesitation.value > 0.5) {
    score = applyBoost(score, 0.15)
  }
  if (canonicalFamily === FAMILY.QUALITY && hesitation.present && hesitation.value > 0.4) {
    score = applyBoost(score, 0.1)
  }

  return clamp(score, 0, 1)
}

// ----------------------------------------------------------------------
// 5. INTENSITY (smooth, family-aware cap)
//
// Removed cliff transitions and fatigue-only caps. The SUPPRESS gate
// upstream is the hard guard; here intensity is a smooth function of
// urgency - fatigue - risk, clipped to [0,1] and then capped per family.
// ----------------------------------------------------------------------

function determineInterventionIntensity({ urgencyScore, fatigueScore, riskScore, family }) {
  const raw =
    CONFIG.intensityUrgencyBaseline +
    urgencyScore -
    CONFIG.intensityFatigueWeight * fatigueScore -
    CONFIG.intensityRiskWeight * riskScore

  let intensity = clamp(raw, CONFIG.intensityFloor, CONFIG.intensityCeiling)

  // Normalize family for cap lookup (supports old ASSIST/EDUCATIONAL)
  const capFamily = canonicalNormalizeFamily(family) || family
  if (capFamily && CONFIG.familyIntensityCap[capFamily] !== undefined) {
    intensity = Math.min(intensity, CONFIG.familyIntensityCap[capFamily])
  }

  return intensity
}

// ----------------------------------------------------------------------
// 6. WINDOW CLASSIFICATION (with hysteresis)
// ----------------------------------------------------------------------

function classifyInterventionWindow(
  { urgencyScore, eligibilityScore, riskScore, fatigueScore },
  previousWindow,
) {
  const inSuppress = previousWindow === WINDOW.SUPPRESS
  const fatigueSuppressLimit = inSuppress ? CONFIG.fatigueSuppressExit : CONFIG.fatigueSuppressEnter
  const riskSuppressLimit = inSuppress ? CONFIG.riskSuppressExit : CONFIG.riskSuppressEnter

  if (fatigueScore >= fatigueSuppressLimit || riskScore >= riskSuppressLimit) {
    return WINDOW.SUPPRESS
  }

  const inObserve = previousWindow === WINDOW.OBSERVE
  const eligLowerLimit = inObserve ? CONFIG.observeEligibilityExit : CONFIG.observeEligibilityEnter
  if (eligibilityScore < eligLowerLimit) {
    return WINDOW.OBSERVE
  }

  const inHigh = previousWindow === WINDOW.HIGH_LEVERAGE
  const hlU = inHigh ? CONFIG.highLeverageUrgencyExit : CONFIG.highLeverageUrgencyEnter
  const hlR = inHigh ? CONFIG.highLeverageRiskExit : CONFIG.highLeverageRiskEnter
  const hlE = inHigh ? CONFIG.highLeverageEligibilityExit : CONFIG.highLeverageEligibilityEnter
  if (urgencyScore >= hlU && riskScore <= hlR && eligibilityScore >= hlE) {
    return WINDOW.HIGH_LEVERAGE
  }

  const inActive = previousWindow === WINDOW.ACTIVE_OPPORTUNITY
  const aoU = inActive ? CONFIG.activeOpportunityUrgencyExit : CONFIG.activeOpportunityUrgencyEnter
  const aoR = inActive ? CONFIG.activeOpportunityRiskExit : CONFIG.activeOpportunityRiskEnter
  if (urgencyScore >= aoU && riskScore <= aoR) {
    return WINDOW.ACTIVE_OPPORTUNITY
  }

  const inSoft = previousWindow === WINDOW.SOFT_OPPORTUNITY
  const soU = inSoft ? CONFIG.softOpportunityUrgencyExit : CONFIG.softOpportunityUrgencyEnter
  if (urgencyScore >= soU) {
    return WINDOW.SOFT_OPPORTUNITY
  }

  return WINDOW.OBSERVE
}

// ----------------------------------------------------------------------
// 7. PRIORITY (raw + clamped)
// ----------------------------------------------------------------------

function computeInterventionPriority({ eligibility, urgency, risk }) {
  const denom = risk + CONFIG.priorityRiskFloor
  const raw = denom > 0 ? (eligibility * urgency) / denom : 0
  return {
    rawPriority: Number.isFinite(raw) ? raw : 0,
    priority: clamp(raw, 0, 1),
  }
}

/**
 * Monotonic priority threshold per window. HIGH_LEVERAGE is the easiest
 * to act on, SOFT_OPPORTUNITY the hardest.
 */
function actionThreshold(window) {
  switch (window) {
    case WINDOW.HIGH_LEVERAGE:
      return CONFIG.priorityThresholdHighLeverage
    case WINDOW.ACTIVE_OPPORTUNITY:
      return CONFIG.priorityThresholdActiveOpportunity
    case WINDOW.SOFT_OPPORTUNITY:
      return CONFIG.priorityThresholdSoftOpportunity
    default:
      return Number.POSITIVE_INFINITY
  }
}

// ----------------------------------------------------------------------
// 8. FAMILY SELECTION
//
// allowedFamilies is the authority surface: it is the intersection of
// compatibility >= threshold AND current pressure regime allows action.
// compatibleFamilies (raw matrix-based view) is exposed in diagnostics.
//
// Now iterates over all 11 canonical families.
// ----------------------------------------------------------------------

function selectFamilyScores(intentState, signals, threshold = CONFIG.compatibilityThreshold) {
  const compatibleFamilies = []
  const scores = {}
  for (const family of FAMILIES) {
    if (family === FAMILY.NO_INTERVENTION) continue
    const compat = computeBehavioralCompatibility(family, intentState, signals)
    scores[family] = compat
    if (compat >= threshold) compatibleFamilies.push(family)
  }
  return { compatibleFamilies, scores }
}

/**
 * Deterministic tie-breaker. Prefers families that align with the user's
 * intent regime; falls back to a stable lexicographic order.
 * Updated for all 11 canonical families.
 */
function familyTieBreakOrder(intentState) {
  switch (intentState) {
    case INTENT_STATE.PURCHASE_READY:
    case INTENT_STATE.HIGH_INTENT:
      return [
        FAMILY.CART_SUPPORT,
        FAMILY.URGENCY,
        FAMILY.REASSURANCE,
        FAMILY.SOCIAL_PROOF,
        FAMILY.COMPATIBILITY,
        FAMILY.QUALITY,
        FAMILY.EXPERTISE,
        FAMILY.BENEFIT,
        FAMILY.COMPARISON,
        FAMILY.LIFESTYLE,
        FAMILY.RECOVERY,
      ]
    case INTENT_STATE.EXIT_RISK:
    case INTENT_STATE.DISENGAGING:
      return [
        FAMILY.RECOVERY,
        FAMILY.REASSURANCE,
        FAMILY.SOCIAL_PROOF,
        FAMILY.URGENCY,
        FAMILY.COMPATIBILITY,
        FAMILY.BENEFIT,
        FAMILY.QUALITY,
        FAMILY.CART_SUPPORT,
        FAMILY.EXPERTISE,
        FAMILY.COMPARISON,
        FAMILY.LIFESTYLE,
      ]
    case INTENT_STATE.HESITATING:
      return [
        FAMILY.REASSURANCE,
        FAMILY.COMPATIBILITY,
        FAMILY.SOCIAL_PROOF,
        FAMILY.QUALITY,
        FAMILY.CART_SUPPORT,
        FAMILY.EXPERTISE,
        FAMILY.BENEFIT,
        FAMILY.COMPARISON,
        FAMILY.URGENCY,
        FAMILY.LIFESTYLE,
        FAMILY.RECOVERY,
      ]
    case INTENT_STATE.COMPARING:
      return [
        FAMILY.COMPARISON,
        FAMILY.SOCIAL_PROOF,
        FAMILY.QUALITY,
        FAMILY.EXPERTISE,
        FAMILY.COMPATIBILITY,
        FAMILY.REASSURANCE,
        FAMILY.BENEFIT,
        FAMILY.LIFESTYLE,
        FAMILY.CART_SUPPORT,
        FAMILY.URGENCY,
        FAMILY.RECOVERY,
      ]
    case INTENT_STATE.EVALUATING:
      return [
        FAMILY.QUALITY,
        FAMILY.EXPERTISE,
        FAMILY.COMPARISON,
        FAMILY.SOCIAL_PROOF,
        FAMILY.REASSURANCE,
        FAMILY.BENEFIT,
        FAMILY.COMPATIBILITY,
        FAMILY.LIFESTYLE,
        FAMILY.CART_SUPPORT,
        FAMILY.URGENCY,
        FAMILY.RECOVERY,
      ]
    case INTENT_STATE.EXPLORING:
    default:
      return [
        FAMILY.BENEFIT,
        FAMILY.EXPERTISE,
        FAMILY.LIFESTYLE,
        FAMILY.SOCIAL_PROOF,
        FAMILY.QUALITY,
        FAMILY.COMPARISON,
        FAMILY.REASSURANCE,
        FAMILY.COMPATIBILITY,
        FAMILY.CART_SUPPORT,
        FAMILY.URGENCY,
        FAMILY.RECOVERY,
      ]
  }
}

function pickBestFamily(candidates, scores, intentState) {
  if (!candidates || candidates.length === 0) return null
  const order = familyTieBreakOrder(intentState)
  const rank = new Map(order.map((f, i) => [f, i]))
  let best = null
  let bestScore = -Infinity
  let bestRank = Infinity
  for (const fam of candidates) {
    const s = scores[fam] ?? 0
    const r = rank.has(fam) ? rank.get(fam) : Number.MAX_SAFE_INTEGER
    if (s > bestScore || (s === bestScore && r < bestRank)) {
      best = fam
      bestScore = s
      bestRank = r
    }
  }
  return best
}

// ----------------------------------------------------------------------
// 9. POLICY DIAGNOSTICS (stable schema)
// ----------------------------------------------------------------------

function generatePolicyDiagnostics({
  eligibility,
  urgency,
  risk,
  fatigue,
  intentState,
  emotionalState,
  signals,
  sessionState,
  transitionState,
  recentDismissals,
  rawPriority,
  priority,
  window,
  intensity,
  compatibleFamilies,
  allowedFamilies,
  recommendedFamily,
  warnings,
}) {
  return {
    eligibilityScore: eligibility,
    urgencyScore: urgency,
    riskScore: risk,
    fatigueScore: fatigue,
    rawPriority,
    priority,
    intensity,
    window,
    intentState,
    emotionalState,
    compatibleFamilies,
    allowedFamilies,
    recommendedFamily,
    taxonomySource: 'ope-constants',
    policyVersion: POLICY_VERSION,
    matrixVersion: MATRIX_VERSION,
    majorFactors: {
      eligibilityDrivers: {
        intentBoost: intentState === INTENT_STATE.HIGH_INTENT || intentState === INTENT_STATE.PURCHASE_READY,
        intentPenalty: intentState === INTENT_STATE.EXIT_RISK || intentState === INTENT_STATE.DISENGAGING,
        unknownIntent: intentState === INTENT_STATE.UNKNOWN,
        fatiguePenalty: fatigue > CONFIG.eligibilityFatigueMediumEnter,
        unstableTransition: transitionState?.oscillationRisk === true,
      },
      urgencyDrivers: {
        exitRisk: intentState === INTENT_STATE.EXIT_RISK,
        disengaging: intentState === INTENT_STATE.DISENGAGING,
        frictionAndHesitation:
          (signals?.hesitation_score?.value ?? 0) > 0.5 && (sessionState?.frictionLevel ?? 0) > 0.3,
        stuckPurchase:
          intentState === INTENT_STATE.PURCHASE_READY &&
          (signals?.checkout_progression_score?.value ?? 0) < 0.1 &&
          (signals?.cart_commitment_score?.value ?? 0) > 0.2,
      },
      riskDrivers: {
        emotionalFrustration: emotionalState === EMOTIONAL_STATE.FRUSTRATED,
        emotionalAnxious: emotionalState === EMOTIONAL_STATE.ANXIOUS,
        overMessaging: false, // filled by caller below if true
        oscillation: transitionState?.oscillationRisk === true,
        recentDismissals: safeNum(recentDismissals, 0), // reported only, NOT used in risk math
      },
    },
    warnings: Array.isArray(warnings) ? warnings : [],
  }
}

// ----------------------------------------------------------------------
// 10. MAIN ORCHESTRATOR
// ----------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {Object} [params.sessionState]
 * @param {Object} [params.signals]
 * @param {Object} [params.fatigueState]
 * @param {Object} [params.transitionState]
 * @param {number} [params.recentDismissals] - reported only, not used in math
 * @param {number} params.now - REQUIRED for determinism (ms epoch)
 * @param {string} [params.previousWindow] - last tick's window for hysteresis
 * @param {string} [params.experimentVariant] - passthrough for causal logging
 * @param {number} [params.explorationRate] - override CONFIG.explorationRate
 * @param {number} [params.rngSeed] - seed for deterministic exploration
 * @param {string} [params.decisionContextId] - extra entropy for decisionId
 */
function evaluateInterventionPolicy(params = {}) {
  const {
    sessionState = {},
    signals = {},
    fatigueState = {},
    transitionState = {},
    recentDismissals = 0,
    now,
    previousWindow,
    experimentVariant = null,
    explorationRate,
    rngSeed,
    decisionContextId,
  } = params

  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('intervention-policy-engine.evaluateInterventionPolicy requires explicit numeric "now" parameter');
  }

  const warnings = []
  const reasonCodes = []

  // ------------- 0. Normalize taxonomies (fail closed) ----------------
  const rawIntent = sessionState.intentState
  const intentState = normalizeIntentState(rawIntent)
  if (intentState === INTENT_STATE.UNKNOWN && rawIntent !== INTENT_STATE.UNKNOWN) {
    warnings.push("intent_state_fallback")
  }

  const rawEmotional = sessionState.emotionalState
  const emotionalState = normalizeEmotionalState(rawEmotional)
  if (emotionalState === EMOTIONAL_STATE.UNKNOWN && rawEmotional !== undefined && rawEmotional !== EMOTIONAL_STATE.UNKNOWN) {
    warnings.push("emotional_state_fallback")
  }

  const fatigueScore = safeNum(fatigueState?.fatigueScore, 0)
  const cooldownUntil = safeNum(fatigueState?.cooldownUntil, 0)

  // ------------- 1. Cooldown gate (C1) --------------------------------
  if (now < cooldownUntil) {
    reasonCodes.push(REASON_CODE.COOLDOWN_ACTIVE)
    return buildResult({
      decision: DECISION.COOLDOWN,
      shouldIntervene: false,
      shouldDelay: true,
      shouldSuppress: false,
      interventionWindow: WINDOW.COOLDOWN,
      priority: 0,
      rawPriority: 0,
      intensity: 0,
      allowedFamilies: [],
      compatibleFamilies: [],
      recommendedFamily: null,
      urgency: 0,
      eligibility: 0,
      risk: 0,
      fatigueScore,
      intentState,
      emotionalState,
      sessionState,
      signals,
      transitionState,
      recentDismissals,
      reasonCodes,
      warnings,
      now,
      cooldownUntil,
      experimentVariant,
      reasoning: `Cooldown active until ${cooldownUntil} (now=${now}).`,
    })
  }

  // ------------- 2. Core scores ---------------------------------------
  const eligibility = computeInterventionEligibility({ intentState, fatigueState, transitionState })
  const urgency = computeInterventionUrgency({ intentState, signals, sessionState })
  const risk = computeInterventionRisk({ signals, sessionState, fatigueState, transitionState })

  // ------------- 3. Window classification (hysteresis) ---------------
  const window = classifyInterventionWindow(
    {
      urgencyScore: urgency,
      eligibilityScore: eligibility,
      riskScore: risk,
      fatigueScore,
    },
    previousWindow,
  )

  // ------------- 4. Priority -----------------------------------------
  const { rawPriority, priority } = computeInterventionPriority({ eligibility, urgency, risk })

  // ------------- 5. Family selection (compat-only) -------------------
  const { compatibleFamilies, scores: familyScores } = selectFamilyScores(intentState, signals)

  // ------------- 6. Decision logic -----------------------------------
  let decision = null
  let shouldIntervene = false
  let shouldDelay = false
  let shouldSuppress = false
  let interventionWindow = window

  // Abstain on degraded inputs (H10)
  const degradedIntent = CONFIG.abstainOnUnknownIntent && intentState === INTENT_STATE.UNKNOWN
  if (degradedIntent) {
    decision = DECISION.ABSTAIN
    shouldDelay = true
    reasonCodes.push(REASON_CODE.ABSTAIN_DEGRADED_INPUT)
  } else if (window === WINDOW.SUPPRESS) {
    decision = DECISION.SUPPRESS
    shouldSuppress = true
    if (fatigueScore >= CONFIG.fatigueSuppressEnter) reasonCodes.push(REASON_CODE.FATIGUE_SUPPRESS)
    if (risk >= CONFIG.riskSuppressEnter) reasonCodes.push(REASON_CODE.RISK_SUPPRESS)
  } else if (window === WINDOW.OBSERVE) {
    decision = DECISION.OBSERVE
    shouldDelay = true
    reasonCodes.push(REASON_CODE.ELIGIBILITY_LOW)
  } else {
    const threshold = actionThreshold(window)
    if (priority > threshold) {
      shouldIntervene = true
      if (window === WINDOW.HIGH_LEVERAGE) reasonCodes.push(REASON_CODE.HIGH_LEVERAGE_INTERVENE)
      else if (window === WINDOW.ACTIVE_OPPORTUNITY) reasonCodes.push(REASON_CODE.ACTIVE_OPPORTUNITY_INTERVENE)
      else if (window === WINDOW.SOFT_OPPORTUNITY) reasonCodes.push(REASON_CODE.SOFT_OPPORTUNITY_INTERVENE)
      decision = DECISION.INTERVENE
    } else {
      shouldDelay = true
      reasonCodes.push(REASON_CODE.PRIORITY_BELOW_THRESHOLD)
      decision = DECISION.DELAY
    }
  }

  if (transitionState?.oscillationRisk === true && shouldIntervene) {
    // oscillation already taxed eligibility + risk; surface the reason
    reasonCodes.push(REASON_CODE.OSCILLATION_RISK)
  }

  // ------------- 7. Family picking (only if intervening) -------------
  let recommendedFamily = null
  if (shouldIntervene) {
    recommendedFamily = pickBestFamily(compatibleFamilies, familyScores, intentState)
    if (!recommendedFamily) {
      shouldIntervene = false
      shouldDelay = true
      decision = DECISION.NO_COMPATIBLE_FAMILY
      interventionWindow = WINDOW.OBSERVE
      reasonCodes.push(REASON_CODE.NO_COMPATIBLE_FAMILY)
    }
  }

  // ------------- 8. Optional epsilon-exploration ---------------------
  const epsilon = Number.isFinite(explorationRate) ? explorationRate : CONFIG.explorationRate
  if (shouldIntervene && epsilon > 0 && Number.isFinite(rngSeed)) {
    const rng = makeSeededRng(rngSeed ^ hash32(`${now}|${intentState}|${experimentVariant ?? ""}`))
    if (rng() < epsilon && compatibleFamilies.length > 1) {
      // pick a non-argmax compatible family deterministically
      const others = compatibleFamilies.filter((f) => f !== recommendedFamily)
      if (others.length > 0) {
        const idx = Math.floor(rng() * others.length) % others.length
        recommendedFamily = others[idx]
        reasonCodes.push(REASON_CODE.EXPLORATION_OVERRIDE)
      }
    }
  }

  // ------------- 9. Allowed families (authority surface) -------------
  // Intersection: compatibleFamilies AND we are actually allowed to act now.
  const canAct = shouldIntervene
  const allowedFamilies = canAct ? compatibleFamilies.slice() : []

  // ------------- 10. Intensity (smooth, family-aware) ----------------
  const intensity = shouldIntervene
    ? determineInterventionIntensity({
        urgencyScore: urgency,
        fatigueScore,
        riskScore: risk,
        family: recommendedFamily,
      })
    : 0

  // ------------- 11. Backpressure: nextEvaluateAt --------------------
  const nextEvaluateAt = computeNextEvaluateAt({ now, cooldownUntil, decision })

  // ------------- 12. Reasoning string (human-readable) ---------------
  const reasoning = buildReasoning({
    decision,
    interventionWindow,
    priority,
    fatigueScore,
    risk,
    recommendedFamily,
  })

  return buildResult({
    decision,
    shouldIntervene,
    shouldDelay,
    shouldSuppress,
    interventionWindow,
    priority,
    rawPriority,
    intensity,
    allowedFamilies,
    compatibleFamilies,
    recommendedFamily,
    urgency,
    eligibility,
    risk,
    fatigueScore,
    intentState,
    emotionalState,
    sessionState,
    signals,
    transitionState,
    recentDismissals,
    reasonCodes,
    warnings,
    now,
    cooldownUntil,
    nextEvaluateAt,
    experimentVariant,
    reasoning,
    overMessaging: fatigueState?.overMessaging === true,
    familyScores,
  })
}

// ----------------------------------------------------------------------
// HELPERS for evaluateInterventionPolicy
// ----------------------------------------------------------------------

function computeNextEvaluateAt({ now, cooldownUntil, decision }) {
  if (decision === DECISION.COOLDOWN && cooldownUntil > now) return cooldownUntil
  if (decision === DECISION.SUPPRESS) return now + 5000
  if (decision === DECISION.DELAY || decision === DECISION.OBSERVE || decision === DECISION.ABSTAIN) return now + 2000
  if (decision === DECISION.NO_COMPATIBLE_FAMILY) return now + 3000
  return null
}

function buildReasoning({ decision, interventionWindow, priority, fatigueScore, risk, recommendedFamily }) {
  switch (decision) {
    case DECISION.COOLDOWN:
      return `Cooldown gate active; suppressing decision.`
    case DECISION.SUPPRESS:
      return `Suppressed: window=${interventionWindow}, fatigue=${fatigueScore.toFixed(2)}, risk=${risk.toFixed(2)}.`
    case DECISION.OBSERVE:
      return `Observing: eligibility below action floor; window=${interventionWindow}.`
    case DECISION.DELAY:
      return `Delayed: window=${interventionWindow}, priority=${priority.toFixed(2)} below threshold.`
    case DECISION.ABSTAIN:
      return `Abstained: degraded inputs (unknown intent).`
    case DECISION.NO_COMPATIBLE_FAMILY:
      return `No compatible family above compatibility threshold; holding off.`
    case DECISION.INTERVENE:
      return `Intervene: window=${interventionWindow}, priority=${priority.toFixed(2)}, family=${recommendedFamily}.`
    default:
      return `No intervention.`
  }
}

function buildResult({
  decision,
  shouldIntervene,
  shouldDelay,
  shouldSuppress,
  interventionWindow,
  priority,
  rawPriority,
  intensity,
  allowedFamilies,
  compatibleFamilies,
  recommendedFamily,
  urgency,
  eligibility,
  risk,
  fatigueScore,
  intentState,
  emotionalState,
  sessionState,
  signals,
  transitionState,
  recentDismissals,
  reasonCodes,
  warnings,
  now,
  cooldownUntil,
  nextEvaluateAt = null,
  experimentVariant = null,
  reasoning,
  overMessaging = false,
  familyScores = null,
}) {
  const diagnostics = generatePolicyDiagnostics({
    eligibility,
    urgency,
    risk,
    fatigue: fatigueScore,
    intentState,
    emotionalState,
    signals,
    sessionState,
    transitionState,
    recentDismissals,
    rawPriority,
    priority,
    window: interventionWindow,
    intensity,
    compatibleFamilies,
    allowedFamilies,
    recommendedFamily,
    warnings,
  })
  diagnostics.majorFactors.riskDrivers.overMessaging = overMessaging === true

  const compatibilityScore = recommendedFamily
    ? (familyScores && familyScores[recommendedFamily] !== undefined
        ? familyScores[recommendedFamily]
        : computeBehavioralCompatibility(recommendedFamily, intentState, signals))
    : 0

  const decisionId = computeDecisionId({
    now,
    intentState,
    emotionalState,
    fatigueScore,
    urgency,
    eligibility,
    risk,
    interventionWindow,
    decision,
    recommendedFamily,
    experimentVariant,
  })

  return {
    // Canonical decision
    decision,
    // Boolean views (derived from `decision`)
    shouldIntervene,
    shouldDelay,
    shouldSuppress,
    // Window + scores
    interventionWindow,
    interventionPriority: priority,
    rawPriority,
    interventionIntensity: intensity,
    interventionRisk: risk,
    urgencyScore: urgency,
    eligibilityScore: eligibility,
    // Family info
    allowedFamilies,
    compatibleFamilies,
    recommendedFamily,
    compatibilityScore,
    // Backpressure
    nextEvaluateAt,
    cooldownUntil,
    // Audit
    reasoning,
    reasonCodes,
    warnings,
    diagnostics,
    // RL / causal surface
    decisionId,
    policyVersion: POLICY_VERSION,
    matrixVersion: MATRIX_VERSION,
    experimentVariant,
    evaluatedAt: now,
  }
}

function computeDecisionId({
  now,
  intentState,
  emotionalState,
  fatigueScore,
  urgency,
  eligibility,
  risk,
  interventionWindow,
  decision,
  recommendedFamily,
  experimentVariant,
}) {
  const fp = [
    now,
    intentState,
    emotionalState,
    fatigueScore.toFixed(4),
    urgency.toFixed(4),
    eligibility.toFixed(4),
    risk.toFixed(4),
    interventionWindow,
    decision,
    recommendedFamily ?? "",
    experimentVariant ?? "",
    POLICY_VERSION,
  ].join("|")
  return `pol_${hash32(fp).toString(16)}_${now}`
}

// ----------------------------------------------------------------------
// EXPORTS (frozen)
// ----------------------------------------------------------------------

module.exports = Object.freeze({
  evaluateInterventionPolicy,
  computeInterventionEligibility,
  computeInterventionUrgency,
  computeBehavioralCompatibility,
  computeInterventionRisk,
  classifyInterventionWindow,
  determineInterventionIntensity,
  computeInterventionPriority,
  selectFamilyScores,
  pickBestFamily,
  generatePolicyDiagnostics,
  normalizeFamilyForPolicy,
  // Constants for external tuning / inspection
  CONFIG,
  FAMILIES,
  FAMILY,
  INTENT_STATE,
  EMOTIONAL_STATE,
  DECISION,
  WINDOW,
  REASON_CODE,
  POLICY_VERSION,
  MATRIX_VERSION,
  COMPATIBILITY_MATRIX,
})
