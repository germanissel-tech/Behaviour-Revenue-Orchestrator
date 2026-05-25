/**
 * product-relationship-types.js
 *
 * PRODUCT RELATIONSHIP TAXONOMY — Defines relationship types and validation rules.
 *
 * This module is part of the Product Relationship Intelligence system which:
 *   - Detects potentially incomplete purchases (NOT cross-sell/upsell)
 *   - Applies extreme caution (false positives are worse than missed opportunities)
 *   - Restricts automatic intervention to FOOD/GROCERY/DELIVERY categories ONLY
 *
 * Design principles:
 *   - Trust > False-positive reduction > Useful interventions > Conversion
 *   - NO assumptions about user needs
 *   - NO aggressive messaging ("Don't forget", "You need")
 *   - Maximum 1 intervention per relationship type per session
 *
 * Integration with OPE:
 *   - Returns SIGNALS only (does not render UI)
 *   - Respects session-orchestrator as single orchestration authority
 *   - Uses cooldown-fatigue-engine for fatigue/cooldowns
 *   - Deterministic: NO Date.now(), NO Math.random()
 */

'use strict';

// ============================================================================
// RELATIONSHIP TYPES
// ============================================================================

const RELATIONSHIP_TYPES = Object.freeze({
  /**
   * REQUIRED_COMPONENT: The suggested product is functionally necessary.
   * Example: Batteries for a remote control, eggs for a cake recipe.
   * Automatic intervention: ALLOWED (only for FOOD/GROCERY/DELIVERY)
   */
  REQUIRED_COMPONENT: 'required_component',

  /**
   * PREPARATION_COMPONENT: The suggested product is part of a common preparation.
   * Example: Vanilla extract for a cake recipe, onions for a tomato sauce.
   * Automatic intervention: ALLOWED (only for FOOD/GROCERY/DELIVERY)
   */
  PREPARATION_COMPONENT: 'preparation_component',

  /**
   * OPTIONAL_COMPLEMENT: The suggested product is commonly purchased together
   * but NOT functionally required.
   * Example: Side dish with a main course, condiment with a snack.
   * Automatic intervention: NEVER (show only on explicit user request)
   */
  OPTIONAL_COMPLEMENT: 'optional_complement',

  /**
   * LIFESTYLE_COMPLEMENT: The suggested product is aspirationally associated
   * but has no functional relationship.
   * Example: Camera → SD card, shirt → shoes, phone → headphones.
   * Automatic intervention: BLOCKED (never intervene automatically)
   */
  LIFESTYLE_COMPLEMENT: 'lifestyle_complement',
});

// Set of all valid relationship types
const VALID_RELATIONSHIP_TYPES = Object.freeze(
  new Set(Object.values(RELATIONSHIP_TYPES))
);

// ============================================================================
// ALLOWED CATEGORIES FOR AUTOMATIC INTERVENTION
// ============================================================================

/**
 * Only these categories can receive automatic relationship interventions.
 * All other categories (fashion, tech, electronics, etc.) are BLOCKED.
 */
const ALLOWED_INTERVENTION_CATEGORIES = Object.freeze(new Set([
  'food',
  'grocery',
  'delivery',
  'groceries',
  'supermarket',
  'restaurant',
  'meal',
  'recipe',
  'ingredients',
  'cooking',
  'baking',
  'produce',
  'fresh',
  'pantry',
]));

/**
 * Categories that are EXPLICITLY BLOCKED from automatic intervention.
 * These are high-risk for false positives or annoying assumptions.
 */
const BLOCKED_INTERVENTION_CATEGORIES = Object.freeze(new Set([
  'fashion',
  'clothing',
  'apparel',
  'technology',
  'tech',
  'electronics',
  'computers',
  'phones',
  'accessories',
  'jewelry',
  'watches',
  'beauty',
  'cosmetics',
  'furniture',
  'home_decor',
  'automotive',
  'sports',
  'fitness',
  'toys',
  'games',
]));

// ============================================================================
// FORBIDDEN RELATIONSHIP PATTERNS
// These product pairs should NEVER receive automatic intervention regardless
// of category, because they make assumptions about user needs.
// ============================================================================

const FORBIDDEN_RELATIONSHIP_PATTERNS = Object.freeze([
  // Tech accessories that assume user needs
  { from: 'camera', to: 'memory_card' },
  { from: 'camera', to: 'sd_card' },
  { from: 'phone', to: 'case' },
  { from: 'phone', to: 'headphones' },
  { from: 'phone', to: 'charger' },
  { from: 'laptop', to: 'bag' },
  { from: 'laptop', to: 'mouse' },
  { from: 'tablet', to: 'keyboard' },
  { from: 'console', to: 'controller' },
  { from: 'console', to: 'game' },

  // Fashion assumptions
  { from: 'shirt', to: 'pants' },
  { from: 'shirt', to: 'shoes' },
  { from: 'dress', to: 'shoes' },
  { from: 'dress', to: 'bag' },
  { from: 'jacket', to: 'scarf' },
  { from: 'suit', to: 'tie' },

  // Fast food assumptions (even within food category)
  { from: 'burger', to: 'fries' },
  { from: 'pizza', to: 'soda' },
  { from: 'sandwich', to: 'chips' },
  { from: 'coffee', to: 'pastry' },
  { from: 'main_course', to: 'dessert' },
]);

