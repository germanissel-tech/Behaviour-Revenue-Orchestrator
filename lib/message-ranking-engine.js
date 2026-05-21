/**
 * message-ranking-engine.js (v3 — enterprise restructure)
 *
 * SINGLE RANKING AUTHORITY for the OPE system.
 *
 * Pipeline position: cooldown-fatigue-engine -> intervention-policy-engine -> THIS MODULE.
 *
 * Enterprise restructure changes:
 *   - FAMILIES and INTENT_STATES are now imported from ope-constants.js
 *     (the single source of truth). This module no longer defines its own taxonomy.
 *   - FAMILY_COMPATIBILITY uses the FAMILY_COMPATIBILITY_MATRIX from ope-constants.
 *   - contextual-message-ranker.js has been degraded to a facade that delegates
 *     to this module. There is ONE ranking authority.
 *   - normalizeFamily() is used to accept both old lowercase and new UPPERCASE
 *     family names from candidates.
 *
 * Contract (must be honored by callers for determinism / replay):
 *  - `now` is REQUIRED at every helper. Only `rankInterventions` accepts a
 *    Date.now() default at the boundary, and emits a diagnostics warning when
 *    it does so. No internal helper reads wall clock.
 *  - `fatigueState.cooldownUntil` MUST be respected. If `now < cooldownUntil`
 *    the ranker short-circuits with a null selection + `nextEvaluateAt`.
 *  - `policyDecision` (the return of intervention-policy-engine) SHOULD be
 *    passed in. If passed, the ranker enforces:
 *      * `policyDecision.shouldIntervene === true`
 *      * each candidate.family is in `policyDecision.allowedFamilies`
 *      * `candidate.intensity <= policyDecision.intensity`
 *    Violations cause the candidate to be rejected with an explicit
 *    `reasonCode`, never silently down-ranked.
 *  - Family compatibility is sourced from ope-constants.js FAMILY_COMPATIBILITY_MATRIX.
 *  - Candidate schema is validated at entry. Malformed candidates are
 *    rejected (not coerced).
 *  - The novelty curve uses a real half-life:
 *      decay = exp(-ageMs * ln2 / halfLifeMs)
 *    and novelty saturates as exp(-effectiveExposures), never additively clamped.
 *  - Diversification operates over an explicit top-K window with a holdback
 *    drain to never under-fill the result.
 *  - Risk is applied multiplicatively on the convex sub-score sum so the
 *    final score remains bounded in [0, 1] without unit-mixing.
 *  - Exploration is opt-in, deterministic given a seed, and never overrides
 *    a hard reject (cooldown, policy suppression, schema rejection).
 *  - Every result carries `decisionId`, `rankerVersion`, `reasonCodes`,
 *    and a per-sub-score breakdown of the winner.
 */

"use strict"

// Import taxonomy from single source of truth
const {
  INTENT_STATES: INTENT_STATES_MAP,
  VALID_INTENT_STATES,
  MESSAGE_FAMILIES,
  MESSAGE_FAMILY_LIST,
  VALID_MESSAGE_FAMILIES,
  FAMILY_COMPATIBILITY_MATRIX,
  normalizeFamily,
  normalizeIntentState,
} = require('./ope-constants');

const RANKER_VERSION = "3.0.0"  // Bumped for enterprise restructure
const MATRIX_VERSION = "2.0.0"
const WEIGHTS_VERSION = "1.0.0"

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CONFIG = Object.freeze({
  weights: Object.freeze({
    behavioralFit: 0.25,
    expectedUtility: 0.2,
    novelty: 0.15,
    fatigueCompatibility: 0.1,
    contextualRelevance: 0.1,
    timingAlignment: 0.1,
    momentumAlignment: 0.1,
  }),

  // Novelty
  noveltyHalfLifeMs: 300_000, // 5 minutes (real half-life, not 1/e life)
  noveltyExposureWeight: 1.0, // per-exposure contribution to effective count
  exposureHistoryCap: 100, // bound CPU per candidate

  // Risk handling
  riskMultiplierStrength: 0.6, // 0..1; how much risk can attenuate the score

  // Diversification
  diversificationTopK: 5,
  diversificationMaxFamilyProportion: 0.4,

  // Thresholds
  minRawScoreThreshold: 0.2, // applied to rawScore, not finalScore
  abstainIfFewerThan: 2, // candidates surviving threshold

  // Exploration (opt-in)
  defaultExplorationRate: 0,

  // Sub-score tunables
  baselineBehavioralFit: 0.5,
  neutralMomentumAlignment: 0.5,
})

