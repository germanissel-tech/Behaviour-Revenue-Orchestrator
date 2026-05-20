# OPE Architecture (v3 Enterprise Restructure)

## Authority Map

Every module has exactly ONE role. No module shares authority with another.

### Single Orchestration Authority

| Module | Role | Authority |
|---|---|---|
| `session-orchestrator.js` | Full session lifecycle coordination | SOLE decision authority. All event processing, evaluation, and intervention decisions flow through here. |

### Authoritative Owners

Each module owns its domain exclusively. No other module may duplicate its logic.

| Module | Domain | Owns |
|---|---|---|
| `unified-intent-engine.js` | Intent inference | Intent state, confidence, transitions, oscillation detection |
| `cooldown-fatigue-engine.js` | Fatigue & timing | Fatigue score, cooldown windows, pacing, suppression |
| `intervention-policy-engine.js` | Policy rules | When/why/what to intervene, intervention windows |
| `message-ranking-engine.js` | Message selection | Scoring, ranking, exploration, candidate selection |
| `message-visibility-controller.js` | DOM rendering | Show/hide messages, visual lifecycle, autohide |
| `intervention-lifecycle-manager.js` | Intervention FSM | State machine: pending -> active -> completed/dismissed |
| `funnel-stage-engine.js` | Funnel tracking | Stage progression, hysteresis, oscillation prevention |
| `signal-derivation-engine.js` | Signal computation | Raw events -> behavioral signals, decay, momentum |
| `behavioral-state-store.js` | Central state | Products, context, locks, session memory |

### Read-Only Analytics Facades

These modules OBSERVE but do NOT decide. They aggregate analytics data for dashboards and diagnostics.

| Module | Role | Reads From |
|---|---|---|
| `ope-intelligence-hub.js` | Aggregated analytics | All authoritative modules |
| `behavioral-intelligence-layer.js` | Pattern analysis | Product/modal/cart/scroll history |
| `cart-intelligence-engine.js` | Cart analytics | Cart events, item state |
| `contextual-message-ranker.js` | Legacy ranker facade | Context data (does NOT rank in production) |
| `message-lifecycle-controller.js` | Lifecycle tracking | Message registration, expiry |

### Deprecated Compatibility Layers

These modules exist ONLY for backward compatibility. They delegate to their authoritative replacement.

| Module | Delegates To | Status |
|---|---|---|
| `real-time-orchestrator.js` | `session-orchestrator.js` | DEPRECATED. Facade that translates old API shape. |
| `interaction-transition-layer.js` | `unified-intent-engine.js` | DEPRECATED. Thin wrapper for legacy callers. |
| `fatigue-engine.js` | `cooldown-fatigue-engine.js` | DEPRECATED. Shim that creates temp CooldownFatigueEngine instances. |

---

## Event Flow

```
[Browser DOM]
    |
    v
logger-v2.js (capture signals, transport to backend)
    |  Uses injectable clock (_now), NO Date.now() in hot path.
    |  Forwards decisions to message-visibility-controller.
    |
    v
session-orchestrator.processEvent(event, nowMs)
    |
    +-- signal-derivation-engine.ingestEvent(event, nowMs)
    +-- unified-intent-engine.update(signals, nowMs)
    +-- funnel-stage-engine.processEvent(sessionId, event, nowMs)
    +-- behavioral-state-store.update(event, nowMs)
    +-- internal-behavioral-event-bus.emit(event.type, payload, nowMs)
    |
    v
session-orchestrator.evaluate(nowMs)
    |
    +-- cooldown-fatigue-engine.canIntervene(nowMs)
    |       If NO -> BLOCKED (emit INTERVENTION_BLOCKED)
    |
    +-- intervention-policy-engine.evaluateInterventionPolicy({..., now: nowMs})
    |       If shouldSuppress -> DENIED (emit INTERVENTION_DENIED)
    |
    +-- message-ranking-engine.rankInterventions({..., now: nowMs})
    |       Scores and selects best candidate message.
    |
    +-- intervention-lifecycle-manager.startIntervention(intervention, nowMs)
    |       Transitions FSM: idle -> pending -> active.
    |
    v
message-visibility-controller.evaluate({decision, context, now: nowMs})
    |  SOLE authority over DOM rendering.
    |  Shows/hides/autohides messages.
    |
    v
behavioral-state-store / session-state-store -> Persistence
```

## Ranking Flow

```
session-orchestrator.evaluate(nowMs)
    |
    v
message-ranking-engine.rankInterventions({
    candidates,           // from candidateProvider
    sessionState,         // from behavioral-state-store (read-only)
    fatigueState,         // from cooldown-fatigue-engine (read-only)
    signals,              // from signal-derivation-engine (read-only)
    exposureHistory,      // from exposureHistoryProvider
    policyDecision,       // from intervention-policy-engine (read-only)
    now: nowMs
})
    |
    +-- Cross-module suppression (cooldown enforcement)
    +-- Policy gate (intervention window)
    +-- Score each candidate (relevance, freshness, fatigue-adjusted)
    +-- Apply exploration (epsilon-greedy with seeded RNG)
    +-- Return ranked list + selected candidate
```

