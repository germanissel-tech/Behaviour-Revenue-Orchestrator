'use strict';

/**
 * ope-constants.js — SINGLE SOURCE OF TRUTH (v3 — enterprise restructure)
 *
 * ARCHITECTURAL DECISION:
 *   Every module in the OPE system MUST import taxonomy definitions from here.
 *   NO module may define its own intent states, message families, funnel stages,
 *   or behavioral event types.
 *
 * Changes in v3 (enterprise restructure):
 *   - MESSAGE_FAMILIES unified into a single enterprise taxonomy that covers
 *     BOTH the contextual-message-ranker families (benefit, social, quality...)
 *     AND the message-ranking-engine families (ASSIST, SOCIAL_PROOF, URGENCY...).
 *     The canonical form is UPPERCASE. A FAMILY_ALIASES map provides backward
 *     compatibility for lowercase callers.
 *   - INTENT_STATES expanded to 9 canonical states (including comparing, disengaging).
 *   - FAMILY_COMPATIBILITY_MATRIX defined here as the single authority for
 *     family-intent compatibility scoring.
 *   - INTENT_FAMILY_MODIFIERS updated to use unified family names.
 *   - All timestamps are explicit (nowMs). No Date.now() anywhere.
 */

// ---------------------------------------------------------------------------
// Intent states — canonical set (9 states)
// Used by: unified-intent-engine, intervention-policy-engine, message-ranking-engine
// ---------------------------------------------------------------------------
const INTENT_STATES = Object.freeze({
  EXPLORING:      'exploring',
  EVALUATING:     'evaluating',
  COMPARING:      'comparing',
  HESITATING:     'hesitating',
  HIGH_INTENT:    'high_intent',
  PURCHASE_READY: 'purchase_ready',
  EXIT_RISK:      'exit_risk',
  DISENGAGING:    'disengaging',
  UNKNOWN:        'unknown',
});

const VALID_INTENT_STATES = Object.freeze(
  new Set(Object.values(INTENT_STATES))
);

const INITIAL_INTENT_STATE = INTENT_STATES.EXPLORING;

// Intent state valences for confidence/agreement calculations
const INTENT_VALENCE = Object.freeze({
  [INTENT_STATES.EXPLORING]:      0,
  [INTENT_STATES.EVALUATING]:     1,
  [INTENT_STATES.COMPARING]:      0,
  [INTENT_STATES.HESITATING]:     0,
  [INTENT_STATES.HIGH_INTENT]:    1,
  [INTENT_STATES.PURCHASE_READY]: 1,
  [INTENT_STATES.EXIT_RISK]:     -1,
  [INTENT_STATES.DISENGAGING]:   -1,
  [INTENT_STATES.UNKNOWN]:        0,
});

// Legacy alias mapping for backward compatibility with old intent names
const LEGACY_INTENT_ALIASES = Object.freeze({
  browsing:     INTENT_STATES.EXPLORING,
  considering:  INTENT_STATES.EVALUATING,
  deciding:     INTENT_STATES.HIGH_INTENT,
  doubting:     INTENT_STATES.HESITATING,
  purchasing:   INTENT_STATES.PURCHASE_READY,
  frustrated:   INTENT_STATES.EXIT_RISK,
  idle:         INTENT_STATES.DISENGAGING,
});

/**
 * Normalize any intent state string to a canonical INTENT_STATES value.
 * Handles legacy aliases, case normalization, and unknown values.
 */
