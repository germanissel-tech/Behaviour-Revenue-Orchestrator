/**
 * user-profile-simulator.js
 *
 * Realistic user behavior simulation for OPE system testing.
 * Simulates different user archetypes with distinct behavioral patterns.
 *
 * User Profiles:
 * - Impulsive buyer
 * - Analytical buyer
 * - Indecisive browser
 * - Comparison shopper
 * - Premium customer
 * - Distracted browser
 * - High-intent converter
 *
 * Each simulation measures:
 * - Intervention timing and appropriateness
 * - Fatigue accumulation
 * - Message repetition
 * - Stage transitions
 * - Ranking correctness
 * - Contextual coherence
 * - Return risk handling
 * - Invasiveness score
 *
 * Architecture:
 * - Deterministic event generation
 * - Reproducible test runs
 * - Comprehensive metrics
 */

'use strict';

const BehavioralIntelligence = require('./behavioral-intelligence-layer');
const FunnelEngine = require('./funnel-stage-engine');
const CartIntelligence = require('./cart-intelligence-engine');
const MessageLifecycle = require('./message-lifecycle-controller');
const ContextualRanker = require('./contextual-message-ranker');

// ----------------------------------------------------------------------
// User Profiles
// ----------------------------------------------------------------------

const USER_PROFILES = Object.freeze({
  IMPULSIVE: {
    id: 'impulsive',
    name: 'Comprador Impulsivo',
    description: 'Toma decisiones rapidas, poco tiempo en detalles, alto riesgo de devolucion',
    
    // Behavioral parameters
    behavior: {
      avgDwellMs: 2000,
      dwellVariance: 1000,
      scrollSpeed: 'fast',
      modalProbability: 0.3,
      modalDwellMs: 3000,
      variantChangeProbability: 0.2,
      cartAddSpeed: 'immediate',
      cartRemoveProbability: 0.1,
      readDetailsProbability: 0.2,
      revisitProbability: 0.1,
    },
    
    // Expected outcomes
    expectedOutcomes: {
      returnRiskLevel: 'high',
      urgencySuppressed: true,
      prioritizedFamilies: ['compatibility', 'quality', 'reassurance'],
    },
  },
  
  ANALYTICAL: {
    id: 'analytical',
    name: 'Comprador Analitico',
    description: 'Lee todos los detalles, compara variantes, toma tiempo para decidir',
    
    behavior: {
      avgDwellMs: 12000,
      dwellVariance: 5000,
      scrollSpeed: 'slow',
      modalProbability: 0.9,
      modalDwellMs: 20000,
      variantChangeProbability: 0.7,
      cartAddSpeed: 'delayed',
      cartRemoveProbability: 0.05,
      readDetailsProbability: 0.95,
      revisitProbability: 0.4,
    },
    
    expectedOutcomes: {
      returnRiskLevel: 'low',
      urgencySuppressed: false,
      prioritizedFamilies: ['expertise', 'comparison', 'quality'],
    },
  },
  
  INDECISIVE: {
    id: 'indecisive',
    name: 'Navegante Indeciso',
    description: 'Mucha duda, abre y cierra modales, agrega y quita del carrito',
    
    behavior: {
      avgDwellMs: 8000,
      dwellVariance: 4000,
      scrollSpeed: 'oscillating',
      modalProbability: 0.8,
      modalDwellMs: 15000,
      modalReopenProbability: 0.6,
      variantChangeProbability: 0.8,
      cartAddSpeed: 'hesitant',
      cartRemoveProbability: 0.5,
      readDetailsProbability: 0.7,
      revisitProbability: 0.7,
    },
    
    expectedOutcomes: {
      returnRiskLevel: 'medium',
      hesitationDetected: true,
      urgencySuppressed: true,
      prioritizedFamilies: ['reassurance', 'compatibility', 'social'],
    },
  },
  
  COMPARISON_SHOPPER: {
    id: 'comparison',
    name: 'Comparador',
    description: 'Ve muchos productos similares, compara precios y caracteristicas',
    
    behavior: {
      avgDwellMs: 6000,
      dwellVariance: 3000,
      scrollSpeed: 'medium',
      modalProbability: 0.7,
      modalDwellMs: 8000,
      variantChangeProbability: 0.5,
      productsPerSession: 8,
      sameCategoryProbability: 0.8,
      cartAddSpeed: 'delayed',
      cartRemoveProbability: 0.3,
      readDetailsProbability: 0.6,
      revisitProbability: 0.5,
    },
    
    expectedOutcomes: {
      comparisonDetected: true,
      returnRiskLevel: 'low',
      prioritizedFamilies: ['comparison', 'benefit', 'expertise'],
    },
  },
  
  PREMIUM: {
    id: 'premium',
    name: 'Cliente Premium',
    description: 'Compra productos de alto valor, espera calidad y servicio',
    
    behavior: {
      avgDwellMs: 10000,
      dwellVariance: 4000,
      scrollSpeed: 'slow',
      modalProbability: 0.85,
      modalDwellMs: 15000,
      variantChangeProbability: 0.4,
      preferHighValue: true,
      cartAddSpeed: 'moderate',
      cartRemoveProbability: 0.1,
      readDetailsProbability: 0.9,
      revisitProbability: 0.3,
    },
    
    expectedOutcomes: {
      returnRiskLevel: 'low',
      cartType: 'premium',
      prioritizedFamilies: ['reassurance', 'quality', 'social'],
    },
  },
  
  DISTRACTED: {
    id: 'distracted',
    name: 'Navegante Distraido',
    description: 'Atencion corta, scroll rapido, abandona facilmente',
    
    behavior: {
      avgDwellMs: 1500,
      dwellVariance: 1000,
      scrollSpeed: 'very_fast',
      modalProbability: 0.2,
      modalDwellMs: 2000,
      variantChangeProbability: 0.1,
      cartAddSpeed: 'rare',
      cartRemoveProbability: 0.0,
      readDetailsProbability: 0.1,
      revisitProbability: 0.05,
      abandonProbability: 0.7,
    },
    
    expectedOutcomes: {
      funnelStage: 'discovery',
      interventionCount: 'low',
      returnRiskLevel: 'low', // Never gets to cart
    },
  },
  
  HIGH_INTENT: {
    id: 'high_intent',
    name: 'Alta Intencion',
    description: 'Sabe lo que quiere, va directo al producto, convierte rapido',
    
    behavior: {
      avgDwellMs: 5000,
      dwellVariance: 2000,
      scrollSpeed: 'focused',
      modalProbability: 0.95,
      modalDwellMs: 10000,
      variantChangeProbability: 0.2,
      cartAddSpeed: 'confident',
      cartRemoveProbability: 0.02,
      readDetailsProbability: 0.7,
      revisitProbability: 0.1,
      checkoutProbability: 0.9,
    },
    
    expectedOutcomes: {
      funnelStage: 'checkout_ready',
      returnRiskLevel: 'low',
      cartType: 'decisive',
      prioritizedFamilies: ['social', 'benefit', 'lifestyle'],
    },
  },
});