## Fatigue Flow

```
session-orchestrator.evaluate(nowMs)
    |
    v
cooldown-fatigue-engine.canIntervene(nowMs)
    |
    +-- Check global cooldown (post-intervention pacing)
    +-- Check per-family cooldown
    +-- Check fatigue score threshold
    +-- Check suppression regime (HEALTHY / CAUTIOUS / CRITICAL)
    |
    If any check fails -> return { blocked: true, reason, nextEvaluateAt }
    If all pass        -> return { blocked: false }
```

## Rendering Flow

```
session-orchestrator (decision ready)
    |
    v
message-visibility-controller.evaluate({decision, contextSnapshot, now})
    |
    +-- Validate context coherence (anti-stale)
    +-- Check visibility rules
    +-- Show message (CSS class manipulation)
    +-- Start autohide timer (if configured)
    +-- Report visual lifecycle events to intervention-lifecycle-manager
    |
    v
intervention-lifecycle-manager.observeVisualEvent(event, now)
    |
    +-- FSM transition: active -> completing -> completed
    +-- Emit lifecycle events to event bus
```

## Persistence Flow

```
session-orchestrator (event processed)
    |
    +-- behavioral-state-store.update()       -> in-memory state
    +-- session-state-store.writeEvent()      -> SQLite (state events)
    +-- session-state-store.autoSnapshot()    -> SQLite (periodic snapshots)
    |
    v
session-orchestrator.snapshot()               -> full serializable state
    |
    +-- stateStore.snapshot()
    +-- intentEngine.snapshot()
    +-- fatigueEngine.snapshot()
    +-- funnelEngine.snapshot()
    +-- visibilityController.snapshot()       (if present)
    +-- signalDerivationEngine.snapshot()     (if present)
    +-- eventBus.snapshot()                   (if present)
    +-- presenceEngine.snapshot()             (if present)
    +-- orchestrator internal state
```

---

## Determinism Guarantees

| Guarantee | How |
|---|---|
| No Date.now() in hot paths | All functions accept explicit `nowMs`. Boundary fallbacks throw or use injectable clock. |
| No Math.random() in decisions | Seeded RNG via `rngSeed` parameter where randomness is needed. |
| No implicit timers | Scheduling via injectable `scheduler` dependency. Production uses setInterval; replay injects synthetic clock. |
| Full replay | `snapshot()` serializes ALL state. `restore(snap, nowMs)` recovers deterministically. |
| Bounded memory | Every Map/Array store uses LRU eviction with configurable caps (MAX_SESSIONS, maxEventQueueSize, etc.). |
| Idempotent events | Events with `eventId` are deduplicated within `idempotencyWindowMs`. |
| Funnel hysteresis | Stage transitions require confidence accumulation, timing validation, oscillation lockout. |

---

## Module File Reference

| File | Lines | Role |
|---|---|---|
| `session-orchestrator.js` | ~1290 | Single orchestration authority |
| `behavioral-state-store.js` | ~950 | Central state store |
| `unified-intent-engine.js` | ~680 | Intent inference engine |
| `cooldown-fatigue-engine.js` | ~1340 | Fatigue & cooldown authority |
| `intervention-policy-engine.js` | ~1280 | Policy evaluation |
| `message-ranking-engine.js` | ~1000 | Message ranking & selection |
| `message-visibility-controller.js` | ~830 | DOM rendering authority |
| `intervention-lifecycle-manager.js` | ~1020 | Intervention FSM |
| `funnel-stage-engine.js` | ~790 | Funnel stage tracking |
| `signal-derivation-engine.js` | ~1180 | Signal computation |
| `internal-behavioral-event-bus.js` | ~780 | Event infrastructure |
| `context-presence-engine.js` | ~1200 | Presence detection |
| `session-state-store.js` | ~900 | Session persistence |
| `logger-v2.js` | ~920 | Browser signal gateway |
| `human-message-engine.js` | ~700 | Natural message generation |
| `ope-constants.js` | ~480 | Shared constants & enums |
| `ope-intelligence-hub.js` | ~690 | Analytics hub (read-only) |
| `behavioral-intelligence-layer.js` | ~830 | Pattern analytics (read-only) |
| `cart-intelligence-engine.js` | ~600 | Cart analytics (read-only) |
| `contextual-message-ranker.js` | ~340 | Legacy ranker (read-only) |
| `message-lifecycle-controller.js` | ~660 | Lifecycle tracking (read-only) |
| `real-time-orchestrator.js` | ~290 | DEPRECATED facade |
| `interaction-transition-layer.js` | ~290 | DEPRECATED wrapper |
| `fatigue-engine.js` | ~370 | DEPRECATED shim |
| `session-simulator-runner.js` | ~1300 | Test simulation runner |
| `user-profile-simulator.js` | ~720 | Test profile generator |
| `index.js` | ~210 | Central exports + authority map |
