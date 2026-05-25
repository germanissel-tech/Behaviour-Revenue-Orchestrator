/**
 * internal-behavioral-event-bus.js
 *
 * Internal Behavioral Event Bus – decoupled communication layer for the OPE system.
 *
 * Enables event-driven architecture between modules (logger-v2, transition layer,
 * state store, policy engine, ranking engine, UI detection).
 *
 * Guarantees:
 *  - Deterministic, replay-safe (explicit `now` parameter, no Date.now() leaked into state).
 *  - Bounded memory: maxQueueSize (drop policy) + maxHistorySize (true ring buffer).
 *  - Bounded recursion: maxChainDepth (vertical) + maxFanOutPerHandler (horizontal).
 *  - Atomic emitBatch (all events enqueued before processing starts).
 *  - Listener isolation: payload deep-frozen per dispatch; listener mutation during
 *    iteration uses a snapshot of the listener set.
 *  - Handler errors are routed via the bus itself (`__bus:handler_error`) instead of
 *    bypassing the logger via console.error.
 *  - Owner-tagged listeners for HMR / module-reload teardown.
 *  - Once-handlers resolvable via the original handler reference in off().
 *  - Snapshot/restore is deep, includes ring buffer index, and is schema-versioned.
 *
 * No external dependencies, pure JavaScript.
 */

'use strict';

// ----------------------------------------------------------------------
// Schema / Config
// ----------------------------------------------------------------------

const SNAPSHOT_SCHEMA_VERSION = 2;

const DEFAULT_CONFIG = Object.freeze({
  // Maximum number of events kept in the history ring buffer.
  maxHistorySize: 200,
  // Maximum vertical chain depth (A emits B, B emits C, ...).
  maxChainDepth: 10,
  // Maximum horizontal fan-out: how many events a single handler invocation
  // may enqueue before the bus starts dropping (prevents exponential OOM).
  maxFanOutPerHandler: 32,
  // Maximum queue size. Events arriving past this are dropped per `queueDropPolicy`.
  maxQueueSize: 10000,
  // Drop policy when queue is full: 'drop-newest' | 'drop-oldest-low-priority' | 'throw'.
  queueDropPolicy: 'drop-oldest-low-priority',
  // Default priority for events without explicit priority.
  defaultPriority: 'NORMAL',
  // When true, payloads are deep-frozen before dispatch so listeners cannot mutate them.
  freezePayloads: true,
  // When true, emits __bus:handler_error events on listener exceptions.
  emitHandlerErrors: true,
  // When true, unknown event names are accepted silently. When false, a warning is logged
  // and a __bus:unknown_event is emitted (useful in development).
  allowUnknownEvents: true,
  // Optional explicit whitelist; when non-empty, events not in the set trigger the
  // unknown-event path regardless of allowUnknownEvents.
  eventWhitelist: null,
});

// Priorities (higher value = higher priority).
const PRIORITY_VALUES = Object.freeze({
  CRITICAL: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1,
});

const VALID_DROP_POLICIES = new Set(['drop-newest', 'drop-oldest-low-priority', 'throw']);

// Internal bus-emitted events (never gated by the whitelist).
const INTERNAL_EVENTS = Object.freeze({
  HANDLER_ERROR: '__bus:handler_error',
  EVENT_DROPPED: '__bus:event_dropped',
  UNKNOWN_EVENT: '__bus:unknown_event',
  RESET: '__bus:reset',
});

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

// Deep clone that survives Map/Set/Date and avoids JSON pitfalls when available.
// Falls back to a safe JSON clone with cycle detection so a cyclic payload cannot
// crash the bus.
function safeDeepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch (_) {
      // fall through to JSON clone
    }
  }
  try {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(value, (_key, val) => {
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      })
    );
  } catch (_) {
    // Last resort: return a shallow copy so we never crash the dispatch loop.
    if (Array.isArray(value)) return value.slice();
    return Object.assign({}, value);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child && typeof child === 'object') deepFreeze(child);
  }
  return value;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// ----------------------------------------------------------------------