// ----------------------------------------------------------------------
// Event Generation
// ----------------------------------------------------------------------

/**
 * Generate a sequence of events for a user profile.
 * @param {object} profile - User profile
 * @param {object} options - {productCatalog, sessionDurationMs, seed}
 * @returns {Array} Event sequence
 */
function generateEventSequence(profile, options = {}) {
  const {
    productCatalog = generateMockCatalog(),
    sessionDurationMs = 180000, // 3 minutes
    // P1-DET FIX (L2): Default seed was Date.now() — non-reproducible, making
    // simulation runs flaky in tests. Default is now a fixed seed (42) so runs
    // are reproducible unless the caller explicitly varies the seed.
    // Callers that want unique runs should pass: seed: Date.now()
    seed = 42,
  } = options;
  
  // Simple seeded random
  let rngState = seed;
  const random = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };
  
  const events = [];
  const behavior = profile.behavior;
  
  let currentTime = 0;
  let currentContext = 'listing';
  let currentProductId = null;
  const viewedProducts = new Set();
  const cartItems = [];
  
  // Start session
  events.push({
    type: 'session_start',
    timestamp: currentTime,
    context: 'listing',
    productId: null,
    metadata: { profileId: profile.id },
  });
  
  while (currentTime < sessionDurationMs) {
    // Decide next action based on profile
    if (currentContext === 'listing') {
      // Browse products
      const product = selectProduct(productCatalog, behavior, viewedProducts, random);
      currentProductId = product.id;
      viewedProducts.add(product.id);
      
      // Product view
      events.push({
        type: 'product_view',
        timestamp: currentTime,
        context: 'listing',
        productId: product.id,
        metadata: { category: product.category, price: product.price },
      });
      
      // Dwell on product
      const dwellTime = behavior.avgDwellMs + (random() - 0.5) * behavior.dwellVariance;
      currentTime += dwellTime;
      
      events.push({
        type: 'dwell_tick',
        timestamp: currentTime,
        context: 'listing',
        productId: product.id,
        metadata: { deltaMs: dwellTime },
      });
      
      // Maybe open modal
      if (random() < behavior.modalProbability) {
        events.push({
          type: 'modal_open',
          timestamp: currentTime,
          context: 'modal',
          productId: product.id,
          metadata: {},
        });
        currentContext = 'modal';
      } else {
        currentTime += 500; // Brief pause before next product
      }
      
    } else if (currentContext === 'modal') {
      // Modal interactions
      const modalDwell = behavior.modalDwellMs + (random() - 0.5) * 5000;
      
      // Variant changes
      const variantChanges = random() < behavior.variantChangeProbability ? 
        Math.floor(random() * 4) + 1 : 0;
      
      for (let i = 0; i < variantChanges; i++) {
        currentTime += modalDwell / (variantChanges + 1);
        events.push({
          type: 'variant_change',
          timestamp: currentTime,
          context: 'modal',
          productId: currentProductId,
          metadata: { variantId: `v${i}` },
        });
      }
      
      currentTime += modalDwell;
      
      events.push({
        type: 'dwell_tick',
        timestamp: currentTime,
        context: 'modal',
        productId: currentProductId,
        metadata: { deltaMs: modalDwell },
      });
      
      // CTA hovers
      if (random() < 0.6) {
        events.push({
          type: 'cta_hover',
          timestamp: currentTime,
          context: 'modal',
          productId: currentProductId,
          metadata: {},
        });
      }
      
      // Maybe add to cart
      const addToCartProb = getCartAddProbability(behavior, currentTime);
      if (random() < addToCartProb) {
        events.push({
          type: 'cart_add',
          timestamp: currentTime,
          context: 'modal',
          productId: currentProductId,
          metadata: {
            variantId: 'v0',
            category: productCatalog.find(p => p.id === currentProductId)?.category,
            price: productCatalog.find(p => p.id === currentProductId)?.price || 50,
            dwellBeforeAdd: modalDwell,
          },
        });
        cartItems.push(currentProductId);
      }
      
      // Modal reopen?
      if (behavior.modalReopenProbability && random() < behavior.modalReopenProbability) {
        events.push({
          type: 'modal_close',
          timestamp: currentTime,
          context: 'listing',
          productId: currentProductId,
          metadata: {},
        });
        
        currentTime += 2000;
        
        events.push({
          type: 'modal_open',
          timestamp: currentTime,
          context: 'modal',
          productId: currentProductId,
          metadata: { reopen: true },
        });
        
        // Continue modal session...
        currentTime += behavior.modalDwellMs / 2;
      }
      
      // Close modal
      events.push({
        type: 'modal_close',
        timestamp: currentTime,
        context: 'listing',
        productId: currentProductId,
        metadata: {},
      });
      currentContext = 'listing';
      currentTime += 300;
      
      // Maybe revisit?
      if (random() < behavior.revisitProbability) {
        // Will revisit this product later
      }
      
    } else if (currentContext === 'cart') {
      // Cart interactions
      events.push({
        type: 'cart_dwell',
        timestamp: currentTime,
        context: 'cart',
        productId: null,
        metadata: { deltaMs: 5000 },
      });
      
      currentTime += 5000;
      
      // Maybe remove item
      if (cartItems.length > 0 && random() < behavior.cartRemoveProbability) {
        const removeIdx = Math.floor(random() * cartItems.length);
        const removedProduct = cartItems.splice(removeIdx, 1)[0];
        
        events.push({
          type: 'cart_remove',
          timestamp: currentTime,
          context: 'cart',
          productId: removedProduct,
          metadata: {},
        });
      }
      
      // Checkout hover
      if (behavior.checkoutProbability && random() < behavior.checkoutProbability) {
        events.push({
          type: 'checkout_hover',
          timestamp: currentTime,
          context: 'cart',
          productId: null,
          metadata: {},
        });
      }
      
      currentContext = 'listing';
    }
    
    // Maybe go to cart
    if (cartItems.length > 0 && currentContext === 'listing' && random() < 0.3) {
      currentContext = 'cart';
      events.push({
        type: 'context_transition',
        timestamp: currentTime,
        context: 'cart',
        productId: null,
        metadata: { from: 'listing' },
      });
    }
    
    // Abandon check
    if (behavior.abandonProbability && random() < behavior.abandonProbability / 10) {
      break;
    }
    
    currentTime += 500;
  }
  
  // End session
  events.push({
    type: 'session_end',
    timestamp: currentTime,
    context: currentContext,
    productId: currentProductId,
    metadata: { 
      cartItems: cartItems.length,
      productsViewed: viewedProducts.size,
    },
  });
  
  return events;
}