// ---------------------------------------------------------------------------
// SHARED FAMILY COMPATIBILITY (single source of truth across engines)
// Exported so policy-engine can import the same matrix.
// ---------------------------------------------------------------------------

// FAMILY_COMPATIBILITY: sourced from ope-constants (single authority).
// Wrapped in the same shape for backward compatibility with internal code.
const FAMILY_COMPATIBILITY = Object.freeze({
  MATRIX_VERSION,
  matrix: FAMILY_COMPATIBILITY_MATRIX,
})

// FAMILIES: from ope-constants (single source of truth)
const FAMILIES = Object.freeze(MESSAGE_FAMILY_LIST);

// INTENT_STATES: from ope-constants (single source of truth)
const INTENT_STATES = Object.freeze([
  ...Object.values(INTENT_STATES_MAP)
]);

// Defaults used only when a candidate omits its own intensity.
const FAMILY_DEFAULT_INTENSITY = Object.freeze({
  BENEFIT: 0.3,
  SOCIAL_PROOF: 0.4,
  QUALITY: 0.3,
  COMPATIBILITY: 0.3,
  REASSURANCE: 0.4,
  URGENCY: 0.7,
  EXPERTISE: 0.3,
  LIFESTYLE: 0.3,
  COMPARISON: 0.3,
  CART_SUPPORT: 0.5,
  RECOVERY: 0.6,
})

// Verify weights sum to 1 at module load. Cheap insurance against future edits.
;(function assertWeightsSumToOne() {
  const sum = Object.values(CONFIG.weights).reduce((a, b) => a + b, 0)
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(
      `[ranking-engine] CONFIG.weights must sum to 1.0 (got ${sum.toFixed(6)})`,
    )
  }
})()

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function clamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function requireNow(now, fnName) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new Error(
      `[ranking-engine] ${fnName}: 'now' is required and must be a finite number (ms epoch).`,
    )
  }
}

// normalizeIntentState: imported from ope-constants (single source of truth)
// The local re-export is kept for backward compatibility with callers.

/**
 * Normalize a candidate's family using ope-constants normalizeFamily.
 * Supports both old lowercase families (benefit, social) and new UPPERCASE.
 */
function normalizeCandidateFamily(candidate) {
  if (!candidate || typeof candidate.family !== 'string') return candidate;
  const normalized = normalizeFamily(candidate.family);
  if (normalized && normalized !== candidate.family) {
    return { ...candidate, family: normalized, _originalFamily: candidate.family };
  }
  return candidate;
}

// Deterministic hash for decisionId. FNV-1a 32-bit.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h
}