// Main Event Bus Class
// ----------------------------------------------------------------------

class InternalBehavioralEventBus {
  constructor(config = {}) {
    const merged = { ...DEFAULT_CONFIG, ...config };
    if (!VALID_DROP_POLICIES.has(merged.queueDropPolicy)) {
      merged.queueDropPolicy = DEFAULT_CONFIG.queueDropPolicy;
    }
    if (!PRIORITY_VALUES[merged.defaultPriority]) {
      merged.defaultPriority = DEFAULT_CONFIG.defaultPriority;
    }
    // Defensive deep-freeze so consumers can't sabotage invariants at runtime.
    this.config = deepFreeze({ ...merged });

    // Map: eventName -> Map<handler, listenerRecord>
    // listenerRecord = { handler, owner, originalHandler }
    this._listeners = new Map();

    // WeakMap<originalHandler, wrapper> for once() so off() can resolve wrappers.
    this._onceWrappers = new WeakMap();

    // Priority-bucketed queues (FIFO inside each bucket). O(1) enqueue/dequeue.
    this._buckets = {
      CRITICAL: [],
      HIGH: [],
      NORMAL: [],
      LOW: [],
    };
    this._queueSize = 0;

    // Reentrancy / processing state.
    this._processing = false;
    this._currentDepth = 0;
    // Number of events emitted by the currently-executing handler (horizontal fan-out).
    this._currentHandlerEmits = 0;

    // History ring buffer.
    this._history = new Array(this.config.maxHistorySize);
    this._historyWriteIndex = 0;
    this._historyCount = 0;

    // Monotonic version counter (never rewinds, even on reset).
    this._version = 1;

    // Diagnostics counters.
    this._droppedEvents = 0;
    this._totalEventsEmitted = 0;
    this._totalHandlerErrors = 0;

    // Disposal flag.
    this._disposed = false;
  }

  // ------------------------------------------------------------------
  // Public API – subscription
  // ------------------------------------------------------------------