function selectProduct(catalog, behavior, viewedProducts, random) {
  // Filter based on behavior preferences
  let candidates = catalog;
  
  if (behavior.preferHighValue) {
    candidates = catalog.filter(p => p.price >= 100);
  }
  
  if (behavior.sameCategoryProbability && viewedProducts.size > 0 && random() < behavior.sameCategoryProbability) {
    // Pick same category as last viewed
    const lastViewed = Array.from(viewedProducts).pop();
    const lastProduct = catalog.find(p => p.id === lastViewed);
    if (lastProduct) {
      const sameCategory = catalog.filter(p => p.category === lastProduct.category);
      if (sameCategory.length > 1) {
        candidates = sameCategory;
      }
    }
  }
  
  // Pick random from candidates
  return candidates[Math.floor(random() * candidates.length)];
}

function getCartAddProbability(behavior, currentTime) {
  switch (behavior.cartAddSpeed) {
    case 'immediate': return 0.8;
    case 'confident': return 0.7;
    case 'moderate': return 0.5;
    case 'delayed': return 0.3;
    case 'hesitant': return 0.4;
    case 'rare': return 0.1;
    default: return 0.3;
  }
}

function generateMockCatalog() {
  return [
    { id: 'prod-1', category: 'audio', price: 299, name: 'Aurora Pro' },
    { id: 'prod-2', category: 'audio', price: 149, name: 'Zenith Buds' },
    { id: 'prod-3', category: 'audio', price: 199, name: 'Eclipse Speaker' },
    { id: 'prod-4', category: 'lighting', price: 129, name: 'Meridian Lamp' },
    { id: 'prod-5', category: 'lighting', price: 79, name: 'Lumina Strip' },
    { id: 'prod-6', category: 'accessories', price: 59, name: 'Prism Charger' },
    { id: 'prod-7', category: 'desk', price: 89, name: 'Carbon Stand' },
    { id: 'prod-8', category: 'fragrance', price: 69, name: 'Nova Diffuser' },
  ];
}