// ============================================================================
// INTERVENTION PERMISSION RULES
// ============================================================================

/**
 * Determines if a relationship type can trigger automatic intervention.
 *
 * @param {string} relationshipType - One of RELATIONSHIP_TYPES
 * @returns {boolean}
 */
function canRelationshipIntervene(relationshipType) {
  switch (relationshipType) {
    case RELATIONSHIP_TYPES.REQUIRED_COMPONENT:
      return true;
    case RELATIONSHIP_TYPES.PREPARATION_COMPONENT:
      return true;
    case RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT:
      return false; // NEVER auto-intervene
    case RELATIONSHIP_TYPES.LIFESTYLE_COMPLEMENT:
      return false; // BLOCKED
    default:
      return false; // Unknown types are blocked
  }
}

/**
 * Determines if a category is allowed for automatic intervention.
 *
 * @param {string} category - Product category (normalized to lowercase)
 * @returns {boolean}
 */
function isInterventionAllowedForCategory(category) {
  if (typeof category !== 'string') return false;
  const normalized = category.toLowerCase().trim();

  // Explicitly blocked categories always return false
  if (BLOCKED_INTERVENTION_CATEGORIES.has(normalized)) {
    return false;
  }

  // Must be in the allowed list
  return ALLOWED_INTERVENTION_CATEGORIES.has(normalized);
}

/**
 * Checks if a from→to subcategory pair is in the forbidden patterns.
 *
 * @param {string} fromSubcategory
 * @param {string} toSubcategory
 * @returns {boolean}
 */
function isRelationshipForbidden(fromSubcategory, toSubcategory) {
  if (!fromSubcategory || !toSubcategory) return false;

  const fromNorm = fromSubcategory.toLowerCase().trim();
  const toNorm = toSubcategory.toLowerCase().trim();

  for (const pattern of FORBIDDEN_RELATIONSHIP_PATTERNS) {
    if (pattern.from === fromNorm && pattern.to === toNorm) {
      return true;
    }
    // Also check reverse (bidirectional blocking)
    if (pattern.from === toNorm && pattern.to === fromNorm) {
      return true;
    }
  }
  return false;
}

/**
 * Validates whether an intervention is permitted given all constraints.
 *
 * @param {object} params
 * @param {string} params.fromCategory - Trigger product category
 * @param {string} params.toCategory - Suggested product category
 * @param {string} params.relationshipType - One of RELATIONSHIP_TYPES
 * @param {string} [params.fromSubcategory] - Optional subcategory
 * @param {string} [params.toSubcategory] - Optional subcategory
 * @returns {{ allowed: boolean, reason: string }}
 */
function validateInterventionPermission({
  fromCategory,
  toCategory,
  relationshipType,
  fromSubcategory,
  toSubcategory,
}) {
  // 1. Check category allowlist FIRST (most restrictive check)
  if (!isInterventionAllowedForCategory(fromCategory)) {
    return {
      allowed: false,
      reason: `category_not_allowed:${fromCategory}`,
    };
  }

  // 2. Check relationship type permission
  if (!canRelationshipIntervene(relationshipType)) {
    return {
      allowed: false,
      reason: `relationship_type_blocked:${relationshipType}`,
    };
  }

  // 3. Check for forbidden patterns
  if (isRelationshipForbidden(fromSubcategory, toSubcategory)) {
    return {
      allowed: false,
      reason: `forbidden_pattern:${fromSubcategory}→${toSubcategory}`,
    };
  }

  // 4. Additional check: LIFESTYLE_COMPLEMENT is always blocked
  if (relationshipType === RELATIONSHIP_TYPES.LIFESTYLE_COMPLEMENT) {
    return {
      allowed: false,
      reason: 'lifestyle_complement_always_blocked',
    };
  }

  // 5. Additional check: OPTIONAL_COMPLEMENT is always blocked for auto
  if (relationshipType === RELATIONSHIP_TYPES.OPTIONAL_COMPLEMENT) {
    return {
      allowed: false,
      reason: 'optional_complement_never_auto_intervene',
    };
  }

  return { allowed: true, reason: 'passed_all_checks' };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Types
  RELATIONSHIP_TYPES,
  VALID_RELATIONSHIP_TYPES,

  // Categories
  ALLOWED_INTERVENTION_CATEGORIES,
  BLOCKED_INTERVENTION_CATEGORIES,

  // Patterns
  FORBIDDEN_RELATIONSHIP_PATTERNS,

  // Functions
  canRelationshipIntervene,
  isInterventionAllowedForCategory,
  isRelationshipForbidden,
  validateInterventionPermission,
};