// Seeded RNG (Mulberry32). Returns a function () => [0,1).
function makeRng(seed) {
  let s = (seed | 0) >>> 0
  if (s === 0) s = 0x9e3779b9
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// SCHEMA VALIDATION
// ---------------------------------------------------------------------------

function validateCandidate(candidate, index) {
  if (!isPlainObject(candidate)) {
    return { ok: false, reason: "candidate_not_object", index }
  }
  // Normalize family (supports old lowercase + new UPPERCASE)
  const normalized = normalizeFamily(candidate.family);
  if (!normalized) {
    return { ok: false, reason: "unknown_family", index, family: candidate.family }
  }
  if (candidate.id != null && typeof candidate.id !== "string" && typeof candidate.id !== "number") {
    return { ok: false, reason: "invalid_id_type", index }
  }
  if (candidate.intensity != null) {
    if (typeof candidate.intensity !== "number" || !Number.isFinite(candidate.intensity)) {
      return { ok: false, reason: "invalid_intensity", index }
    }
    if (candidate.intensity < 0 || candidate.intensity > 1) {
      return { ok: false, reason: "intensity_out_of_range", index }
    }
  }
  return { ok: true, normalizedFamily: normalized }
}

function resolveCandidateIntensity(candidate) {
  if (typeof candidate.intensity === "number" && Number.isFinite(candidate.intensity)) {
    return candidate.intensity
  }
  return FAMILY_DEFAULT_INTENSITY[candidate.family] ?? 0.3
}

// ---------------------------------------------------------------------------
// SUB-SCORE COMPONENTS
// All take `now` explicitly. None read wall clock.
// All return { score, presence } where presence indicates whether real
// information was used (vs. neutral fallback).
// ---------------------------------------------------------------------------

function computeBehavioralFit(candidate, sessionState) {
  const intentState = normalizeIntentState(sessionState?.intentState)
  const matrix = FAMILY_COMPATIBILITY.matrix[candidate.family]
  if (!matrix) {
    // Should be unreachable due to schema validation, but fail closed.
    return { score: 0, presence: false }
  }
  const base = matrix[intentState]
  if (typeof base !== "number") {
    return { score: 0, presence: false }
  }
  return { score: clamp(base, 0, 1), presence: intentState !== "unknown" }
}

function computeExpectedUtility(candidate, sessionState) {
  // Convex-bounded utility heuristic in [0,1].
  // Drivers: candidate.priorExpectedLift (if provided), candidate.intensity,
  // session conversionProbability.
  const lift = clamp(candidate.priorExpectedLift ?? 0.5, 0, 1)
  const intensity = resolveCandidateIntensity(candidate)
  const conv = clamp(sessionState?.conversionProbability ?? 0.5, 0, 1)
  const presence =
    candidate.priorExpectedLift != null || sessionState?.conversionProbability != null
  // Weighted convex sum (weights sum to 1).
  const score = 0.5 * lift + 0.3 * conv + 0.2 * intensity
  return { score: clamp(score, 0, 1), presence }
}

function computeInterventionNovelty(candidate, exposureHistory, now) {
  requireNow(now, "computeInterventionNovelty")
  if (!Array.isArray(exposureHistory) || exposureHistory.length === 0) {
    return { score: 1, presence: false, effectiveExposures: 0 }
  }
  // Bound history.
  const history =
    exposureHistory.length > CONFIG.exposureHistoryCap
      ? exposureHistory.slice(-CONFIG.exposureHistoryCap)
      : exposureHistory

  // Real half-life: decay = 2^(-age/halfLife) = exp(-age * ln2 / halfLife)
  const lambda = Math.LN2 / CONFIG.noveltyHalfLifeMs

  let effective = 0
  let counted = 0
  for (const exposure of history) {
    if (!exposure || exposure.family !== candidate.family) continue
    const tsRaw = exposure.timestamp
    const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? tsRaw : null
    if (ts == null) continue
    const ageMs = Math.max(0, now - ts)
    const decay = Math.exp(-ageMs * lambda)
    effective += CONFIG.noveltyExposureWeight * decay
    counted++
  }

  // Saturating novelty: exp(-effectiveExposures) in (0, 1].
  const score = Math.exp(-effective)
  return {
    score: clamp(score, 0, 1),
    presence: counted > 0,
    effectiveExposures: effective,
  }
}

function computeFatigueCompatibility(candidate, fatigueState) {
  // Lower fatigue -> higher compatibility. Capped soft intensities are
  // preferred at higher fatigue.
  const fatigue = clamp(fatigueState?.fatigueScore ?? 0, 0, 1)
  const intensity = resolveCandidateIntensity(candidate)
  // Prefer low-intensity candidates as fatigue grows.
  // base = 1 - fatigue; intensity penalty grows with fatigue.
  const score = clamp(1 - fatigue - 0.3 * intensity * fatigue, 0, 1)
  return { score, presence: fatigueState?.fatigueScore != null }
}

function computeContextualRelevance(candidate, signals) {
  if (!isPlainObject(signals)) {
    return { score: 0.5, presence: false }
  }
  const fam = candidate.family
  // Map a few well-known signals to families. ?? not || so real zeros count.
  const hesitation = signals.hesitation?.value ?? null
  const cartActivity = signals.cartActivity?.value ?? null
  const comparisonDepth = signals.comparisonDepth?.value ?? null
  const frustration = signals.frustration?.value ?? null
  const exitIntent = signals.exitIntent?.value ?? null

  let score = 0.5
  let presence = false

  if (fam === "REASSURANCE" && hesitation != null) {
    score = clamp(0.4 + 0.6 * hesitation, 0, 1)
    presence = true
  } else if (fam === "CART_SUPPORT" && cartActivity != null) {
    score = clamp(0.4 + 0.6 * cartActivity, 0, 1)
    presence = true
  } else if (fam === "SOCIAL_PROOF" && comparisonDepth != null) {
    score = clamp(0.4 + 0.6 * comparisonDepth, 0, 1)
    presence = true
  } else if (fam === "RECOVERY" && (frustration != null || exitIntent != null)) {
    const f = frustration ?? 0
    const e = exitIntent ?? 0
    score = clamp(0.4 + 0.3 * f + 0.3 * e, 0, 1)
    presence = true
  } else if (fam === "URGENCY" && cartActivity != null) {
    score = clamp(0.3 + 0.5 * cartActivity, 0, 1)
    presence = true
  } else if (fam === "EDUCATIONAL" && comparisonDepth != null) {
    score = clamp(0.4 + 0.4 * comparisonDepth, 0, 1)
    presence = true
  } else if (fam === "ASSIST") {
    // Generic: light boost on any signal presence.
    const anyPresence =
      hesitation != null || cartActivity != null || comparisonDepth != null || frustration != null
    score = anyPresence ? 0.6 : 0.5
    presence = anyPresence
  }

  return { score, presence }
}

function computeTimingAlignment(candidate, sessionState, now) {
  requireNow(now, "computeTimingAlignment")
  // Prefer candidates whose family aligns with the session phase.
  const dwellMs = sessionState?.dwellMs
  if (typeof dwellMs !== "number" || !Number.isFinite(dwellMs)) {
    return { score: 0.5, presence: false }
  }
  // Phases: <15s entry, <90s exploration, <300s consideration, >=300s late.
  let phase = "late"
  if (dwellMs < 15_000) phase = "entry"
  else if (dwellMs < 90_000) phase = "exploration"
  else if (dwellMs < 300_000) phase = "consideration"

  const FAMILY_BY_PHASE = {
    entry: { EDUCATIONAL: 0.85, ASSIST: 0.75, SOCIAL_PROOF: 0.6 },
    exploration: { EDUCATIONAL: 0.8, SOCIAL_PROOF: 0.8, ASSIST: 0.7 },
    consideration: { REASSURANCE: 0.85, SOCIAL_PROOF: 0.8, CART_SUPPORT: 0.7 },
    late: { CART_SUPPORT: 0.85, URGENCY: 0.8, RECOVERY: 0.75 },
  }
  const score = FAMILY_BY_PHASE[phase][candidate.family] ?? 0.45
  return { score: clamp(score, 0, 1), presence: true }
}

function computeMomentumAlignment(candidate, sessionState) {
  const m = sessionState?.momentumScore
  if (typeof m !== "number" || !Number.isFinite(m)) {
    return { score: CONFIG.neutralMomentumAlignment, presence: false }
  }
  const momentum = clamp(m, 0, 1)
  // High momentum -> prefer URGENCY / CART_SUPPORT. Low momentum -> prefer
  // ASSIST / REASSURANCE / RECOVERY. Mid -> SOCIAL_PROOF / EDUCATIONAL.
  let alignment = 0.5
  if (momentum >= 0.7) {
    alignment =
      candidate.family === "URGENCY" || candidate.family === "CART_SUPPORT"
        ? 0.9
        : candidate.family === "SOCIAL_PROOF"
          ? 0.6
          : 0.35
  } else if (momentum <= 0.3) {
    alignment =
      candidate.family === "ASSIST" ||
      candidate.family === "REASSURANCE" ||
      candidate.family === "RECOVERY"
        ? 0.85
        : 0.35
  } else {
    alignment =
      candidate.family === "SOCIAL_PROOF" || candidate.family === "EDUCATIONAL"
        ? 0.75
        : 0.55
  }
  return { score: clamp(alignment, 0, 1), presence: true }
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

function scoreCandidate({
  candidate,
  sessionState,
  fatigueState,
  signals,
  exposureHistory,
  policyDecision,
  now,
}) {
  requireNow(now, "scoreCandidate")

  const subScores = {
    behavioralFit: computeBehavioralFit(candidate, sessionState),
    expectedUtility: computeExpectedUtility(candidate, sessionState),
    novelty: computeInterventionNovelty(candidate, exposureHistory, now),
    fatigueCompatibility: computeFatigueCompatibility(candidate, fatigueState),
    contextualRelevance: computeContextualRelevance(candidate, signals),
    timingAlignment: computeTimingAlignment(candidate, sessionState, now),
    momentumAlignment: computeMomentumAlignment(candidate, sessionState),
  }

  const w = CONFIG.weights
  const rawScore =
    w.behavioralFit * subScores.behavioralFit.score +
    w.expectedUtility * subScores.expectedUtility.score +
    w.novelty * subScores.novelty.score +
    w.fatigueCompatibility * subScores.fatigueCompatibility.score +
    w.contextualRelevance * subScores.contextualRelevance.score +
    w.timingAlignment * subScores.timingAlignment.score +
    w.momentumAlignment * subScores.momentumAlignment.score

  // Risk as multiplicative attenuation (preserves [0,1], no unit mixing).
  // risk source: policyDecision.risk if available; never recent-dismissals
  // (those live in the fatigue layer).
  const risk = clamp(policyDecision?.risk ?? 0, 0, 1)
  const intensity = resolveCandidateIntensity(candidate)
  const attenuation = 1 - CONFIG.riskMultiplierStrength * risk * intensity
  const finalScore = clamp(rawScore * attenuation, 0, 1)

  // Presence vector for ML pipelines (missingness-as-feature).
  const presence = {
    behavioralFit: subScores.behavioralFit.presence,
    expectedUtility: subScores.expectedUtility.presence,
    novelty: subScores.novelty.presence,
    fatigueCompatibility: subScores.fatigueCompatibility.presence,
    contextualRelevance: subScores.contextualRelevance.presence,
    timingAlignment: subScores.timingAlignment.presence,
    momentumAlignment: subScores.momentumAlignment.presence,
  }

  const subScoreValues = {
    behavioralFit: subScores.behavioralFit.score,
    expectedUtility: subScores.expectedUtility.score,
    novelty: subScores.novelty.score,
    fatigueCompatibility: subScores.fatigueCompatibility.score,
    contextualRelevance: subScores.contextualRelevance.score,
    timingAlignment: subScores.timingAlignment.score,
    momentumAlignment: subScores.momentumAlignment.score,
  }

  return {
    candidate,
    rawScore: clamp(rawScore, 0, 1),
    finalScore,
    risk,
    intensity,
    attenuation,
    subScores: subScoreValues,
    presence,
    effectiveExposures: subScores.novelty.effectiveExposures,
  }
}

// ---------------------------------------------------------------------------
// DIVERSIFICATION
// Top-K window with holdback drain so we never under-fill.
// ---------------------------------------------------------------------------

function diversifyCandidates(scored, topK, maxFamilyProportion) {
  if (scored.length === 0) return { admitted: [], deferred: [] }

  const K = Math.max(1, Math.min(topK, scored.length))
  const maxPerFamily = Math.max(1, Math.floor(K * maxFamilyProportion))

  // Score-sorted (caller passes sorted, but be defensive).
  const sorted = [...scored].sort((a, b) => b.finalScore - a.finalScore)

  const admitted = []
  const holdback = []
  const familyCounts = new Map()

  // Always admit top-1 unconditionally.
  const top = sorted[0]
  admitted.push(top)
  familyCounts.set(top.candidate.family, 1)

  for (let i = 1; i < sorted.length && admitted.length < K; i++) {
    const entry = sorted[i]
    const fam = entry.candidate.family
    const count = familyCounts.get(fam) ?? 0
    if (count < maxPerFamily) {
      admitted.push(entry)
      familyCounts.set(fam, count + 1)
    } else {
      holdback.push(entry)
    }
  }

  // Drain holdback in original score order if we under-filled.
  while (admitted.length < K && holdback.length > 0) {
    const entry = holdback.shift()
    admitted.push(entry)
    const fam = entry.candidate.family
    familyCounts.set(fam, (familyCounts.get(fam) ?? 0) + 1)
  }

  return { admitted, deferred: holdback }
}

// ---------------------------------------------------------------------------
// DIAGNOSTICS
// ---------------------------------------------------------------------------

function shannonEntropyNorm(counts, kEffective) {
  if (kEffective <= 1) return 1
  let total = 0
  for (const c of counts) total += c
  if (total === 0) return 0
  let H = 0
  for (const c of counts) {
    if (c <= 0) continue
    const p = c / total
    H -= p * Math.log(p)
  }
  return H / Math.log(kEffective)
}

function buildRankingDiagnostics({
  scored,
  diversified,
  selected,
  rejectionReasons,
  warnings,
  reasonCodes,
  nowUsed,
  explorationApplied,
  explorationCandidateId,
}) {
  const familyCounts = new Map()
  for (const s of diversified) {
    const fam = s.candidate.family
    familyCounts.set(fam, (familyCounts.get(fam) ?? 0) + 1)
  }
  const counts = [...familyCounts.values()]
  const kEff = Math.min(diversified.length, FAMILIES.length)
  const diversityEntropy = shannonEntropyNorm(counts, kEff)
  const maxFamilyCount = counts.length > 0 ? Math.max(...counts) : 0

  return {
    rankerVersion: RANKER_VERSION,
    weightsVersion: WEIGHTS_VERSION,
    matrixVersion: MATRIX_VERSION,
    nowUsed,
    explorationApplied,
    explorationCandidateId,
    warnings,
    reasonCodes,
    candidatesScored: scored.length,
    candidatesAfterDiversification: diversified.length,
    diversityEntropy,
    maxFamilyCountInTopK: maxFamilyCount,
    selectedSubScores: selected ? selected.subScores : null,
    selectedPresence: selected ? selected.presence : null,
    selectedRawScore: selected ? selected.rawScore : null,
    selectedFinalScore: selected ? selected.finalScore : null,
    selectedAttenuation: selected ? selected.attenuation : null,
    selectedEffectiveExposures: selected ? selected.effectiveExposures : null,
    rejectionReasons,
  }
}

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Rank intervention candidates and return a single selection (or null) plus
 * a deterministic decision record.
 *
 * @param {object} args
 * @param {Array<object>} args.candidates - Candidate interventions.
 *   Each must have at least `{ family: <FAMILIES> }`. Optional: `id`,
 *   `intensity` in [0,1], `priorExpectedLift` in [0,1], `subtype`.
 * @param {object} args.sessionState
 * @param {object} args.fatigueState - Must include `cooldownUntil` (ms epoch)
 *   and `fatigueScore` in [0,1].
 * @param {object} args.signals
 * @param {Array<{family,timestamp}>} [args.exposureHistory]
 * @param {object} [args.policyDecision] - Output of intervention-policy-engine.
 *   When provided, used as the suppression authority and to filter candidates.
 * @param {number} [args.now] - ms epoch. Required for determinism; defaults
 *   to Date.now() at the boundary with a diagnostics warning.
 * @param {number} [args.explorationRate=0]
 * @param {number} [args.rngSeed]
 * @returns {object} ranking result.
 */
function rankInterventions(args) {
  const {
    candidates,
    sessionState = {},
    fatigueState = {},
    signals = {},
    exposureHistory = [],
    policyDecision = null,
    explorationRate = CONFIG.defaultExplorationRate,
    rngSeed,
  } = args || {}

  const warnings = []
  const reasonCodes = []

  let now = args?.now
  if (typeof now !== "number" || !Number.isFinite(now)) {
    // P1-DET: throw instead of silently defaulting to Date.now()
    throw new Error("message-ranking-engine: 'now' parameter is required and must be a finite number")
  }

  // -- Cross-module suppression: cooldown enforcement (highest authority) --
  const cooldownUntil = fatigueState?.cooldownUntil
  if (typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && now < cooldownUntil) {
    reasonCodes.push("cooldown_active")
    return {
      selectedCandidate: null,
      ranked: [],
      decision: "COOLDOWN",
      shouldAbstain: true,
      nextEvaluateAt: cooldownUntil,
      reasonCodes,
      decisionId: buildDecisionId({ now, candidates, reasonCodes }),
      rankerVersion: RANKER_VERSION,
      diagnostics: buildRankingDiagnostics({
        scored: [],
        diversified: [],
        selected: null,
        rejectionReasons: {},
        warnings,
        reasonCodes,
        nowUsed: now,
        explorationApplied: false,
        explorationCandidateId: null,
      }),
    }
  }

  // -- Cross-module suppression: policy authority --
  if (policyDecision && policyDecision.shouldIntervene === false) {
    reasonCodes.push("policy_suppressed")
    return {
      selectedCandidate: null,
      ranked: [],
      decision: "POLICY_SUPPRESSED",
      shouldAbstain: true,
      nextEvaluateAt: policyDecision.nextEvaluateAt ?? null,
      reasonCodes,
      decisionId: buildDecisionId({ now, candidates, reasonCodes }),
      rankerVersion: RANKER_VERSION,
      diagnostics: buildRankingDiagnostics({
        scored: [],
        diversified: [],
        selected: null,
        rejectionReasons: {},
        warnings,
        reasonCodes,
        nowUsed: now,
        explorationApplied: false,
        explorationCandidateId: null,
      }),
    }
  }

  // -- Validate candidate list --
  if (!Array.isArray(candidates) || candidates.length === 0) {
    reasonCodes.push("no_candidates")
    return {
      selectedCandidate: null,
      ranked: [],
      decision: "NO_CANDIDATES",
      shouldAbstain: true,
      nextEvaluateAt: null,
      reasonCodes,
      decisionId: buildDecisionId({ now, candidates: [], reasonCodes }),
      rankerVersion: RANKER_VERSION,
      diagnostics: buildRankingDiagnostics({
        scored: [],
        diversified: [],
        selected: null,
        rejectionReasons: {},
        warnings,
        reasonCodes,
        nowUsed: now,
        explorationApplied: false,
        explorationCandidateId: null,
      }),
    }
  }

  // -- Schema validation + policy-allowed-family filter --
  const rejectionReasons = {}
  const valid = []
  const allowedFamilies =
    policyDecision && Array.isArray(policyDecision.allowedFamilies)
      ? new Set(policyDecision.allowedFamilies)
      : null
  const policyIntensityCeiling =
    policyDecision && typeof policyDecision.intensity === "number" && Number.isFinite(policyDecision.intensity)
      ? policyDecision.intensity
      : null

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const v = validateCandidate(c, i)
    if (!v.ok) {
      const key = c && (c.id ?? `idx_${i}`)
      rejectionReasons[String(key)] = v.reason
      continue
    }
    if (allowedFamilies && !allowedFamilies.has(c.family)) {
      const key = c.id ?? `idx_${i}`
      rejectionReasons[String(key)] = "family_not_allowed_by_policy"
      continue
    }
    const intensity = resolveCandidateIntensity(c)
    if (policyIntensityCeiling != null && intensity > policyIntensityCeiling + 1e-9) {
      const key = c.id ?? `idx_${i}`
      rejectionReasons[String(key)] = "intensity_exceeds_policy_ceiling"
      continue
    }
    valid.push(c)
  }

  if (valid.length === 0) {
    reasonCodes.push("all_candidates_rejected")
    return {
      selectedCandidate: null,
      ranked: [],
      decision: "ALL_REJECTED",
      shouldAbstain: true,
      nextEvaluateAt: policyDecision?.nextEvaluateAt ?? null,
      reasonCodes,
      decisionId: buildDecisionId({ now, candidates, reasonCodes, rejectionReasons }),
      rankerVersion: RANKER_VERSION,
      diagnostics: buildRankingDiagnostics({
        scored: [],
        diversified: [],
        selected: null,
        rejectionReasons,
        warnings,
        reasonCodes,
        nowUsed: now,
        explorationApplied: false,
        explorationCandidateId: null,
      }),
    }
  }

  // -- Score --
  const scored = valid.map((candidate) =>
    scoreCandidate({
      candidate,
      sessionState,
      fatigueState,
      signals,
      exposureHistory,
      policyDecision,
      now,
    }),
  )

  // -- Apply minRawScoreThreshold to rawScore (not final) --
  const aboveThreshold = scored.filter((s) => s.rawScore >= CONFIG.minRawScoreThreshold)
  for (const s of scored) {
    if (s.rawScore < CONFIG.minRawScoreThreshold) {
      const key = s.candidate.id ?? `fam_${s.candidate.family}`
      rejectionReasons[String(key)] = "below_min_raw_score"
    }
  }

  if (aboveThreshold.length === 0) {
    reasonCodes.push("no_candidate_above_threshold")
    // Surface the best rejected for analytics, but do not act.
    const bestRejected = scored.sort((a, b) => b.rawScore - a.rawScore)[0] ?? null
    return {
      selectedCandidate: null,
      bestRejectedCandidate: bestRejected ? bestRejected.candidate : null,
      ranked: scored.map(toRankedEntry),
      decision: "BELOW_THRESHOLD",
      shouldAbstain: true,
      nextEvaluateAt: null,
      reasonCodes,
      decisionId: buildDecisionId({ now, candidates, reasonCodes, rejectionReasons }),
      rankerVersion: RANKER_VERSION,
      diagnostics: buildRankingDiagnostics({
        scored,
        diversified: [],
        selected: null,
        rejectionReasons,
        warnings,
        reasonCodes,
        nowUsed: now,
        explorationApplied: false,
        explorationCandidateId: null,
      }),
    }
  }

  // -- Sort by finalScore desc, then deterministic tiebreak --
  aboveThreshold.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore
    // Tie-breaker: deterministic by family order then by id hash.
    const fa = FAMILIES.indexOf(a.candidate.family)
    const fb = FAMILIES.indexOf(b.candidate.family)
    if (fa !== fb) return fa - fb
    const ha = fnv1a(String(a.candidate.id ?? a.candidate.family))
    const hb = fnv1a(String(b.candidate.id ?? b.candidate.family))
    return ha - hb
  })

  // -- Diversify over top-K --
  const { admitted } = diversifyCandidates(
    aboveThreshold,
    CONFIG.diversificationTopK,
    CONFIG.diversificationMaxFamilyProportion,
  )

  // -- Selection (argmax with optional deterministic exploration) --
  let selected = admitted[0]
  let explorationApplied = false
  let explorationCandidateId = null

  const shouldExplore =
    typeof explorationRate === "number" &&
    explorationRate > 0 &&
    typeof rngSeed === "number" &&
    Number.isFinite(rngSeed) &&
    admitted.length > 1

  if (shouldExplore) {
    const rng = makeRng(rngSeed ^ Math.floor(now))
    if (rng() < explorationRate) {
      // Pick uniformly among non-top admitted.
      const idx = 1 + Math.floor(rng() * (admitted.length - 1))
      const exploreEntry = admitted[Math.min(idx, admitted.length - 1)]
      selected = exploreEntry
      explorationApplied = true
      explorationCandidateId = exploreEntry.candidate.id ?? null
      reasonCodes.push("exploration")
    }
  }

  // -- Abstain if too few survivors (low information regime) --
  if (admitted.length < CONFIG.abstainIfFewerThan) {
    reasonCodes.push("low_information")
    // Note: we still return the selection but flag abstain so the orchestrator
    // can decide. We do NOT null-out the selection here.
  }

  reasonCodes.push("ranked_ok")

  const ranked = admitted.map(toRankedEntry)
  const decisionId = buildDecisionId({
    now,
    candidates,
    reasonCodes,
    selected: selected?.candidate,
    rejectionReasons,
  })

  return {
    selectedCandidate: selected.candidate,
    ranked,
    decision: explorationApplied ? "EXPLORED" : "RANKED",
    shouldAbstain: admitted.length < CONFIG.abstainIfFewerThan,
    nextEvaluateAt: policyDecision?.nextEvaluateAt ?? null,
    reasonCodes,
    decisionId,
    rankerVersion: RANKER_VERSION,
    diagnostics: buildRankingDiagnostics({
      scored,
      diversified: admitted,
      selected,
      rejectionReasons,
      warnings,
      reasonCodes,
      nowUsed: now,
      explorationApplied,
      explorationCandidateId,
    }),
  }
}

