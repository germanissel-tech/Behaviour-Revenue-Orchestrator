/**
 * OPE — Behavioral Intelligence Engine (v3 enterprise restructure)
 *
 * Central export point with EXPLICIT authority hierarchy.
 *
 * ====================================================================
 * AUTHORITY MAP — Who decides, who reads, who renders, who persists
 * ====================================================================
 *
 * SINGLE ORCHESTRATION AUTHORITY
 * └── session-orchestrator.js        DECIDES everything. Single pipeline.
 *
 * AUTHORITATIVE OWNERS (each owns its domain exclusively)
 * ├── unified-intent-engine          → Intent state (sole authority)
 * ├── cooldown-fatigue-engine        → Fatigue & cooldowns (sole authority)
 * ├── intervention-policy-engine     → Policy rules (sole authority)
 * ├── message-ranking-engine         → Message selection (sole authority)
 * ├── message-visibility-controller  → DOM rendering (sole authority)
 * ├── intervention-lifecycle-manager → Intervention FSM (sole authority)
 * ├── funnel-stage-engine            → Funnel tracking (sole authority)
 * ├── signal-derivation-engine       → Signal computation (sole authority)
 * └── behavioral-state-store         → Central state (sole authority)
 *
 * PRODUCT RELATIONSHIP INTELLIGENCE (v3 — cautious intervention signals)
 * ├── product-relationship-types          → Relationship taxonomy and validation
 * ├── completion-confidence-engine        → Confidence computation (>0.85 threshold)
 * ├── negative-preference-memory          → Dismissal/skip tracking (90-day TTL)
 * ├── cautious-message-templates          → Non-aggressive message generation
 * └── product-relationship-intervention   → Main intervention signal engine
 *
 * READ-ONLY ANALYTICS FACADES (observe, do NOT decide)
 * ├── ope-intelligence-hub           → Aggregated analytics (read-only)
 * ├── behavioral-intelligence-layer  → Pattern analysis (read-only)
 * ├── cart-intelligence-engine       → Cart analytics (read-only)
 * ├── contextual-message-ranker      → Legacy ranker (read-only facade)
 * └── message-lifecycle-controller   → Lifecycle tracking (read-only)
 *
 * DEPRECATED COMPATIBILITY LAYERS (delegate to session-orchestrator)
 * ├── real-time-orchestrator         → DEPRECATED facade → session-orchestrator
 * ├── interaction-transition-layer   → DEPRECATED → unified-intent-engine
 * └── fatigue-engine                 → DEPRECATED shim → cooldown-fatigue-engine
 *
 * INFRASTRUCTURE
 * ├── internal-behavioral-event-bus  → Decoupled event communication
 * ├── context-presence-engine        → Real attention detection
 * ├── session-state-store            → Session persistence layer
 * ├── ope-constants                  → Shared taxonomies & enums
 * └── human-message-engine           → Natural message progression
 *
 * SIGNAL GATEWAY (browser-side)
 * └── logger-v2                      → DOM signal capture & backend transport
 *
 * TESTING
 * ├── session-simulator-runner       → Deterministic session simulation
 * └── user-profile-simulator         → User profile generation
 *
 * ====================================================================
 * PRODUCT RELATIONSHIP INTELLIGENCE — Cautious Incomplete Purchase Detection
 * ====================================================================
 *
 * This subsystem provides SIGNALS for potentially incomplete purchases.
 * It is NOT a cross-sell/upsell engine.
 *
 * Key constraints:
 *   - Only FOOD/GROCERY/DELIVERY categories
 *   - Only REQUIRED_COMPONENT and PREPARATION_COMPONENT relationships
 *   - Confidence threshold > 0.85
 *   - Max 1 intervention per relationship type per session
 *   - 90-day negative preference TTL
 *   - Cautious, non-aggressive messaging
 *
 * ====================================================================
 * FLOW: Event → Decision → Rendering → Persistence
 * ====================================================================
 *
 *   [Browser DOM] → logger-v2 (capture)
 *        │
 *        ▼
 *   session-orchestrator.processEvent(event, nowMs)
 *        │
 *        ├─ signal-derivation-engine.ingestEvent()
 *        ├─ unified-intent-engine.update()
 *        ├─ funnel-stage-engine.processEvent()
 *        ├─ behavioral-state-store.update()
 *        └─ internal-behavioral-event-bus.emit()
 *        │
 *        ▼
 *   session-orchestrator.evaluate(nowMs)
 *        │
 *        ├─ cooldown-fatigue-engine.canIntervene()
 *        ├─ intervention-policy-engine.evaluate()
 *        ├─ message-ranking-engine.rankInterventions()
 *        ├─ product-relationship-intervention-engine.evaluate() ← NEW
 *        └─ intervention-lifecycle-manager.startIntervention()
 *        │
 *        ▼
 *   message-visibility-controller.evaluate()  → DOM rendering
 *        │
 *        ▼
 *   session-state-store / behavioral-state-store → Persistence
 *
 * ====================================================================
 * DETERMINISM GUARANTEES (v3 enterprise)
 * ====================================================================
 *
 * - NO Date.now() in any hot path. All timing via explicit nowMs params.
 * - NO Math.random() in decision paths. Seeded RNG when needed.
 * - NO implicit timers in decision logic. Injectable clock/scheduler.
 * - Full snapshot()/restore() for deterministic replay.
 * - Bounded memory: all stores use LRU eviction with configurable caps.
 * - Idempotent event processing via eventId deduplication.
 */

