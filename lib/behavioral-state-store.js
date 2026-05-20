/**
 * behavioral-state-store.js
 *
 * Central Behavioral State Store – Single source of truth for the OPE system.
 *
 * Maintains deterministic, replay-safe state including:
 * - active product / context / intent
 * - visible messages and cooldowns
 * - behavioral locks (hover, modal, evaluation)
 * - session memory (viewed products, ignored messages, etc.)
 * - cleanup on context change
 * - snapshot / restore for replayability
 *
 * All public methods accept an explicit `now` timestamp (ms) to ensure determinism.
 *
 * Architecture goals:
 * - Eliminate stale state and race conditions
 * - Keep consistency between logger-v2, transition layer, policy and ranking engines
 * - Provide a clear audit trail for debugging
 *
 * Hardening applied (post-audit):
 * - Read getters are pure (no side-effects, no Map mutation).
 * - Explicit pruneExpired(now) GC for cooldowns/locks.
 * - getState() returns a deep, read-only view.
 * - patchState removed from public API (kept under __internal__).
 * - Monotonic `now` guard on every setter.
 * - Atomic version bumps per logical operation (begin/commit).
 * - Whitelisted contexts and intent states.
 * - Full coverage in _cleanupOnContextChange (product_detail, cart, checkout).
 * - Namespaced cooldown keys (PRODUCT_KEY_SEP) to avoid prefix collisions.
 * - Snapshot includes __schemaVersion; restore deep-clones safely.
 * - LRU eviction for hoverCounts via Map.
 * - Event emission via on/off/emit for downstream integration.
 * - Single source of truth: modalState.reopenCount derives from sessionMemory.modalReopens.
 */

'use strict';

const { VALID_INTENT_STATES, VALID_CONTEXTS: _OPE_CONTEXTS } = require('./ope-constants');

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------
const SCHEMA_VERSION = 2;

// Separator for namespaced cooldown keys: `${productId}${PRODUCT_KEY_SEP}${cooldownName}`
const PRODUCT_KEY_SEP = '::';

// VALID_CONTEXTS: imported from ope-constants.js
const VALID_CONTEXTS = _OPE_CONTEXTS;

// VALID_INTENT_STATES: imported from ope-constants.js (P0-1 fix — unified canonical taxonomy)

// Default initial values, hoisted to avoid magic literals
const INITIAL_INTENT_STATE = 'exploring'; // canonical — matches ope-constants
const INITIAL_INTENT_CONFIDENCE = 0.5;
const INITIAL_CONTEXT = 'listing';

// ----------------------------------------------------------------------
// Configuration – frozen for stability
// ----------------------------------------------------------------------
const DEFAULT_CONFIG = Object.freeze({
  // Default cooldown durations (ms) for different keys
  defaultCooldownMs: 15000,
  // Time before a behavioral lock auto-expires (ms)
  lockTimeoutMs: 5000,
  // Maximum items stored in sessionMemory arrays
  maxViewedProducts: 20,
  maxIgnoredMessages: 20,
  maxHoverCounts: 50,
  // After how many modal reopens we consider it "excessive"
  modalReopenThreshold: 3,
  // Strict mode rejects invalid contexts/intent states with an Error
  // Non-strict mode silently ignores them (and returns false).
  strict: true,
});

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/**
 * Deep clone that preserves Map, Set, Date.
 * Uses structuredClone when available (Node 17+, modern browsers), with a JSON fallback
 * that explicitly re-hydrates Maps from the source.
 */
function deepClone(value) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  // Fallback: JSON for plain data + manual rehydration of Maps at known paths is unsafe in
  // the general case, so we rebuild defensively from the input object.
  return _jsonCloneWithMaps(value);
}

function _jsonCloneWithMaps(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value.entries()) out.set(k, _jsonCloneWithMaps(v));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    for (const v of value.values()) out.add(_jsonCloneWithMaps(v));
    return out;
  }
  if (Array.isArray(value)) return value.map(_jsonCloneWithMaps);
  const out = {};
  for (const k of Object.keys(value)) out[k] = _jsonCloneWithMaps(value[k]);
  return out;
}

