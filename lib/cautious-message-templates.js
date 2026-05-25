/**
 * cautious-message-templates.js
 *
 * CAUTIOUS MESSAGE TEMPLATES — Non-aggressive, trust-preserving messages.
 *
 * These messages are designed to:
 *   - NEVER assume user needs ("Don't forget", "You need")
 *   - NEVER pressure ("Last chance", "Only X left")
 *   - Provide INFORMATION, not commands
 *   - Use PASSIVE voice and hedging language
 *   - Be IGNORABLE without user guilt
 *
 * Language patterns:
 *   - "Some people..."
 *   - "You might consider..."
 *   - "For reference..."
 *   - "Information: ..."
 */

'use strict';

// ============================================================================
// FORBIDDEN PHRASES
// These phrases must NEVER appear in messages.
// ============================================================================

const FORBIDDEN_PHRASES = Object.freeze([
  // Assumptive
  "don't forget",
  "dont forget",
  "you need",
  "you'll need",
  "you will need",
  "you must",
  "essential for",
  "required for",
  "necessary for",

  // Pressuring
  "last chance",
  "limited time",
  "act now",
  "hurry",
  "running out",
  "almost gone",
  "selling fast",
  "don't miss",
  "dont miss",

  // Manipulative
  "complete your",
  "finish your",
  "you're missing",
  "you forgot",
  "you left out",
  "everyone buys",
  "most people buy",

  // Direct commands
  "add this",
  "buy this",
  "get this",
  "grab this",
]);

// ============================================================================
// CAUTIOUS MESSAGE TEMPLATES
// ============================================================================

/**
 * Templates are organized by relationship type and language.
 * Each template uses placeholders:
 *   - {suggestedProduct} - The product being suggested
 *   - {triggerProduct} - The product that triggered the suggestion
 *   - {category} - Product category
 */
const MESSAGE_TEMPLATES = Object.freeze({
  // REQUIRED COMPONENT - Spanish
  required_component_es: [
    'Algunas personas suelen comprar {suggestedProduct} junto con {triggerProduct}.',
    'Información: {suggestedProduct} es un componente común para este tipo de preparación.',
    'Podría interesarte saber que {suggestedProduct} suele acompañar a {triggerProduct}.',
  ],

  // REQUIRED COMPONENT - English
  required_component_en: [
    'Some people often buy {suggestedProduct} along with {triggerProduct}.',
    'For reference: {suggestedProduct} is a common component for this type of preparation.',
    'You might be interested to know that {suggestedProduct} often accompanies {triggerProduct}.',
  ],

  // PREPARATION COMPONENT - Spanish
  preparation_component_es: [
    'Algunas personas suelen añadir {suggestedProduct} a esta preparación.',
    'Información: {suggestedProduct} es parte común de esta preparación.',
    'Podría interesarte: {suggestedProduct} suele acompañar a {triggerProduct}.',
  ],

  // PREPARATION COMPONENT - English
  preparation_component_en: [
    'Some people usually add {suggestedProduct} to this preparation.',
    'For reference: {suggestedProduct} is commonly part of this preparation.',
    'You might be interested: {suggestedProduct} often accompanies {triggerProduct}.',
  ],

  // OPTIONAL COMPLEMENT - Spanish (shown ONLY on explicit user request)
  optional_complement_es: [
    'Otros productos en la categoría {category}: {suggestedProduct}.',
    'También disponible: {suggestedProduct}.',
  ],

  // OPTIONAL COMPLEMENT - English
  optional_complement_en: [
    'Other products in {category}: {suggestedProduct}.',
    'Also available: {suggestedProduct}.',
  ],

  // INFORMATIONAL (generic, no pressure)
  informational_es: [
    'Dato: {suggestedProduct} está disponible.',
    'Para tu información: también tenemos {suggestedProduct}.',
  ],

  informational_en: [
    'FYI: {suggestedProduct} is available.',
    'For your information: we also have {suggestedProduct}.',
  ],
});

// ============================================================================
// MESSAGE GENERATION
// ============================================================================

/**
 * Validates that a message does not contain forbidden phrases.
 *
 * @param {string} message
 * @returns {{ valid: boolean, forbiddenFound?: string }}
 */
function validateMessage(message) {
  if (typeof message !== 'string') {
    return { valid: false, forbiddenFound: 'not_a_string' };
  }

  const lowerMessage = message.toLowerCase();

  for (const phrase of FORBIDDEN_PHRASES) {
    if (lowerMessage.includes(phrase)) {
      return { valid: false, forbiddenFound: phrase };
    }
  }

  return { valid: true };
}

/**
 * Generates a cautious message for a product relationship.
 *
 * @param {object} params
 * @param {string} params.relationshipType - One of RELATIONSHIP_TYPES
 * @param {string} params.suggestedProduct - Name of suggested product
 * @param {string} params.triggerProduct - Name of trigger product
 * @param {string} [params.category] - Product category
 * @param {string} [params.language='es'] - Language code
 * @param {number} [params.seed] - Seed for deterministic template selection
 * @returns {{ message: string, templateKey: string, valid: boolean }}
 */
function generateCautiousMessage(params) {
  const {
    relationshipType,
    suggestedProduct,
    triggerProduct,
    category,
    language = 'es',
    seed = 0,
  } = params;

  // Determine template key
  const normalizedType = (relationshipType || 'informational').toLowerCase();
  const templateKey = `${normalizedType}_${language}`;

  // Get templates, fallback to informational
  let templates = MESSAGE_TEMPLATES[templateKey];
  if (!templates || templates.length === 0) {
    templates = MESSAGE_TEMPLATES[`informational_${language}`] ||
                MESSAGE_TEMPLATES.informational_es;
  }

  // Deterministic selection using seed
  const index = Math.abs(seed) % templates.length;
  let message = templates[index];

  // Replace placeholders
  message = message
    .replace(/{suggestedProduct}/g, suggestedProduct || '')
    .replace(/{triggerProduct}/g, triggerProduct || '')
    .replace(/{category}/g, category || '')
    .trim();

  // Validate the generated message
  const validation = validateMessage(message);

  return {
    message,
    templateKey,
    valid: validation.valid,
    forbiddenFound: validation.forbiddenFound,
  };
}

/**
 * Creates a message context object for tracking.
 *
 * @param {object} params
 * @returns {object}
 */
function createMessageContext(params) {
  const { relationshipId, triggerProductId, suggestedProductId, relationshipType, nowMs } = params;

  return {
    relationshipId: relationshipId || `${triggerProductId}:${suggestedProductId}`,
    triggerProductId,
    suggestedProductId,
    relationshipType,
    createdAt: nowMs,
    source: 'product_relationship_intelligence',
    cautious: true, // Flag for downstream systems
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  MESSAGE_TEMPLATES,
  FORBIDDEN_PHRASES,
  validateMessage,
  generateCautiousMessage,
  createMessageContext,
};