// ----------------------------------------------------------------------
// Simulation Runner
// ----------------------------------------------------------------------

/**
 * Run a full simulation for a user profile.
 * @param {string} profileId - Profile ID from USER_PROFILES
 * @param {object} options
 * @returns {object} Simulation results
 */
function runSimulation(profileId, options = {}) {
  const profile = USER_PROFILES[profileId.toUpperCase()] || USER_PROFILES.ANALYTICAL;
  
  const sessionId = `sim_${profile.id}_${Date.now()}`;
  const events = generateEventSequence(profile, options);
  
  const results = {
    profile: profile.id,
    profileName: profile.name,
    sessionId,
    eventCount: events.length,
    
    // Metrics
    metrics: {
      interventions: [],
      stageTransitions: [],
      fatigueProgression: [],
      returnRiskEvents: [],
      messageRepetitions: [],
    },
    
    // Final state
    finalState: {
      funnelStage: null,
      returnRiskLevel: null,
      hesitationDetected: false,
      comparisonDetected: false,
      cartType: null,
      totalInterventions: 0,
      familiesUsed: new Set(),
    },
    
    // Validation
    validation: {
      passed: [],
      failed: [],
      warnings: [],
    },
  };
  
  // Process each event
  let lastIntentState = 'exploring';
  
  for (const event of events) {
    const nowMs = event.timestamp;
    
    // Record event in behavioral intelligence
    BehavioralIntelligence.recordEvent(sessionId, event, nowMs);
    
    // Process in funnel engine
    const funnelResult = FunnelEngine.processEvent(sessionId, event, nowMs);
    if (funnelResult.transitioned) {
      results.metrics.stageTransitions.push({
        timestamp: nowMs,
        from: funnelResult.previousStage,
        to: funnelResult.currentStage,
        reason: funnelResult.reason,
      });
    }
    
    // Process cart events
    if (event.type.startsWith('cart_')) {
      CartIntelligence.processCartEvent(sessionId, event, nowMs);
    }
    
    // Update context in lifecycle controller
    MessageLifecycle.updateContext(sessionId, {
      context: event.context,
      productId: event.productId,
    }, nowMs);
    
    // Analyze patterns
    const patterns = BehavioralIntelligence.analyzePatterns(sessionId, event.productId, nowMs);
    
    // Track return risk events
    if (patterns.returnRisk?.detected) {
      results.metrics.returnRiskEvents.push({
        timestamp: nowMs,
        level: patterns.returnRisk.level,
        signals: patterns.returnRisk.signals,
      });
    }
    
    // Check message timing
    MessageLifecycle.checkTimeouts(sessionId, nowMs);
    
    // Update final state
    results.finalState.funnelStage = FunnelEngine.getCurrentStage(sessionId);
    results.finalState.returnRiskLevel = patterns.returnRisk?.level;
    results.finalState.hesitationDetected = patterns.hesitation?.detected || results.finalState.hesitationDetected;
    results.finalState.comparisonDetected = patterns.comparison?.detected || results.finalState.comparisonDetected;
  }
  
  // Get cart analytics
  const cartAnalytics = CartIntelligence.getCartAnalytics(sessionId, events[events.length - 1]?.timestamp || 0);
  results.finalState.cartType = cartAnalytics.cartType;
  
  // Validate against expected outcomes
  _validateSimulation(results, profile);
  
  return results;
}