'use strict';

// ── AUTHORITATIVE ENGINES (each owns its domain) ──────────────────

const SessionOrchestrator = require('./session-orchestrator');
const BehavioralStateStore = require('./behavioral-state-store');
const UnifiedIntentEngine = require('./unified-intent-engine');
const CooldownFatigueEngine = require('./cooldown-fatigue-engine');
const InterventionPolicyEngine = require('./intervention-policy-engine');
const MessageRankingEngine = require('./message-ranking-engine');
const MessageVisibilityController = require('./message-visibility-controller');
const InterventionLifecycleManager = require('./intervention-lifecycle-manager');
const FunnelStageEngine = require('./funnel-stage-engine');
const SignalDerivationEngine = require('./signal-derivation-engine');
const HumanMessageEngine = require('./human-message-engine');

// ── PRODUCT RELATIONSHIP INTELLIGENCE (v3) ────────────────────────

const ProductRelationshipTypes = require('./product-relationship-types');
const CompletionConfidenceEngine = require('./completion-confidence-engine');
const NegativePreferenceMemory = require('./negative-preference-memory');
const CautiousMessageTemplates = require('./cautious-message-templates');
const ProductRelationshipInterventionEngine = require('./product-relationship-intervention-engine');

// ── PRODUCT RELATIONSHIP INTELLIGENCE HARDENING (v3.1) ────────────

const ProductOntologyNormalizer = require('./product-ontology-normalizer');
const HistoricalPurchaseMemory = require('./historical-purchase-memory');
const AdaptiveConfidenceThresholds = require('./adaptive-confidence-thresholds');
const MemorySafetyAudit = require('./memory-safety-audit');
const BidirectionalDependencyValidator = require('./bidirectional-dependency-validator');

// ── INFRASTRUCTURE ────────────────────────────────────────────────

const InternalBehavioralEventBus = require('./internal-behavioral-event-bus');
const ContextPresenceEngine = require('./context-presence-engine');
const SessionStateStore = require('./session-state-store');
const OPEConstants = require('./ope-constants');

// ── READ-ONLY ANALYTICS FACADES ──────────────────────────────────

const OPEIntelligenceHub = require('./ope-intelligence-hub');
const BehavioralIntelligenceLayer = require('./behavioral-intelligence-layer');
const CartIntelligenceEngine = require('./cart-intelligence-engine');
const ContextualMessageRanker = require('./contextual-message-ranker');
const MessageLifecycleController = require('./message-lifecycle-controller');

// ── DEPRECATED COMPATIBILITY LAYERS ──────────────────────────────

const RealTimeOrchestrator = require('./real-time-orchestrator');
const InteractionTransitionLayer = require('./interaction-transition-layer');
const FatigueEngine = require('./fatigue-engine');

// ── TESTING ──────────────────────────────────────────────────────

const SessionSimulatorRunner = require('./session-simulator-runner');
const UserProfileSimulator = require('./user-profile-simulator');

// Observability layer — Runtime Hardening phase
const { DecisionExplainabilityEngine, DECISION_OUTCOMES, GATES } = require('./decision-explainability-engine');
const { InterventionOutcomeTracker, OUTCOME_TYPES } = require('./intervention-outcome-tracker');
const { InterventionLearningStore, BUCKET_DIMENSIONS } = require('./intervention-learning-store');

// ── SYSTEM METADATA ──────────────────────────────────────────────