function normalizeIntentState(state) {
  if (typeof state !== 'string') return INTENT_STATES.UNKNOWN;
  const lower = state.toLowerCase();
  if (VALID_INTENT_STATES.has(lower)) return lower;
  return LEGACY_INTENT_ALIASES[lower] || INTENT_STATES.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------
const VALID_CONTEXTS = Object.freeze(
  new Set(['listing', 'modal', 'hover_cta', 'product_detail', 'cart', 'checkout'])
);

// ---------------------------------------------------------------------------
// Message families — UNIFIED ENTERPRISE TAXONOMY
//
// This replaces TWO incompatible taxonomies:
//   OLD ranker families:   ASSIST, SOCIAL_PROOF, URGENCY, REASSURANCE, EDUCATIONAL, CART_SUPPORT, RECOVERY
//   OLD contextual families: benefit, social, quality, compatibility, reassurance, urgency, expertise, lifestyle, comparison
//
// The new taxonomy preserves ALL semantic categories and maps them into a single
// canonical set. The canonical form uses UPPERCASE.
// ---------------------------------------------------------------------------
const MESSAGE_FAMILIES = Object.freeze({
  // Core persuasion families
  BENEFIT:        'BENEFIT',        // Product advantages, value proposition
  SOCIAL_PROOF:   'SOCIAL_PROOF',   // Reviews, popularity, community validation
  QUALITY:        'QUALITY',        // Materials, craftsmanship, durability
  COMPATIBILITY:  'COMPATIBILITY',  // Fit, size, space, use-case match
  REASSURANCE:    'REASSURANCE',    // Returns, guarantees, risk reduction
  URGENCY:        'URGENCY',        // Scarcity, time-limited, stock alerts
  EXPERTISE:      'EXPERTISE',      // Technical details, specs, professional guidance
  LIFESTYLE:      'LIFESTYLE',      // Aspirational, identity, occasion-based
  COMPARISON:     'COMPARISON',     // Differentiation, alternatives, trade-offs

  // Operational families (from ranking engine)
  CART_SUPPORT:   'CART_SUPPORT',   // Cart-specific help, checkout facilitation
  RECOVERY:       'RECOVERY',       // Re-engagement, win-back, exit-risk intervention
});

const MESSAGE_FAMILY_LIST = Object.freeze(Object.values(MESSAGE_FAMILIES));

const VALID_MESSAGE_FAMILIES = Object.freeze(new Set(MESSAGE_FAMILY_LIST));

// Bridge mapping: old lowercase families -> canonical UPPERCASE
// Used by modules transitioning from the old contextual-message-ranker taxonomy
const FAMILY_ALIASES = Object.freeze({
  benefit:       MESSAGE_FAMILIES.BENEFIT,
  social:        MESSAGE_FAMILIES.SOCIAL_PROOF,
  quality:       MESSAGE_FAMILIES.QUALITY,
  compatibility: MESSAGE_FAMILIES.COMPATIBILITY,
  reassurance:   MESSAGE_FAMILIES.REASSURANCE,
  urgency:       MESSAGE_FAMILIES.URGENCY,
  expertise:     MESSAGE_FAMILIES.EXPERTISE,
  lifestyle:     MESSAGE_FAMILIES.LIFESTYLE,
  comparison:    MESSAGE_FAMILIES.COMPARISON,
  // Old ranking engine families (already uppercase, but include for completeness)
  ASSIST:        MESSAGE_FAMILIES.EXPERTISE,       // ASSIST maps to EXPERTISE (informational help)
  EDUCATIONAL:   MESSAGE_FAMILIES.EXPERTISE,       // EDUCATIONAL maps to EXPERTISE
  SOCIAL_PROOF:  MESSAGE_FAMILIES.SOCIAL_PROOF,
  URGENCY:       MESSAGE_FAMILIES.URGENCY,
  REASSURANCE:   MESSAGE_FAMILIES.REASSURANCE,
  CART_SUPPORT:  MESSAGE_FAMILIES.CART_SUPPORT,
  RECOVERY:      MESSAGE_FAMILIES.RECOVERY,
});

/**
 * Normalize any family string to a canonical MESSAGE_FAMILIES value.
 */
function normalizeFamily(family) {
  if (typeof family !== 'string') return null;
  const upper = family.toUpperCase();
  if (VALID_MESSAGE_FAMILIES.has(upper)) return upper;
  return FAMILY_ALIASES[family] || FAMILY_ALIASES[upper] || null;
}

// ---------------------------------------------------------------------------
// Priority bypass families (escape fatigue cooldowns in critical moments)
// ---------------------------------------------------------------------------
const PRIORITY_BYPASS_FAMILIES = Object.freeze([
  MESSAGE_FAMILIES.RECOVERY,
  MESSAGE_FAMILIES.CART_SUPPORT,
]);

// ---------------------------------------------------------------------------
// Funnel stages — canonical set for funnel-stage-engine
// ---------------------------------------------------------------------------
const FUNNEL_STAGES = Object.freeze({
  DISCOVERY:             'discovery',
  CONSIDERATION:         'consideration',
  EVALUATION:            'evaluation',
  PURCHASE_INTENT:       'purchase_intent',
  CART_REVIEW:           'cart_review',
  CHECKOUT_READY:        'checkout_ready',
  POST_CART_HESITATION:  'post_cart_hesitation',
});

// ---------------------------------------------------------------------------
// FAMILY COMPATIBILITY MATRIX — SINGLE AUTHORITY
// Maps: family -> intent state -> compatibility score [0, 1]
// Used by: message-ranking-engine, intervention-policy-engine
// ---------------------------------------------------------------------------
const FAMILY_COMPATIBILITY_MATRIX = Object.freeze({
  [MESSAGE_FAMILIES.BENEFIT]: Object.freeze({
    exploring: 0.85, evaluating: 0.80, comparing: 0.70, hesitating: 0.50,
    high_intent: 0.40, purchase_ready: 0.30, exit_risk: 0.35, disengaging: 0.40, unknown: 0.30,
  }),
  [MESSAGE_FAMILIES.SOCIAL_PROOF]: Object.freeze({
    exploring: 0.70, evaluating: 0.75, comparing: 0.85, hesitating: 0.80,
    high_intent: 0.65, purchase_ready: 0.55, exit_risk: 0.50, disengaging: 0.35, unknown: 0.40,
  }),
  [MESSAGE_FAMILIES.QUALITY]: Object.freeze({
    exploring: 0.60, evaluating: 0.80, comparing: 0.75, hesitating: 0.70,
    high_intent: 0.55, purchase_ready: 0.45, exit_risk: 0.40, disengaging: 0.35, unknown: 0.30,
  }),
  [MESSAGE_FAMILIES.COMPATIBILITY]: Object.freeze({
    exploring: 0.50, evaluating: 0.70, comparing: 0.75, hesitating: 0.85,
    high_intent: 0.60, purchase_ready: 0.50, exit_risk: 0.45, disengaging: 0.35, unknown: 0.25,
  }),
  [MESSAGE_FAMILIES.REASSURANCE]: Object.freeze({
    exploring: 0.50, evaluating: 0.65, comparing: 0.70, hesitating: 0.90,
    high_intent: 0.65, purchase_ready: 0.55, exit_risk: 0.70, disengaging: 0.60, unknown: 0.30,
  }),
  [MESSAGE_FAMILIES.URGENCY]: Object.freeze({
    exploring: 0.20, evaluating: 0.30, comparing: 0.35, hesitating: 0.50,
    high_intent: 0.75, purchase_ready: 0.85, exit_risk: 0.25, disengaging: 0.15, unknown: 0.15,
  }),
  [MESSAGE_FAMILIES.EXPERTISE]: Object.freeze({
    exploring: 0.85, evaluating: 0.75, comparing: 0.70, hesitating: 0.55,
    high_intent: 0.35, purchase_ready: 0.25, exit_risk: 0.30, disengaging: 0.35, unknown: 0.40,
  }),
  [MESSAGE_FAMILIES.LIFESTYLE]: Object.freeze({
    exploring: 0.80, evaluating: 0.65, comparing: 0.55, hesitating: 0.40,
    high_intent: 0.35, purchase_ready: 0.30, exit_risk: 0.30, disengaging: 0.25, unknown: 0.25,
  }),
  [MESSAGE_FAMILIES.COMPARISON]: Object.freeze({
    exploring: 0.55, evaluating: 0.75, comparing: 0.90, hesitating: 0.65,
    high_intent: 0.40, purchase_ready: 0.25, exit_risk: 0.35, disengaging: 0.30, unknown: 0.25,
  }),
  [MESSAGE_FAMILIES.CART_SUPPORT]: Object.freeze({
    exploring: 0.30, evaluating: 0.50, comparing: 0.55, hesitating: 0.65,
    high_intent: 0.85, purchase_ready: 0.90, exit_risk: 0.65, disengaging: 0.40, unknown: 0.20,
  }),
  [MESSAGE_FAMILIES.RECOVERY]: Object.freeze({
    exploring: 0.30, evaluating: 0.40, comparing: 0.40, hesitating: 0.60,
    high_intent: 0.45, purchase_ready: 0.35, exit_risk: 0.90, disengaging: 0.85, unknown: 0.25,
  }),
});

// ---------------------------------------------------------------------------
// Intent -> message family affinity modifiers
// Used by rankers to boost/penalize families based on current intent
// ---------------------------------------------------------------------------
const INTENT_FAMILY_MODIFIERS = Object.freeze({
  [INTENT_STATES.EXPLORING]:      { BENEFIT: 1.2, LIFESTYLE: 1.1, EXPERTISE: 1.0, SOCIAL_PROOF: 0.9, URGENCY: 0.2, REASSURANCE: 0.5 },
  [INTENT_STATES.EVALUATING]:     { QUALITY: 1.3, COMPARISON: 1.2, EXPERTISE: 1.1, BENEFIT: 1.0, REASSURANCE: 0.8 },
  [INTENT_STATES.COMPARING]:      { COMPARISON: 1.4, EXPERTISE: 1.2, QUALITY: 1.1, SOCIAL_PROOF: 1.0, BENEFIT: 0.8 },
  [INTENT_STATES.HESITATING]:     { REASSURANCE: 1.5, COMPATIBILITY: 1.3, QUALITY: 1.2, SOCIAL_PROOF: 1.0, URGENCY: 0.1 },
  [INTENT_STATES.HIGH_INTENT]:    { REASSURANCE: 1.3, SOCIAL_PROOF: 1.2, CART_SUPPORT: 1.1, URGENCY: 0.8 },
  [INTENT_STATES.PURCHASE_READY]: { REASSURANCE: 1.2, CART_SUPPORT: 1.1, SOCIAL_PROOF: 1.0, URGENCY: 0.5 },
  [INTENT_STATES.EXIT_RISK]:      { RECOVERY: 1.5, REASSURANCE: 1.4, SOCIAL_PROOF: 1.2, COMPATIBILITY: 1.1, URGENCY: 0.2 },
  [INTENT_STATES.DISENGAGING]:    { RECOVERY: 1.3, REASSURANCE: 1.2, BENEFIT: 0.9, URGENCY: 0.3 },
  [INTENT_STATES.UNKNOWN]:        { REASSURANCE: 1.0, EXPERTISE: 0.9, BENEFIT: 0.8 },
});

// ---------------------------------------------------------------------------
// Funnel stage -> message families + behavior rules
// ---------------------------------------------------------------------------
const STAGE_MESSAGE_CONFIG = Object.freeze({
  [FUNNEL_STAGES.DISCOVERY]: {
    families: [MESSAGE_FAMILIES.BENEFIT, MESSAGE_FAMILIES.LIFESTYLE, MESSAGE_FAMILIES.SOCIAL_PROOF],
    intensity: 'low',
    maxPerStage: 2,
    cooldownMs: 20000,
    humanTrigger: 'Primera visita — suave descubrimiento, sin presion',
  },
  [FUNNEL_STAGES.CONSIDERATION]: {
    families: [MESSAGE_FAMILIES.BENEFIT, MESSAGE_FAMILIES.QUALITY, MESSAGE_FAMILIES.COMPARISON, MESSAGE_FAMILIES.EXPERTISE],
    intensity: 'medium',
    maxPerStage: 3,
    cooldownMs: 15000,
    humanTrigger: 'Volvio al producto o abrio detalles — informacion mas profunda',
  },
  [FUNNEL_STAGES.EVALUATION]: {
    families: [MESSAGE_FAMILIES.EXPERTISE, MESSAGE_FAMILIES.COMPATIBILITY, MESSAGE_FAMILIES.QUALITY, MESSAGE_FAMILIES.COMPARISON],
    intensity: 'medium',
    maxPerStage: 4,
    cooldownMs: 12000,
    humanTrigger: 'Cambia variantes o dwells largo — ayuda con decision especifica',
  },
  [FUNNEL_STAGES.PURCHASE_INTENT]: {
    families: [MESSAGE_FAMILIES.REASSURANCE, MESSAGE_FAMILIES.SOCIAL_PROOF, MESSAGE_FAMILIES.URGENCY],
    intensity: 'medium-high',
    maxPerStage: 3,
    cooldownMs: 10000,
    humanTrigger: 'Esta a punto de comprar — reducir friccion final, no presionar',
  },
  [FUNNEL_STAGES.CART_REVIEW]: {
    families: [MESSAGE_FAMILIES.COMPATIBILITY, MESSAGE_FAMILIES.REASSURANCE, MESSAGE_FAMILIES.SOCIAL_PROOF, MESSAGE_FAMILIES.QUALITY],
    intensity: 'medium',
    maxPerStage: 3,
    cooldownMs: 15000,
    humanTrigger: 'En carrito — reforzar decision, envio, devoluciones, confianza',
  },
  [FUNNEL_STAGES.CHECKOUT_READY]: {
    families: [MESSAGE_FAMILIES.REASSURANCE, MESSAGE_FAMILIES.SOCIAL_PROOF],
    intensity: 'low',
    maxPerStage: 1,
    cooldownMs: 30000,
    humanTrigger: 'Listo para comprar — solo refuerzo suave, no interrumpir',
  },
  [FUNNEL_STAGES.POST_CART_HESITATION]: {
    families: [MESSAGE_FAMILIES.REASSURANCE, MESSAGE_FAMILIES.COMPATIBILITY, MESSAGE_FAMILIES.QUALITY, MESSAGE_FAMILIES.EXPERTISE],
    intensity: 'medium-high',
    maxPerStage: 4,
    cooldownMs: 8000,
    humanTrigger: 'Esta dudando o quito del carrito — pregunta clave que ayude a decidir',
  },
});

// ---------------------------------------------------------------------------
// Emotional states (used by intervention-policy-engine)
// ---------------------------------------------------------------------------
const EMOTIONAL_STATES = Object.freeze({
  NEUTRAL:    'neutral',
  CONFIDENT:  'confident',
  HESITANT:   'hesitant',
  ANXIOUS:    'anxious',
  FRUSTRATED: 'frustrated',
  ENGAGED:    'engaged',
  UNKNOWN:    'unknown',
});

// ---------------------------------------------------------------------------
// Behavioral event types recognized across the system
// ---------------------------------------------------------------------------
const BEHAVIORAL_EVENTS = Object.freeze([
  'product_view', 'product_hover', 'product_exit', 'product_revisit',
  'dwell_tick',
  'modal_open', 'modal_close', 'variant_change',
  'cart_add', 'cart_remove', 'cart_variant_change', 'cart_dwell',
  'cart_product_reopen', 'cart_remove_intent',
  'cta_hover', 'cta_click',
  'checkout_hover',
  'context_transition',
  'scroll',
  'session_start', 'session_end',
]);

// ---------------------------------------------------------------------------
// Micro-intentions (from behavioral-intelligence-layer, read-only enrichment)
// These are NOT intent states. They are secondary behavioral signals.
// ---------------------------------------------------------------------------
const MICRO_INTENTIONS = Object.freeze({
  HESITATING:                  'hesitating',
  COMPARING:                   'comparing',
  UNCERTAIN:                   'uncertain',
  HIGH_INTENT_LOW_CONFIDENCE:  'high_intent_low_confidence',
  IMPULSIVE:                   'impulsive',
  ANALYTICAL:                  'analytical',
  EXPLORATORY:                 'exploratory',
  RETURN_RISK_HIGH:            'return_risk_high',
  RETURN_RISK_MEDIUM:          'return_risk_medium',
  RETURN_RISK_LOW:             'return_risk_low',
  CONFIDENT_BUYER:             'confident_buyer',
  NEEDS_REASSURANCE:           'needs_reassurance',
  PRICE_SENSITIVE:             'price_sensitive',
});

// ---------------------------------------------------------------------------
// Architecture ownership map (documentation, enforced by session-orchestrator)
// ---------------------------------------------------------------------------
const OWNERSHIP_MAP = Object.freeze({
  orchestration:        'session-orchestrator',
  intent_inference:     'unified-intent-engine',
  intent_enrichment:    'behavioral-intelligence-layer',
  fatigue_authority:    'cooldown-fatigue-engine',
  ranking_authority:    'message-ranking-engine',
  policy_authority:     'intervention-policy-engine',
  funnel_tracking:      'funnel-stage-engine',
  cart_intelligence:    'cart-intelligence-engine',
  message_generation:   'human-message-engine',
  signal_derivation:    'signal-derivation-engine',
  state_store:          'behavioral-state-store',
  message_lifecycle:    'message-lifecycle-controller',
  message_visibility:   'message-visibility-controller',
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Intent
  INTENT_STATES,
  VALID_INTENT_STATES,
  INITIAL_INTENT_STATE,
  INTENT_VALENCE,
  LEGACY_INTENT_ALIASES,
  normalizeIntentState,

  // Contexts
  VALID_CONTEXTS,

  // Message families
  MESSAGE_FAMILIES,
  MESSAGE_FAMILY_LIST,
  VALID_MESSAGE_FAMILIES,
  FAMILY_ALIASES,
  normalizeFamily,
  PRIORITY_BYPASS_FAMILIES,

  // Funnel
  FUNNEL_STAGES,
  STAGE_MESSAGE_CONFIG,

  // Compatibility
  FAMILY_COMPATIBILITY_MATRIX,
  INTENT_FAMILY_MODIFIERS,

  // Emotional states
  EMOTIONAL_STATES,

  // Events
  BEHAVIORAL_EVENTS,

  // Micro-intentions
  MICRO_INTENTIONS,

  // Architecture
  OWNERSHIP_MAP,
};