  /**
   * Register a listener.
   * @param {string} eventName
   * @param {Function} handler - (payload, eventMeta) => void
   *                              eventMeta = { eventName, timestamp, source, priority, version }
   * @param {object} [options]
   * @param {string} [options.owner] - opaque tag for bulk removal (HMR, module reload)
   */
  on(eventName, handler, options = {}) {
    this._assertAlive();
    this._assertHandler(handler);
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('[EventBus] eventName must be a non-empty string');
    }
    let map = this._listeners.get(eventName);
    if (!map) {
      map = new Map();
      this._listeners.set(eventName, map);
    }
    map.set(handler, {
      handler,
      owner: options.owner || null,
      originalHandler: handler,
    });
    this._version++;
  }

  /**
   * Register a one-time listener. `off(eventName, handler)` with the original
   * handler reference will remove the wrapper.
   */
  once(eventName, handler, options = {}) {
    this._assertAlive();
    this._assertHandler(handler);
    const self = this;
    const wrapper = function onceWrapper(payload, meta) {
      try {
        handler(payload, meta);
      } finally {
        // Always unregister, even if the handler threw.
        self.off(eventName, wrapper);
        self._onceWrappers.delete(handler);
      }
    };
    this._onceWrappers.set(handler, wrapper);
    this.on(eventName, wrapper, options);
    // Tag the listener record's originalHandler so off(name, original) can find it.
    const record = this._listeners.get(eventName).get(wrapper);
    if (record) record.originalHandler = handler;
  }

  /**
   * Remove a listener. Accepts either the original handler (for once()) or the
   * actual registered function.
   */
  off(eventName, handler) {
    this._assertAlive();
    const map = this._listeners.get(eventName);
    if (!map) return;

    let removed = false;
    if (map.has(handler)) {
      map.delete(handler);
      removed = true;
    } else {
      // Try resolving a once-wrapper from the original handler.
      const wrapper = this._onceWrappers.get(handler);
      if (wrapper && map.has(wrapper)) {
        map.delete(wrapper);
        this._onceWrappers.delete(handler);
        removed = true;
      }
    }

    if (removed) {
      if (map.size === 0) this._listeners.delete(eventName);
      this._version++;
    }
  }

  /**
   * Remove all listeners associated with a given owner tag (HMR / reload).
   * @returns {number} number of listeners removed
   */
  removeByOwner(owner) {
    this._assertAlive();
    if (owner == null) return 0;
    let removed = 0;
    for (const [eventName, map] of this._listeners) {
      for (const [handler, record] of map) {
        if (record.owner === owner) {
          map.delete(handler);
          removed++;
        }
      }
      if (map.size === 0) this._listeners.delete(eventName);
    }
    if (removed > 0) this._version++;
    return removed;
  }

  /**
   * Total number of listeners across all events.
   */
  listenerCount(eventName) {
    if (eventName == null) {
      let total = 0;
      for (const map of this._listeners.values()) total += map.size;
      return total;
    }
    const map = this._listeners.get(eventName);
    return map ? map.size : 0;
  }

  // ------------------------------------------------------------------
  // Public API – emission
  // ------------------------------------------------------------------

  /**
   * Emit a single event.
   * @returns {boolean} true if accepted into the queue, false if dropped.
   */
  emit(eventName, payload, now, priority, source) {
    this._assertAlive();
    if (typeof eventName !== 'string' || eventName.length === 0) {
      throw new TypeError('[EventBus] eventName must be a non-empty string');
    }
    if (!isFiniteNumber(now)) {
      throw new TypeError('[EventBus] emit() requires a finite numeric `now`');
    }
    const isInternal = eventName.startsWith('__bus:');

    // Whitelist / unknown event handling (skipped for internal events).
    if (!isInternal) {
      const whitelist = this.config.eventWhitelist;
      const isWhitelisted = whitelist && whitelist instanceof Set ? whitelist.has(eventName) : true;
      if (!isWhitelisted || (!this.config.allowUnknownEvents && !this._listeners.has(eventName))) {
        this._enqueueInternal(INTERNAL_EVENTS.UNKNOWN_EVENT, { eventName, source: source || 'unknown' }, now);
        // We still emit the original event; the warning is informational.
      }
    }

    // Resolve priority defensively.
    let priorityKey = priority || this.config.defaultPriority;
    let priorityFallback = null;
    if (!PRIORITY_VALUES[priorityKey]) {
      priorityFallback = priorityKey;
      priorityKey = this.config.defaultPriority;
    }

    // Horizontal fan-out check (only when emit() is called from inside a handler).
    if (this._processing && this._currentHandlerEmits >= this.config.maxFanOutPerHandler) {
      this._recordDrop(eventName, 'max_fan_out_exceeded', now);
      return false;
    }

    // Clone payload defensively so callers cannot mutate it post-emit. The clone
    // is then deep-frozen at dispatch time and shared across listeners (frozen
    // objects are safe to share).
    let clonedPayload;
    try {
      clonedPayload = safeDeepClone(payload);
    } catch (err) {
      this._recordDrop(eventName, 'payload_clone_failed', now, { error: String(err && err.message) });
      return false;
    }

    const event = {
      eventName,
      payload: clonedPayload,
      priority: priorityKey,
      priorityValue: PRIORITY_VALUES[priorityKey],
      priorityFallback,
      timestamp: now,
      source: source || 'unknown',
      processingDepth: this._currentDepth,
      isInternal,
    };

    const accepted = this._enqueue(event, now);
    if (!accepted) return false;

    this._totalEventsEmitted++;
    if (this._processing) this._currentHandlerEmits++;
    this._version++;

    if (!this._processing) this._processQueue(now);
    return true;
  }

  /**
   * Emit a batch atomically: all events are enqueued before any dispatch happens.
   * Order within the batch is preserved within each priority bucket.
   */
  emitBatch(events, now) {
    this._assertAlive();
    if (!Array.isArray(events)) {
      throw new TypeError('[EventBus] emitBatch requires an array of events');
    }
    if (!isFiniteNumber(now)) {
      throw new TypeError('[EventBus] emitBatch requires a finite numeric `now`');
    }
    // Suspend processing so the for loop never triggers _processQueue mid-batch.
    const wasProcessing = this._processing;
    this._processing = true;
    let accepted = 0;
    try {
      for (const ev of events) {
        if (!ev || typeof ev.eventName !== 'string') continue;
        const ok = this.emit(ev.eventName, ev.payload, now, ev.priority, ev.source);
        if (ok) accepted++;
      }
    } finally {
      this._processing = wasProcessing;
    }
    if (!this._processing) this._processQueue(now);
    return accepted;
  }

  // ------------------------------------------------------------------
  // Public API – diagnostics & lifecycle
  // ------------------------------------------------------------------

  /**
   * Return event history in chronological order (oldest first).
   */
  getEventHistory() {
    const out = new Array(this._historyCount);
    if (this._historyCount === 0) return out;
    const size = this.config.maxHistorySize;
    // When count < size, entries live at indices [0 .. count-1].
    // When count === size, the oldest entry is at _historyWriteIndex.
    const start = this._historyCount < size ? 0 : this._historyWriteIndex;
    for (let i = 0; i < this._historyCount; i++) {
      out[i] = safeDeepClone(this._history[(start + i) % size]);
    }
    return out;
  }

  /**
   * Clear event history (listeners and queue are preserved).
   */
  clearEventHistory() {
    this._history = new Array(this.config.maxHistorySize);
    this._historyWriteIndex = 0;
    this._historyCount = 0;
    this._version++;
  }

  /**
   * Rich diagnostics snapshot. Cheap to call (O(1) for counts; only the
   * eventTypes array allocation is O(k) where k = unique event names).
   */
  getDiagnostics(_now) {
    let totalListeners = 0;
    for (const map of this._listeners.values()) totalListeners += map.size;

    const lastEvent = this._historyCount === 0
      ? null
      : (() => {
          const size = this.config.maxHistorySize;
          const lastIdx = (this._historyWriteIndex - 1 + size) % size;
          return safeDeepClone(this._history[lastIdx]);
        })();

    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      version: this._version,
      totalEventsEmitted: this._totalEventsEmitted,
      droppedEvents: this._droppedEvents,
      handlerErrors: this._totalHandlerErrors,
      queueSize: this._queueSize,
      queueBuckets: {
        CRITICAL: this._buckets.CRITICAL.length,
        HIGH: this._buckets.HIGH.length,
        NORMAL: this._buckets.NORMAL.length,
        LOW: this._buckets.LOW.length,
      },
      processingActive: this._processing,
      currentDepth: this._currentDepth,
      totalListeners,
      eventTypes: Array.from(this._listeners.keys()),
      historySize: this._historyCount,
      lastEvent,
      disposed: this._disposed,
      config: this.config,
    };
  }

  /**
   * Reset queue / history / counters. Version is preserved (monotonic across resets).
   * Listeners are NOT cleared by default; pass { clearListeners: true } to drop them.
   * Emits __bus:reset before mutating so subscribers can flush.
   */
  reset(now, options = {}) {
    this._assertAlive();
    // Emit reset synchronously through the regular pipeline so observers see it
    // before listeners get removed.
    if (this._listeners.has(INTERNAL_EVENTS.RESET)) {
      try {
        this._dispatchInline(INTERNAL_EVENTS.RESET, { clearListeners: !!options.clearListeners }, now);
      } catch (_) {
        // dispatch errors are recorded internally
      }
    }
    this._buckets.CRITICAL.length = 0;
    this._buckets.HIGH.length = 0;
    this._buckets.NORMAL.length = 0;
    this._buckets.LOW.length = 0;
    this._queueSize = 0;
    this._processing = false;
    this._currentDepth = 0;
    this._currentHandlerEmits = 0;
    this._history = new Array(this.config.maxHistorySize);
    this._historyWriteIndex = 0;
    this._historyCount = 0;
    this._droppedEvents = 0;
    this._totalEventsEmitted = 0;
    this._totalHandlerErrors = 0;
    if (options.clearListeners) {
      this._listeners.clear();
    }
    this._version++;
  }

  /**
   * Tear down the bus. After dispose() any further API call throws.
   * Intended for per-session buses managed by session-orchestrator.
   */
  dispose() {
    if (this._disposed) return;
    this._listeners.clear();
    this._buckets.CRITICAL.length = 0;
    this._buckets.HIGH.length = 0;
    this._buckets.NORMAL.length = 0;
    this._buckets.LOW.length = 0;
    this._queueSize = 0;
    this._history = new Array(0);
    this._historyWriteIndex = 0;
    this._historyCount = 0;
    this._processing = false;
    this._disposed = true;
  }

  // ------------------------------------------------------------------
  // Public API – snapshot / restore
  // ------------------------------------------------------------------

  /**
   * Serializable snapshot. Listeners are NOT included (they hold function refs).
   */
  snapshot() {
    this._assertAlive();
    const queueSnapshot = [];
    // Serialize in priority order to make the snapshot deterministic regardless
    // of bucket internals.
    for (const key of ['CRITICAL', 'HIGH', 'NORMAL', 'LOW']) {
      for (const ev of this._buckets[key]) {
        queueSnapshot.push({
          eventName: ev.eventName,
          payload: safeDeepClone(ev.payload),
          priority: ev.priority,
          priorityValue: ev.priorityValue,
          timestamp: ev.timestamp,
          source: ev.source,
          processingDepth: ev.processingDepth,
          isInternal: ev.isInternal === true,
        });
      }
    }
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      version: this._version,
      totalEventsEmitted: this._totalEventsEmitted,
      droppedEvents: this._droppedEvents,
      handlerErrors: this._totalHandlerErrors,
      queue: queueSnapshot,
      history: this.getEventHistory(), // already chronological + deep-cloned
      historyWriteIndex: this._historyWriteIndex,
      historyCount: this._historyCount,
      config: this.config,
    };
  }

  /**
   * Restore from a snapshot. Listeners are NOT restored. Performs deep clone so
   * mutating the snapshot post-restore (or restoring the same snapshot twice)
   * cannot affect this bus.
   */
  restore(snapshot, _now) {
    this._assertAlive();
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `[EventBus] snapshot schemaVersion mismatch: expected ${SNAPSHOT_SCHEMA_VERSION}, got ${snapshot.schemaVersion}`
      );
    }

    // Monotonic version: never go backwards.
    this._version = Math.max(this._version, snapshot.version || 1) + 1;
    this._totalEventsEmitted = snapshot.totalEventsEmitted || 0;
    this._droppedEvents = snapshot.droppedEvents || 0;
    this._totalHandlerErrors = snapshot.handlerErrors || 0;

    // Reset buckets and re-insert from snapshot.queue.
    this._buckets.CRITICAL.length = 0;
    this._buckets.HIGH.length = 0;
    this._buckets.NORMAL.length = 0;
    this._buckets.LOW.length = 0;
    this._queueSize = 0;

    for (const ev of (snapshot.queue || [])) {
      const priorityKey = PRIORITY_VALUES[ev.priority] ? ev.priority : this.config.defaultPriority;
      const restored = {
        eventName: ev.eventName,
        payload: safeDeepClone(ev.payload),
        priority: priorityKey,
        priorityValue: PRIORITY_VALUES[priorityKey],
        priorityFallback: null,
        timestamp: ev.timestamp,
        source: ev.source,
        processingDepth: ev.processingDepth || 0,
        isInternal: ev.isInternal === true,
      };
      this._buckets[priorityKey].push(restored);
      this._queueSize++;
    }

    // Restore history with deep clone; rebuild ring state.
    const size = this.config.maxHistorySize;
    this._history = new Array(size);
    const hist = Array.isArray(snapshot.history) ? snapshot.history : [];
    const count = Math.min(hist.length, size);
    for (let i = 0; i < count; i++) {
      this._history[i] = safeDeepClone(hist[i]);
    }
    this._historyCount = count;
    // After restore the next write goes at index `count % size`; this preserves
    // chronological order on subsequent reads.
    this._historyWriteIndex = count % size;

    this._processing = false;
    this._currentDepth = 0;
    this._currentHandlerEmits = 0;
  }

  // ------------------------------------------------------------------
  // Private – queue
  // ------------------------------------------------------------------

  _enqueue(event, now) {
    if (this._queueSize >= this.config.maxQueueSize) {
      switch (this.config.queueDropPolicy) {
        case 'throw':
          throw new Error('[EventBus] queue full');
        case 'drop-newest':
          this._recordDrop(event.eventName, 'queue_full_drop_newest', now);
          return false;
        case 'drop-oldest-low-priority':
        default: {
          // Try evicting one event from the lowest non-empty bucket whose
          // priority is strictly lower than the incoming event.
          const order = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'];
          let evicted = false;
          for (const key of order) {
            if (PRIORITY_VALUES[key] >= event.priorityValue) break;
            const bucket = this._buckets[key];
            if (bucket.length > 0) {
              const dropped = bucket.shift();
              this._queueSize--;
              this._recordDrop(dropped.eventName, 'queue_full_evicted', now);
              evicted = true;
              break;
            }
          }
          if (!evicted) {
            // Nothing lower-priority to drop; drop the incoming event.
            this._recordDrop(event.eventName, 'queue_full_no_victim', now);
            return false;
          }
        }
      }
    }
    this._buckets[event.priority].push(event);
    this._queueSize++;
    return true;
  }

  _enqueueInternal(eventName, payload, now) {
    // Internal events bypass the whitelist but still go through the queue so
    // listeners (e.g. logger-v2) can subscribe.
    const event = {
      eventName,
      payload: safeDeepClone(payload),
      priority: 'HIGH',
      priorityValue: PRIORITY_VALUES.HIGH,
      priorityFallback: null,
      timestamp: now,
      source: 'event_bus',
      processingDepth: this._currentDepth,
      isInternal: true,
    };
    if (this._queueSize < this.config.maxQueueSize) {
      this._buckets.HIGH.push(event);
      this._queueSize++;
    }
  }

  _dequeue() {
    if (this._buckets.CRITICAL.length > 0) { this._queueSize--; return this._buckets.CRITICAL.shift(); }
    if (this._buckets.HIGH.length     > 0) { this._queueSize--; return this._buckets.HIGH.shift();     }
    if (this._buckets.NORMAL.length   > 0) { this._queueSize--; return this._buckets.NORMAL.shift();   }
    if (this._buckets.LOW.length      > 0) { this._queueSize--; return this._buckets.LOW.shift();      }
    return null;
  }

  // ------------------------------------------------------------------
  // Private – processing
  // ------------------------------------------------------------------

  _processQueue(now) {
    if (this._processing) return;
    this._processing = true;
    try {
      while (this._queueSize > 0) {
        const event = this._dequeue();
        if (!event) break;

        const newDepth = (event.processingDepth || 0) + 1;
        if (newDepth > this.config.maxChainDepth) {
          this._recordDrop(event.eventName, 'max_chain_depth_exceeded', now);
          continue;
        }

        const previousDepth = this._currentDepth;
        const previousHandlerEmits = this._currentHandlerEmits;
        this._currentDepth = newDepth;

        // Freeze the payload once; all listeners share the frozen instance.
        const payload = this.config.freezePayloads ? deepFreeze(event.payload) : event.payload;

        // Snapshot listener set so registrations/removals inside a handler do
        // not affect the current dispatch round.
        const map = this._listeners.get(event.eventName);
        const listeners = map ? Array.from(map.values()) : [];

        let triggeredCount = 0;
        let errorCount = 0;
        const meta = Object.freeze({
          eventName: event.eventName,
          timestamp: event.timestamp,
          source: event.source,
          priority: event.priority,
          version: this._version,
        });

        for (const record of listeners) {
          this._currentHandlerEmits = 0;
          try {
            record.handler(payload, meta);
            triggeredCount++;
          } catch (err) {
            errorCount++;
            this._totalHandlerErrors++;
            if (this.config.emitHandlerErrors && event.eventName !== INTERNAL_EVENTS.HANDLER_ERROR) {
              this._enqueueInternal(
                INTERNAL_EVENTS.HANDLER_ERROR,
                {
                  eventName: event.eventName,
                  source: event.source,
                  owner: record.owner || null,
                  error: {
                    message: err && err.message ? String(err.message) : String(err),
                    name: err && err.name ? String(err.name) : 'Error',
                    stack: err && err.stack ? String(err.stack) : null,
                  },
                },
                now
              );
            }
          }
        }

        this._appendHistory({
          type: event.eventName,
          payload: event.payload,
          timestamp: event.timestamp,
          source: event.source,
          priority: event.priority,
          priorityFallback: event.priorityFallback,
          listenersAttempted: listeners.length,
          listenersTriggered: triggeredCount,
          handlerErrors: errorCount,
          processingDepth: newDepth,
          isInternal: event.isInternal === true,
        });

        this._currentDepth = previousDepth;
        this._currentHandlerEmits = previousHandlerEmits;
      }
    } finally {
      this._processing = false;
    }
  }

  // Synchronous, in-line dispatch used only by reset() so subscribers can react
  // before state is torn down. Bypasses the queue; obeys listener-set snapshot.
  _dispatchInline(eventName, payload, now) {
    const map = this._listeners.get(eventName);
    if (!map) return;
    const listeners = Array.from(map.values());
    const frozen = this.config.freezePayloads ? deepFreeze(safeDeepClone(payload)) : payload;
    const meta = Object.freeze({
      eventName,
      timestamp: now,
      source: 'event_bus',
      priority: 'HIGH',
      version: this._version,
    });
    for (const record of listeners) {
      try {
        record.handler(frozen, meta);
      } catch (_) {
        this._totalHandlerErrors++;
      }
    }
  }

  // ------------------------------------------------------------------
  // Private – history / drops
  // ------------------------------------------------------------------

  _appendHistory(entry) {
    const size = this.config.maxHistorySize;
    if (size === 0) return;
    this._history[this._historyWriteIndex] = entry;
    this._historyWriteIndex = (this._historyWriteIndex + 1) % size;
    if (this._historyCount < size) this._historyCount++;
  }

  _recordDrop(eventName, reason, now, extra) {
    this._droppedEvents++;
    this._appendHistory({
      type: 'EVENT_DROPPED',
      payload: Object.assign({ eventName, reason }, extra || null),
      timestamp: now,
      source: 'event_bus',
      priority: 'HIGH',
      priorityFallback: null,
      listenersAttempted: 0,
      listenersTriggered: 0,
      handlerErrors: 0,
      processingDepth: this._currentDepth,
      isInternal: true,
    });
    // Also emit __bus:event_dropped so observers (logger-v2) can route it.
    if (eventName !== INTERNAL_EVENTS.EVENT_DROPPED) {
      this._enqueueInternal(INTERNAL_EVENTS.EVENT_DROPPED, { eventName, reason }, now);
    }
  }

  // ------------------------------------------------------------------
  // Private – guards
  // ------------------------------------------------------------------

  _assertAlive() {
    if (this._disposed) {
      throw new Error('[EventBus] bus has been disposed');
    }
  }

  _assertHandler(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('[EventBus] handler must be a function');
    }
  }
}

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------

module.exports = {
  InternalBehavioralEventBus,
  DEFAULT_CONFIG,
  PRIORITY_VALUES,
  INTERNAL_EVENTS,
  SNAPSHOT_SCHEMA_VERSION,
};