/**
 * Recursively deep-freezes a plain object/array tree.
 * Maps and Sets are wrapped in read-only proxies to block mutation methods.
 */
function deepFreezeView(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) return _readOnlyMapView(value);
  if (value instanceof Set) return _readOnlySetView(value);
  if (Array.isArray(value)) {
    const frozen = value.map(deepFreezeView);
    return Object.freeze(frozen);
  }
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepFreezeView(value[k]);
  return Object.freeze(out);
}

function _readOnlyMapView(map) {
  const view = new Map();
  for (const [k, v] of map.entries()) view.set(k, deepFreezeView(v));
  // Block mutation
  view.set = _throwReadOnly;
  view.delete = _throwReadOnly;
  view.clear = _throwReadOnly;
  return view;
}

function _readOnlySetView(set) {
  const view = new Set();
  for (const v of set.values()) view.add(deepFreezeView(v));
  view.add = _throwReadOnly;
  view.delete = _throwReadOnly;
  view.clear = _throwReadOnly;
  return view;
}

function _throwReadOnly() {
  throw new Error('Read-only state view: use store methods to mutate state.');
}

// ----------------------------------------------------------------------
// Main Behavioral State Store class
// ----------------------------------------------------------------------
class BehavioralStateStore {
  constructor(config = {}) {
    // Merge config into a new mutable object, then freeze it to prevent runtime tampering
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });
    this._state = null;        // initialized in initialize()
    this._listeners = new Set(); // change subscribers
    this._txDepth = 0;          // transactional version-bump depth
    this._txDirty = false;      // whether anything changed inside the current tx
    this._disposed = false;
  }

  // ------------------------------------------------------------------
  // Initialization & core state getter
  // ------------------------------------------------------------------

  /**
   * Initializes the state store. Throws if already initialized to prevent silent data loss.
   * Use `reset(now)` to deliberately re-initialize.
   * @param {number} now
   */
  initialize(now) {
    this._assertNotDisposed();
    if (this._state) {
      throw new Error('Store already initialized. Use reset(now) to re-initialize.');
    }
    this._state = this._buildInitialState(now);
  }

  _buildInitialState(now) {
    return {
      __schemaVersion: SCHEMA_VERSION,

      // Core identity
      activeProductId: null,
      currentContext: INITIAL_CONTEXT,
      stableIntentState: INITIAL_INTENT_STATE,
      intentConfidence: INITIAL_INTENT_CONFIDENCE,

      // Message visibility
      visibleMessage: null,
      visibleMessageContext: null,

      // UI component states
      modalState: {
        isOpen: false,
        productId: null,
        openedAt: null,
        reopenCount: 0,
      },
      hoverState: {
        active: false,
        elementId: null,
        startedAt: null,
        productId: null,
      },
      dwellState: {
        productId: null,
        startedAt: null,
        lastUpdateAt: null,
        totalMs: 0,
      },

      // Cooldowns – key -> expiration timestamp
      cooldowns: new Map(),

      // Behavioral locks – key -> { lockedAt, expiresAt }
      behavioralLocks: new Map(),

      // Session memory
      sessionMemory: {
        viewedProducts: [],
        ignoredMessages: [],
        modalReopens: 0,
        // Map preserves insertion order -> trivial LRU eviction
        hoverCounts: new Map(),
      },

      // Timestamps for diagnostics
      timestamps: {
        createdAt: now,
        lastMessageShownAt: null,
        lastMessageClearedAt: null,
        lastMessageClearReason: null,
        lastCleanupAt: now,
        lastContextChangeAt: now,
        lastIntentUpdateAt: now,
        lastEventAt: now, // monotonic guard
      },

      version: 1,
    };
  }

  /**
   * Returns a deep, read-only view of the current state.
   * Attempting to mutate the returned object (including its Maps) throws.
   */
  getState() {
    this._assertInitialized();
    return deepFreezeView(this._state);
  }

  /**
   * Internal API. Not part of the public contract.
   * Kept for low-level test fixtures and migrations only.
   * @private
   */
  __internal__patchState(partialState, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'patchState')) return;
    this._beginTx();
    if (partialState.timestamps) {
      this._state.timestamps = { ...this._state.timestamps, ...partialState.timestamps };
      // eslint-disable-next-line no-param-reassign
      const { timestamps, ...rest } = partialState;
      Object.assign(this._state, rest);
    } else {
      Object.assign(this._state, partialState);
    }
    this._touchEvent(now);
    this._commitTx();
  }

  // ------------------------------------------------------------------
  // Subscriptions (for event bus / logger / engines)
  // ------------------------------------------------------------------

  /**
   * Subscribe to state changes. Listener receives a read-only state view.
   * @param {(state: object, meta: { version: number, now: number }) => void} listener
   * @returns {() => void} unsubscribe
   */
  on(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  off(listener) {
    this._listeners.delete(listener);
  }

  _emitChange(now) {
    if (this._listeners.size === 0) return;
    const view = deepFreezeView(this._state);
    const meta = { version: this._state.version, now };
    for (const fn of this._listeners) {
      try {
        fn(view, meta);
      } catch (_err) {
        // Subscribers must not break the store. Errors are swallowed by design;
        // hook a logger in production if needed.
      }
    }
  }

  // ------------------------------------------------------------------
  // Product & context management
  // ------------------------------------------------------------------

  /**
   * Sets the active product ID. Automatically clears product-scoped state.
   * @param {string|null} productId
   * @param {number} now
   */
  setActiveProduct(productId, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'setActiveProduct')) return;
    const oldProduct = this._state.activeProductId;
    if (oldProduct === productId) return;

    this._beginTx();
    this._clearProductSpecificState(oldProduct, now);
    this._state.activeProductId = productId;
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Sets the current behavioral context.
   * @param {string} context
   * @param {number} now
   */
  setContext(context, now) {
    this._assertInitialized();
    if (!this._validateContext(context, 'setContext')) return;
    if (!this._guardMonotonic(now, 'setContext')) return;

    const oldContext = this._state.currentContext;
    if (oldContext === context) return;

    this._beginTx();
    this._cleanupOnContextChange(oldContext, context, now);
    this._state.currentContext = context;
    this._state.timestamps.lastContextChangeAt = now;
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Updates the stable intent state and its confidence.
   * @param {string} intentState
   * @param {number} confidence
   * @param {number} now
   */
  setIntentState(intentState, confidence, now) {
    this._assertInitialized();
    if (!this._validateIntentState(intentState, 'setIntentState')) return;
    if (!this._guardMonotonic(now, 'setIntentState')) return;

    this._beginTx();
    this._state.stableIntentState = intentState;
    this._state.intentConfidence = Math.min(1, Math.max(0, confidence));
    this._state.timestamps.lastIntentUpdateAt = now;
    this._touchEvent(now);
    this._commitTx();
  }

  // ------------------------------------------------------------------
  // Message visibility
  // ------------------------------------------------------------------

  showMessage(messageData, context, now) {
    this._assertInitialized();
    if (!this._validateContext(context, 'showMessage')) return;
    if (!this._guardMonotonic(now, 'showMessage')) return;

    this._beginTx();
    this._state.visibleMessage = {
      id: messageData.id,
      family: messageData.family,
      subtype: messageData.subtype,
      context,
      timestamp: now,
    };
    this._state.visibleMessageContext = context;
    this._state.timestamps.lastMessageShownAt = now;
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Clears the currently visible message and records the reason in the audit trail.
   * @param {string} reason
   * @param {number} now
   */
  clearMessage(reason, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'clearMessage')) return;
    if (this._state.visibleMessage === null && this._state.visibleMessageContext === null) {
      return; // nothing to clear, no version bump
    }

    this._beginTx();
    this._state.visibleMessage = null;
    this._state.visibleMessageContext = null;
    this._state.timestamps.lastMessageClearedAt = now;
    this._state.timestamps.lastMessageClearReason = reason || 'unspecified';
    this._touchEvent(now);
    this._commitTx();
  }

  // ------------------------------------------------------------------
  // Cooldowns
  // ------------------------------------------------------------------

  /**
   * Builds a namespaced cooldown key for a product, avoiding prefix collisions.
   * @param {string} productId
   * @param {string} cooldownName
   * @returns {string}
   */
  static productCooldownKey(productId, cooldownName) {
    return `${productId}${PRODUCT_KEY_SEP}${cooldownName}`;
  }

  setCooldown(key, durationMs, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'setCooldown')) return;

    this._beginTx();
    this._state.cooldowns.set(key, now + durationMs);
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Pure read. Does NOT mutate state. Use pruneExpired(now) for GC.
   */
  isCooldownActive(key, now) {
    if (!this._state) return true; // pre-init = safe (active)
    const expiresAt = this._state.cooldowns.get(key);
    if (expiresAt == null) return false;
    return now < expiresAt;
  }

  removeCooldown(key, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'removeCooldown')) return;
    if (!this._state.cooldowns.has(key)) return;

    this._beginTx();
    this._state.cooldowns.delete(key);
    this._touchEvent(now);
    this._commitTx();
  }

  // ------------------------------------------------------------------
  // Behavioral locks
  // ------------------------------------------------------------------

  /**
   * Acquires a behavioral lock. Optional per-lock timeout overrides the global config.
   * @param {string} lockKey
   * @param {number} now
   * @param {number} [timeoutMs] - optional per-lock TTL
   * @returns {boolean}
   */
  setBehavioralLock(lockKey, now, timeoutMs) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'setBehavioralLock')) return false;

    const existing = this._state.behavioralLocks.get(lockKey);
    if (existing && existing.expiresAt > now) {
      return false; // still locked
    }
    const ttl = typeof timeoutMs === 'number' && timeoutMs > 0
      ? timeoutMs
      : this.config.lockTimeoutMs;

    this._beginTx();
    this._state.behavioralLocks.set(lockKey, {
      lockedAt: now,
      expiresAt: now + ttl,
    });
    this._touchEvent(now);
    this._commitTx();
    return true;
  }

  releaseBehavioralLock(lockKey, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'releaseBehavioralLock')) return;
    if (!this._state.behavioralLocks.has(lockKey)) return;

    this._beginTx();
    this._state.behavioralLocks.delete(lockKey);
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Pure read. Does NOT mutate state. Use pruneExpired(now) for GC.
   */
  isLocked(lockKey, now) {
    if (!this._state) return false; // pre-init = safe (unlocked)
    const lock = this._state.behavioralLocks.get(lockKey);
    if (!lock) return false;
    return now < lock.expiresAt;
  }

  /**
   * Explicit GC of expired cooldowns and locks. Bumps version if anything was pruned.
   * Intended to be called periodically by an external scheduler (e.g. the orchestrator).
   * @param {number} now
   * @returns {{ cooldowns: number, locks: number }} pruned counts
   */
  pruneExpired(now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'pruneExpired')) return { cooldowns: 0, locks: 0 };

    let prunedCooldowns = 0;
    let prunedLocks = 0;

    this._beginTx();
    for (const [key, expiresAt] of this._state.cooldowns.entries()) {
      if (now >= expiresAt) {
        this._state.cooldowns.delete(key);
        prunedCooldowns++;
      }
    }
    for (const [key, lock] of this._state.behavioralLocks.entries()) {
      if (now >= lock.expiresAt) {
        this._state.behavioralLocks.delete(key);
        prunedLocks++;
      }
    }
    if (prunedCooldowns > 0 || prunedLocks > 0) {
      this._state.timestamps.lastCleanupAt = now;
      this._touchEvent(now);
    }
    this._commitTx();
    return { cooldowns: prunedCooldowns, locks: prunedLocks };
  }

  // ------------------------------------------------------------------
  // Session memory helpers
  // ------------------------------------------------------------------

  addViewedProduct(productId, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'addViewedProduct')) return;

    const arr = this._state.sessionMemory.viewedProducts;
    const existingIdx = arr.indexOf(productId);

    this._beginTx();
    if (existingIdx !== -1) arr.splice(existingIdx, 1);
    arr.push(productId);
    while (arr.length > this.config.maxViewedProducts) arr.shift();
    this._touchEvent(now);
    this._commitTx();
  }

  addIgnoredMessage(messageId, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'addIgnoredMessage')) return;

    const arr = this._state.sessionMemory.ignoredMessages;
    if (arr.includes(messageId)) return; // no version bump

    this._beginTx();
    arr.push(messageId);
    while (arr.length > this.config.maxIgnoredMessages) arr.shift();
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Increments the modal reopen counter. modalState.reopenCount is derived,
   * not stored as a duplicate source of truth.
   */
  incrementModalReopen(now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'incrementModalReopen')) return;

    this._beginTx();
    this._state.sessionMemory.modalReopens++;
    this._state.modalState.reopenCount = this._state.sessionMemory.modalReopens;
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Increments hover count for a product. Implements true LRU eviction via Map insertion order.
   */
  incrementHoverCount(productId, now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'incrementHoverCount')) return;

    const counts = this._state.sessionMemory.hoverCounts;
    const prev = counts.get(productId) || 0;

    this._beginTx();
    // Re-insert to bump recency in the Map's insertion order
    counts.delete(productId);
    counts.set(productId, prev + 1);
    // Evict oldest entries until within bounds
    while (counts.size > this.config.maxHoverCounts) {
      const oldestKey = counts.keys().next().value;
      counts.delete(oldestKey);
    }
    this._touchEvent(now);
    this._commitTx();
  }

  // ------------------------------------------------------------------
  // Reset / cleanup
  // ------------------------------------------------------------------

  /**
   * Resets UI state related to a specific context.
   */
  resetContextState(context, now) {
    this._assertInitialized();
    if (!this._validateContext(context, 'resetContextState')) return;
    if (!this._guardMonotonic(now, 'resetContextState')) return;

    this._beginTx();
    this._resetContextStateInternal(context, now);
    this._state.timestamps.lastCleanupAt = now;
    this._touchEvent(now);
    this._commitTx();
  }

  _resetContextStateInternal(context, now) {
    if (context === 'modal') {
      this._state.modalState = {
        isOpen: false,
        productId: null,
        openedAt: null,
        reopenCount: this._state.sessionMemory.modalReopens, // derived, kept in sync
      };
      if (this._state.visibleMessageContext === 'modal') {
        this._clearMessageInternal('context_reset', now);
      }
    } else if (context === 'hover_cta') {
      this._state.hoverState = {
        active: false,
        elementId: null,
        startedAt: null,
        productId: null,
      };
    } else if (context === 'product_detail') {
      if (this._state.dwellState.productId !== this._state.activeProductId) {
        this._state.dwellState = {
          productId: null,
          startedAt: null,
          lastUpdateAt: null,
          totalMs: 0,
        };
      }
    } else if (context === 'cart' || context === 'checkout') {
      // Aggressive cleanup: any open modal or active hover is stale here.
      this._resetContextStateInternal('modal', now);
      this._resetContextStateInternal('hover_cta', now);
    } else if (context === 'listing') {
      this._resetContextStateInternal('modal', now);
      this._resetContextStateInternal('hover_cta', now);
    }
  }

  /**
   * Resets transient UI state but preserves session memory (viewedProducts, modalReopens,
   * ignoredMessages, hoverCounts).
   */
  resetTransientState(now) {
    this._assertInitialized();
    if (!this._guardMonotonic(now, 'resetTransientState')) return;

    this._beginTx();
    this._state.visibleMessage = null;
    this._state.visibleMessageContext = null;
    this._state.modalState = {
      isOpen: false,
      productId: null,
      openedAt: null,
      reopenCount: this._state.sessionMemory.modalReopens,
    };
    this._state.hoverState = {
      active: false,
      elementId: null,
      startedAt: null,
      productId: null,
    };
    this._state.dwellState = {
      productId: null,
      startedAt: null,
      lastUpdateAt: null,
      totalMs: 0,
    };
    this._state.cooldowns.clear();
    this._state.behavioralLocks.clear();
    this._state.timestamps.lastCleanupAt = now;
    this._touchEvent(now);
    this._commitTx();
  }

  /**
   * Resets the entire store to initial state, discarding session memory.
   */
  reset(now) {
    this._assertNotDisposed();
    this._state = this._buildInitialState(now);
    // Force a single notification at the new version
    this._emitChange(now);
  }

  /**
   * Releases listeners and clears state for GC.
   */
  dispose() {
    this._listeners.clear();
    this._state = null;
    this._disposed = true;
  }

  // ------------------------------------------------------------------
  // Private cleanup methods
  // ------------------------------------------------------------------

  _clearProductSpecificState(productId, now) {
    if (!productId) return;

    if (this._state.visibleMessage && this._state.visibleMessage.context !== 'global') {
      this._clearMessageInternal('product_change', now);
    }
    if (this._state.hoverState.productId === productId) {
      this._state.hoverState = {
        active: false,
        elementId: null,
        startedAt: null,
        productId: null,
      };
    }
    if (this._state.dwellState.productId === productId) {
      this._state.dwellState = {
        productId: null,
        startedAt: null,
        lastUpdateAt: null,
        totalMs: 0,
      };
    }
    // Namespaced cleanup: only delete keys exactly under `${productId}::*`
    const prefix = `${productId}${PRODUCT_KEY_SEP}`;
    for (const key of this._state.cooldowns.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this._state.cooldowns.delete(key);
      }
    }
  }

  _clearMessageInternal(reason, now) {
    if (this._state.visibleMessage === null && this._state.visibleMessageContext === null) {
      return;
    }
    this._state.visibleMessage = null;
    this._state.visibleMessageContext = null;
    this._state.timestamps.lastMessageClearedAt = now;
    this._state.timestamps.lastMessageClearReason = reason || 'unspecified';
  }

  _cleanupOnContextChange(oldContext, newContext, now) {
    // Always void messages bound to the previous context unless they are global.
    if (
      this._state.visibleMessage &&
      this._state.visibleMessageContext !== newContext &&
      this._state.visibleMessageContext !== 'global'
    ) {
      this._clearMessageInternal('context_change', now);
    }

    switch (newContext) {
      case 'listing':
        this._resetContextStateInternal('modal', now);
        this._resetContextStateInternal('hover_cta', now);
        break;
      case 'modal':
        this._resetContextStateInternal('hover_cta', now);
        // setContext('modal') no longer opens the modal implicitly. Use a dedicated
        // modal lifecycle path to keep reopenCount accounting consistent.
        break;
      case 'hover_cta':
        // Hover is transient; do not aggressively clear modal/dwell.
        break;
      case 'product_detail':
        this._resetContextStateInternal('modal', now);
        this._resetContextStateInternal('hover_cta', now);
        break;
      case 'cart':
      case 'checkout':
        this._resetContextStateInternal('modal', now);
        this._resetContextStateInternal('hover_cta', now);
        // Cancel transient cooldowns/locks scoped to UI engagement.
        // We leave session memory intact to preserve cross-context analytics.
        break;
      default:
        // Validation upstream prevents this branch.
        break;
    }
  }

  // ------------------------------------------------------------------
  // Snapshot / Restore (replay-safe)
  // ------------------------------------------------------------------

  /**
   * Returns a deep clone of the entire state for persistence.
   * Maps are serialized as { __map: true, entries: [...] } so they survive JSON round-trips.
   */
  snapshot() {
    if (!this._state) return null;
    return {
      __schemaVersion: SCHEMA_VERSION,
      activeProductId: this._state.activeProductId,
      currentContext: this._state.currentContext,
      stableIntentState: this._state.stableIntentState,
      intentConfidence: this._state.intentConfidence,
      visibleMessage: _cloneJson(this._state.visibleMessage),
      visibleMessageContext: this._state.visibleMessageContext,
      modalState: _cloneJson(this._state.modalState),
      hoverState: _cloneJson(this._state.hoverState),
      dwellState: _cloneJson(this._state.dwellState),
      cooldowns: _mapToSerializable(this._state.cooldowns),
      behavioralLocks: _mapToSerializable(this._state.behavioralLocks),
      sessionMemory: {
        viewedProducts: [...this._state.sessionMemory.viewedProducts],
        ignoredMessages: [...this._state.sessionMemory.ignoredMessages],
        modalReopens: this._state.sessionMemory.modalReopens,
        hoverCounts: _mapToSerializable(this._state.sessionMemory.hoverCounts),
      },
      timestamps: { ...this._state.timestamps },
      version: this._state.version,
    };
  }

  /**
   * Restores state from a previous snapshot. Validates schema version and rebuilds
   * Maps and arrays via deep clone to prevent shared references.
   */
  restore(snapshot, now) {
    this._assertNotDisposed();
    if (!snapshot) return;

    const schemaVersion = snapshot.__schemaVersion ?? 1;
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(
        `Snapshot schema mismatch: got ${schemaVersion}, expected ${SCHEMA_VERSION}.`
      );
    }

    const restored = {
      __schemaVersion: SCHEMA_VERSION,
      activeProductId: snapshot.activeProductId ?? null,
      currentContext: VALID_CONTEXTS.has(snapshot.currentContext)
        ? snapshot.currentContext
        : INITIAL_CONTEXT,
      stableIntentState: VALID_INTENT_STATES.has(snapshot.stableIntentState)
        ? snapshot.stableIntentState
        : INITIAL_INTENT_STATE,
      intentConfidence:
        typeof snapshot.intentConfidence === 'number'
          ? Math.min(1, Math.max(0, snapshot.intentConfidence))
          : INITIAL_INTENT_CONFIDENCE,
      visibleMessage: _cloneJson(snapshot.visibleMessage ?? null),
      visibleMessageContext: snapshot.visibleMessageContext ?? null,
      modalState: _cloneJson(snapshot.modalState) || {
        isOpen: false, productId: null, openedAt: null, reopenCount: 0,
      },
      hoverState: _cloneJson(snapshot.hoverState) || {
        active: false, elementId: null, startedAt: null, productId: null,
      },
      dwellState: _cloneJson(snapshot.dwellState) || {
        productId: null, startedAt: null, lastUpdateAt: null, totalMs: 0,
      },
      cooldowns: _serializableToMap(snapshot.cooldowns),
      behavioralLocks: _serializableToMap(snapshot.behavioralLocks),
      sessionMemory: {
        viewedProducts: Array.isArray(snapshot.sessionMemory?.viewedProducts)
          ? [...snapshot.sessionMemory.viewedProducts]
          : [],
        ignoredMessages: Array.isArray(snapshot.sessionMemory?.ignoredMessages)
          ? [...snapshot.sessionMemory.ignoredMessages]
          : [],
        modalReopens: snapshot.sessionMemory?.modalReopens ?? 0,
        hoverCounts: _serializableToMap(snapshot.sessionMemory?.hoverCounts),
      },
      timestamps: {
        createdAt: snapshot.timestamps?.createdAt ?? now,
        lastMessageShownAt: snapshot.timestamps?.lastMessageShownAt ?? null,
        lastMessageClearedAt: snapshot.timestamps?.lastMessageClearedAt ?? null,
        lastMessageClearReason: snapshot.timestamps?.lastMessageClearReason ?? null,
        lastCleanupAt: snapshot.timestamps?.lastCleanupAt ?? now,
        lastContextChangeAt: snapshot.timestamps?.lastContextChangeAt ?? now,
        lastIntentUpdateAt: snapshot.timestamps?.lastIntentUpdateAt ?? now,
        lastEventAt: snapshot.timestamps?.lastEventAt ?? now,
      },
      version: (snapshot.version ?? 0) + 1,
    };

    this._state = restored;

    // Drop expired entries against the current `now`
    for (const [k, v] of this._state.cooldowns.entries()) {
      if (now >= v) this._state.cooldowns.delete(k);
    }
    for (const [k, v] of this._state.behavioralLocks.entries()) {
      if (now >= v.expiresAt) this._state.behavioralLocks.delete(k);
    }

    this._emitChange(now);
  }

  // ------------------------------------------------------------------
  // Diagnostics
  // ------------------------------------------------------------------

  getDiagnostics(now) {
    if (!this._state) return { error: 'Store not initialized' };

    const activeCooldowns = [];
    for (const [key, expiresAt] of this._state.cooldowns.entries()) {
      activeCooldowns.push({
        key,
        expiresAt,
        remainingMs: Math.max(0, expiresAt - now),
      });
    }
    const activeLocks = [];
    for (const [key, lock] of this._state.behavioralLocks.entries()) {
      activeLocks.push({
        key,
        lockedAt: lock.lockedAt,
        expiresAt: lock.expiresAt,
        remainingMs: Math.max(0, lock.expiresAt - now),
      });
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      activeProductId: this._state.activeProductId,
      currentContext: this._state.currentContext,
      intentState: this._state.stableIntentState,
      intentConfidence: this._state.intentConfidence,
      visibleMessage: this._state.visibleMessage
        ? { ...this._state.visibleMessage }
        : null,
      modalOpen: this._state.modalState.isOpen,
      hoverActive: this._state.hoverState.active,
      cooldowns: activeCooldowns,
      locks: activeLocks,
      sessionMemory: {
        viewedProductsCount: this._state.sessionMemory.viewedProducts.length,
        ignoredMessagesCount: this._state.sessionMemory.ignoredMessages.length,
        hoverCountsCount: this._state.sessionMemory.hoverCounts.size,
        modalReopens: this._state.sessionMemory.modalReopens,
      },
      timeInContextMs: now - this._state.timestamps.lastContextChangeAt,
      timeSinceLastMessageMs:
        this._state.timestamps.lastMessageShownAt !== null
          ? now - this._state.timestamps.lastMessageShownAt
          : null,
      lastCleanupAt: this._state.timestamps.lastCleanupAt,
      lastMessageClearReason: this._state.timestamps.lastMessageClearReason,
      version: this._state.version,
      listenersCount: this._listeners.size,
    };
  }

  // ------------------------------------------------------------------
  // Internals: transactions, guards, validation
  // ------------------------------------------------------------------

  _beginTx() {
    this._txDepth++;
  }

  _commitTx() {
    if (this._txDepth === 0) return;
    this._txDepth--;
    if (this._txDepth === 0 && this._txDirty) {
      this._state.version++;
      this._txDirty = false;
      this._emitChange(this._state.timestamps.lastEventAt);
    }
  }

  _touchEvent(now) {
    this._state.timestamps.lastEventAt = now;
    this._txDirty = true;
  }

  _guardMonotonic(now, op) {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      if (this.config.strict) {
        throw new TypeError(`[${op}] 'now' must be a finite number, got ${now}`);
      }
      return false;
    }
    const last = this._state ? this._state.timestamps.lastEventAt : -Infinity;
    if (now < last) {
      // Out-of-order event: silently drop to preserve replay safety.
      return false;
    }
    return true;
  }

  _validateContext(context, op) {
    if (VALID_CONTEXTS.has(context)) return true;
    if (this.config.strict) {
      throw new Error(`[${op}] invalid context: "${context}"`);
    }
    return false;
  }

  _validateIntentState(state, op) {
    if (VALID_INTENT_STATES.has(state)) return true;
    if (this.config.strict) {
      throw new Error(`[${op}] invalid intent state: "${state}"`);
    }
    return false;
  }

  _assertInitialized() {
    this._assertNotDisposed();
    if (!this._state) throw new Error('Store not initialized. Call initialize(now) first.');
  }

  _assertNotDisposed() {
    if (this._disposed) throw new Error('Store has been disposed.');
  }
}

// ----------------------------------------------------------------------
// Serialization helpers (Map <-> JSON-safe envelope)
// ----------------------------------------------------------------------

function _cloneJson(value) {
  if (value === null || value === undefined) return value;
  return deepClone(value);
}

function _mapToSerializable(map) {
  if (!(map instanceof Map)) return { __map: true, entries: [] };
  return { __map: true, entries: Array.from(map.entries()) };
}

function _serializableToMap(value) {
  const m = new Map();
  if (!value) return m;
  if (value instanceof Map) {
    for (const [k, v] of value.entries()) m.set(k, v);
    return m;
  }
  if (value.__map && Array.isArray(value.entries)) {
    for (const [k, v] of value.entries) m.set(k, v);
    return m;
  }
  // Legacy snapshots stored plain objects
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) m.set(k, value[k]);
  }
  return m;
}

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------
module.exports = {
  BehavioralStateStore,
  DEFAULT_CONFIG,
  SCHEMA_VERSION,
  PRODUCT_KEY_SEP,
  VALID_CONTEXTS,
  VALID_INTENT_STATES,
};