const SYSTEM = Object.freeze({
  name: 'OPE',
  fullName: 'Behavioral Intelligence Engine',
  version: '3.2.0-product-relationship-intelligence-hardened',

  guarantees: Object.freeze([
    'deterministic',              // No Date.now()/Math.random() in hot paths
    'replay-safe',                // Full snapshot/restore
    'race-safe',                  // Serial event processing with locks
    'bounded-memory',             // LRU eviction on all stores
    'bounded-recursion',          // No indirect event loops
    'no-hidden-side-effects',     // Explicit dependencies only
    'unified-intent-taxonomy',    // P0-1 fix
    'per-tenant-state-isolation', // P0-2 fix
    'single-ranking-authority',   // P0-3 fix (MRE only)
    'single-orchestration',       // P0-3 fix (SO only)
    'natural-message-progression',// human-message-engine
    'full-state-serialization',   // P3-SNAP: snapshot/restore all sub-engines
    'funnel-hysteresis',          // P2-STAB: oscillation prevention
    'decision-explainability',    // Every decision has an auditable record
    'outcome-attribution',        // Every intervention is linked to behavioral outcomes
    'learning-infrastructure',    // Bounded deterministic accumulation of what works
    'cautious-relationship-interventions', // Product relationship: trust > conversions
    // NEW v3.2.0 guarantees
    'ontology-normalization-hardened',     // Phase 1: Multilingual aliases, confidence scoring
    'historical-purchase-memory',          // Phase 2: 90-day TTL, affinity tracking
    'adaptive-confidence-thresholds',      // Phase 3: Dynamic category/relationship thresholds
    'return-risk-integration',             // Phase 4: Risk-adjusted interventions
    'memory-safety-audited',               // Phase 5: LRU limits, TTL, cleanup validated
    'bidirectional-dependency-validated',  // Phase 6: Old<->New module compatibility
  ]),

  authorities: Object.freeze({
    orchestration: 'session-orchestrator',
    intent: 'unified-intent-engine',
    fatigue: 'cooldown-fatigue-engine',
    policy: 'intervention-policy-engine',
    ranking: 'message-ranking-engine',
    rendering: 'message-visibility-controller',
    lifecycle: 'intervention-lifecycle-manager',
    funnel: 'funnel-stage-engine',
    signals: 'signal-derivation-engine',
    state: 'behavioral-state-store',
    explanation: 'decision-explainability-engine',
    outcome_tracking: 'intervention-outcome-tracker',
    learning: 'intervention-learning-store',
    product_relationship: 'product-relationship-intervention-engine',
    // NEW v3.2.0 authorities
    ontology_normalization: 'product-ontology-normalizer',
    historical_memory: 'historical-purchase-memory',
    adaptive_thresholds: 'adaptive-confidence-thresholds',
    memory_safety: 'memory-safety-audit',
    dependency_validation: 'bidirectional-dependency-validator',
  }),
});

// ── EXPORTS ──────────────────────────────────────────────────────

module.exports = {
  // System metadata
  SYSTEM,

  // Authoritative engines
  SessionOrchestrator,
  BehavioralStateStore,
  UnifiedIntentEngine,
  CooldownFatigueEngine,
  InterventionPolicyEngine,
  MessageRankingEngine,
  MessageVisibilityController,
  InterventionLifecycleManager,
  FunnelStageEngine,
  SignalDerivationEngine,
  HumanMessageEngine,

  // Product Relationship Intelligence (v3)
  ProductRelationshipTypes,
  CompletionConfidenceEngine,
  NegativePreferenceMemory,
  CautiousMessageTemplates,
  ProductRelationshipInterventionEngine,

  // Product Relationship Intelligence Hardening (v3.2)
  ProductOntologyNormalizer,
  HistoricalPurchaseMemory,
  AdaptiveConfidenceThresholds,
  MemorySafetyAudit,
  BidirectionalDependencyValidator,

  // Infrastructure
  InternalBehavioralEventBus,
  ContextPresenceEngine,
  SessionStateStore,
  OPEConstants,

  // Read-only analytics facades
  OPEIntelligenceHub,
  BehavioralIntelligenceLayer,
  CartIntelligenceEngine,
  ContextualMessageRanker,
  MessageLifecycleController,

  // Deprecated compatibility layers
  RealTimeOrchestrator,
  InteractionTransitionLayer,
  FatigueEngine,

  // Testing
  SessionSimulatorRunner,

  // Observability — Runtime Hardening
  DecisionExplainabilityEngine,
  InterventionOutcomeTracker,
  InterventionLearningStore,
  DECISION_OUTCOMES,
  OUTCOME_TYPES,
  GATES,
  BUCKET_DIMENSIONS,
  UserProfileSimulator,
};