function _validateSimulation(results, profile) {
  const expected = profile.expectedOutcomes;
  const actual = results.finalState;
  
  // Check return risk level
  if (expected.returnRiskLevel) {
    if (actual.returnRiskLevel === expected.returnRiskLevel) {
      results.validation.passed.push(`Return risk level correct: ${expected.returnRiskLevel}`);
    } else {
      results.validation.failed.push(`Return risk level mismatch: expected ${expected.returnRiskLevel}, got ${actual.returnRiskLevel}`);
    }
  }
  
  // Check hesitation detection
  if (expected.hesitationDetected !== undefined) {
    if (actual.hesitationDetected === expected.hesitationDetected) {
      results.validation.passed.push(`Hesitation detection correct: ${expected.hesitationDetected}`);
    } else {
      results.validation.failed.push(`Hesitation detection mismatch: expected ${expected.hesitationDetected}, got ${actual.hesitationDetected}`);
    }
  }
  
  // Check comparison detection
  if (expected.comparisonDetected !== undefined) {
    if (actual.comparisonDetected === expected.comparisonDetected) {
      results.validation.passed.push(`Comparison detection correct: ${expected.comparisonDetected}`);
    } else {
      results.validation.failed.push(`Comparison detection mismatch: expected ${expected.comparisonDetected}, got ${actual.comparisonDetected}`);
    }
  }
  
  // Check cart type
  if (expected.cartType && actual.cartType) {
    if (actual.cartType === expected.cartType) {
      results.validation.passed.push(`Cart type correct: ${expected.cartType}`);
    } else {
      results.validation.warnings.push(`Cart type different: expected ${expected.cartType}, got ${actual.cartType}`);
    }
  }
  
  // Check funnel stage
  if (expected.funnelStage) {
    if (actual.funnelStage === expected.funnelStage) {
      results.validation.passed.push(`Funnel stage correct: ${expected.funnelStage}`);
    } else {
      results.validation.warnings.push(`Funnel stage different: expected ${expected.funnelStage}, got ${actual.funnelStage}`);
    }
  }
}

/**
 * Run simulations for all profiles.
 * @param {object} options
 * @returns {object} Combined results
 */
function runAllSimulations(options = {}) {
  const results = {
    timestamp: Date.now(),
    profiles: {},
    summary: {
      totalProfiles: 0,
      passedValidations: 0,
      failedValidations: 0,
      warnings: 0,
    },
  };
  
  for (const [key, profile] of Object.entries(USER_PROFILES)) {
    const profileResult = runSimulation(key, options);
    results.profiles[key] = profileResult;
    
    results.summary.totalProfiles++;
    results.summary.passedValidations += profileResult.validation.passed.length;
    results.summary.failedValidations += profileResult.validation.failed.length;
    results.summary.warnings += profileResult.validation.warnings.length;
  }
  
  return results;
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

module.exports = {
  // Constants
  USER_PROFILES,
  
  // Event generation
  generateEventSequence,
  generateMockCatalog,
  
  // Simulation
  runSimulation,
  runAllSimulations,
};