function toRankedEntry(s) {
  return {
    candidate: s.candidate,
    rawScore: s.rawScore,
    finalScore: s.finalScore,
    subScores: s.subScores,
    presence: s.presence,
    risk: s.risk,
    intensity: s.intensity,
    attenuation: s.attenuation,
    effectiveExposures: s.effectiveExposures,
  }
}

function buildDecisionId({ now, candidates, reasonCodes, selected, rejectionReasons }) {
  const ids = (candidates || [])
    .map((c, i) => (c && (c.id != null ? `${c.family}:${c.id}` : `${c?.family ?? "?"}:${i}`)))
    .join("|")
  const sel = selected ? `${selected.family}:${selected.id ?? ""}` : ""
  const rj = rejectionReasons ? Object.keys(rejectionReasons).sort().join(",") : ""
  const rc = (reasonCodes || []).join(",")
  return "rk_" + fnv1a(`${now}|${ids}|${sel}|${rj}|${rc}`).toString(16)
}

/**
 * Convenience: return only the selected candidate (or null).
 * Kept for API compatibility with prior versions.
 */
function selectTopCandidate(rankingResult) {
  if (!rankingResult || typeof rankingResult !== "object") return null
  return rankingResult.selectedCandidate ?? null
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = Object.freeze({
  // Public API
  rankInterventions,
  selectTopCandidate,

  // Sub-score helpers (exported for testing / offline scoring; all require `now`)
  computeBehavioralFit,
  computeExpectedUtility,
  computeInterventionNovelty,
  computeFatigueCompatibility,
  computeContextualRelevance,
  computeTimingAlignment,
  computeMomentumAlignment,
  scoreCandidate,
  diversifyCandidates,

  // Family normalization (enterprise restructure)
  normalizeCandidateFamily,

  // Shared constants / matrices (sourced from ope-constants)
  CONFIG,
  FAMILIES,
  INTENT_STATES,
  FAMILY_COMPATIBILITY,
  FAMILY_DEFAULT_INTENSITY,
  RANKER_VERSION,
  MATRIX_VERSION,
  WEIGHTS_VERSION,
})
