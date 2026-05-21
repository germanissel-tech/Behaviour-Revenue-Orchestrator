/**
 * cooldown-fatigue-engine.js
 *
 * Behavioral pacing and fatigue control layer for the OPE system.
 *
 * Responsibilities:
 * - Reduce over-intervention (cooldowns: global, context, product, family, hover, session).
 * - Detect contextual saturation (sliding window per context).
 * - Provide a fatigue score with materialized exponential decay (no monotonic accumulation).
 * - Decompose fatigue: { global, byContext, byFamily } to avoid cross-context contamination.
 * - Repetition protection (deduplicate repeated messageIds within a window).
 * - Atomic acquire/commit/rollback to prevent races between canIntervene and registerIntervention.
 * - Idempotency via messageId deduplication.
 * - Lazy GC of expired cooldowns + manual `pruneExpired(now)`.
 * - LRU eviction (true LRU, not FIFO).
 * - Replay-safe: every public method receives an explicit `now`.
 * - Optional event emission (eventBus) and structured logging (logger-v2 compatible).
 * - Optional integrations: presence + visibility (only count fatigue when message actually seen).
 *
 * No external dependencies, pure JavaScript.
 */

'use strict';

// ----------------------------------------------------------------------
// Schema version (bumped on breaking snapshot changes)
// ----------------------------------------------------------------------
const SNAPSHOT_SCHEMA_VERSION = 2;

// ----------------------------------------------------------------------
// Configuration (frozen)
// ----------------------------------------------------------------------
const DEFAULT_CONFIG = Object.freeze({
  // Minimum time (ms) between any two interventions (global pacing)
  globalCooldownMs: 3000,

  // Context-specific cooldowns (ms)
  contextCooldownMs: Object.freeze({
    listing: 15000,
    modal: 10000,
    hover_cta: 8000,
    product_detail: 12000,
    cart: 20000,
    checkout: 25000,
  }),

  // Granular cooldowns
  productCooldownMs: 60000,
  familyCooldownMs: 45000,
  hoverCooldownMs: 30000,

  // Mini-cooldown re-armed when a bypass family fires (prevents infinite EXIT_RISK spam)
  bypassMiniCooldownMs: 8000,

  // Fatigue scoring parameters
  fatigueInitial: 0,
  fatigueMax: 1.0,

  // Increments (applied AFTER decay materialization)
  dismissalFatigueIncrement: 0.15,
  ignoreFatigueIncrement: 0.08,
  positiveSignalRecovery: -0.1,
  messageShownIncrement: 0.05,

  // Exponential half-life for fatigue decay (ms)
  fatigueHalfLifeMs: 120000, // 2 minutes

  // Distinct half-lives per signal (overrides global half-life when applying that signal)
  halfLifeOverrides: Object.freeze({
    dismissal: 240000, // dismissals "stick" longer than messages
    ignore: 90000,
    messageShown: 120000,
    positive: 60000,
  }),

  // Fatigue composition weights when computing effective fatigue
  // effective = global*wG + byContext[ctx]*wC + byFamily[fam]*wF
  fatigueWeights: Object.freeze({
    global: 0.5,
    context: 0.3,
    family: 0.2,
  }),

  // Saturation thresholds (0-1)
  saturationThreshold: 0.75,

  // Pacing: minimum time between two interventions in the same context (ms)
  pacingMinIntervalMs: 5000,

  // Sliding window: max messages per context
  maxMessagesPerContextWindowMs: 60000,
  maxMessagesPerContext: 3,

  // Density model: messages per minute considered "high"
  highDensityMsgsPerMin: 4,
  highDensityFatigueBonus: 0.03,

  // Session-level
  sessionSoftLimit: 10,
  sessionHardLimit: 20,
  // Whether bypass families can override session_hard_limit (explicit, no longer ambiguous)
  bypassFamiliesCanOverrideHardLimit: false,

  // Priority bypass families (escape product/family/context/fatigue cooldowns)
  priorityBypassFamilies: Object.freeze(['EXIT_RISK', 'PURCHASE_READY']),

  // Repetition protection
  repetitionWindowMs: 180000, // 3 min
  repetitionMaxRecentIds: 50,

  // Idempotency
  idempotencyWindowMs: 5000,
  idempotencyMaxRecentIds: 100,

  // Memory limits (true LRU)
  maxProductMemory: 200,
  maxFamilyMemory: 20,
  maxContextMemory: 20,
  maxHoverMemory: 100,
  maxFatigueByContextMemory: 20,
  maxFatigueByFamilyMemory: 20,

  // Token TTL (for tryAcquire). If commit/rollback not called within this window,
  // token is considered abandoned by getDiagnostics watchdog. Token itself is single-use.
  acquireTokenTtlMs: 10000,

  // Watchdog: warn if saturated for more than this duration without recovery
  saturationWatchdogMs: 600000, // 10 min

  // Diagnostics throttle (returns cached diagnostics within this window)
  diagnosticsCacheMs: 250,
});

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
function exponentialDecay(value, elapsedMs, halfLifeMs) {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return value;
  const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
  return value * decayFactor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function isPlainString(v) {
  return typeof v === 'string' && v.length > 0;
}

// LRU Map: re-inserts on get to maintain recency order.
class LRUMap {
  constructor(maxSize) {
    this._max = Math.max(1, maxSize | 0);
    this._map = new Map();
  }
  get size() {
    return this._map.size;
  }
  has(key) {
    return this._map.has(key);
  }
  get(key) {
    if (!this._map.has(key)) return undefined;
    const v = this._map.get(key);
    // Re-insert to refresh recency
    this._map.delete(key);
    this._map.set(key, v);
    return v;
  }
  peek(key) {
    return this._map.get(key);
  }
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, value);
    if (this._map.size > this._max) {
      // Evict oldest (first inserted = least recently used)
      const oldest = this._map.keys().next().value;
      this._map.delete(oldest);
    }
  }
  delete(key) {
    return this._map.delete(key);
  }
  clear() {
    this._map.clear();
  }
  keys() {
    return this._map.keys();
  }
  values() {
    return this._map.values();
  }
  entries() {
    return this._map.entries();
  }
  toObject() {
    const obj = {};
    for (const [k, v] of this._map.entries()) obj[k] = v;
    return obj;
  }
  loadFromObject(obj) {
    this._map.clear();
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      this._map.set(k, obj[k]);
      if (this._map.size > this._max) {
        const oldest = this._map.keys().next().value;
        this._map.delete(oldest);
      }
    }
  }
  pruneExpired(now) {
    let removed = 0;
    for (const [k, v] of this._map.entries()) {
      if (typeof v === 'number' && v <= now) {
        this._map.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

// Sliding window of timestamps using a deque (Array used as deque via push/shift).
// shift is O(n) in v8 for large arrays, so we use a two-pointer / sparse trim approach:
// keep a head index and only physically compact when head > length/2.
class SlidingWindow {
  constructor(windowMs) {
    this._windowMs = windowMs;
    this._ts = [];
    this._head = 0;
  }
  push(now) {
    this._ts.push(now);
    this._trim(now);
  }
  count(now) {
    this._trim(now);
    return this._ts.length - this._head;
  }
  first(now) {
    this._trim(now);
    if (this._head >= this._ts.length) return null;
    return this._ts[this._head];
  }
  _trim(now) {
    const cutoff = now - this._windowMs;
    while (this._head < this._ts.length && this._ts[this._head] < cutoff) {
      this._head++;
    }
    // Compact periodically to release memory
    if (this._head > 256 && this._head > this._ts.length / 2) {
      this._ts = this._ts.slice(this._head);
      this._head = 0;
    }
  }
  clear() {
    this._ts = [];
    this._head = 0;
  }
  toArray() {
    return this._ts.slice(this._head);
  }
  loadFromArray(arr) {
    this._ts = Array.isArray(arr) ? arr.slice() : [];
    this._head = 0;
  }
  get rawLength() {
    return this._ts.length - this._head;
  }
}

// ----------------------------------------------------------------------
// Block reasons (whitelist for diagnostics + bypass routing)
// ----------------------------------------------------------------------
const BLOCK_REASONS = Object.freeze({
  GLOBAL_COOLDOWN: 'global_cooldown',
  CONTEXT_COOLDOWN: 'context_cooldown',
  PRODUCT_COOLDOWN: 'product_cooldown',
  FAMILY_COOLDOWN: 'family_cooldown',
  HOVER_COOLDOWN: 'hover_cooldown',
  PACING_TOO_RAPID: 'pacing_too_rapid',
  CONTEXT_SATURATION: 'context_saturation',
  HIGH_FATIGUE: 'high_fatigue',
  SESSION_HARD_LIMIT: 'session_hard_limit',
  REPETITION_BLOCKED: 'repetition_blocked',
  IDEMPOTENCY_DUPLICATE: 'idempotency_duplicate',
});

// Which reasons a bypass family is allowed to override.
// session_hard_limit is configurable; pacing & global cooldowns and context_saturation
// are NEVER bypassable (intentional, hard pacing safety).
const BYPASSABLE_REASONS = Object.freeze({
  [BLOCK_REASONS.PRODUCT_COOLDOWN]: true,
  [BLOCK_REASONS.FAMILY_COOLDOWN]: true,
  [BLOCK_REASONS.CONTEXT_COOLDOWN]: true,
  [BLOCK_REASONS.HIGH_FATIGUE]: true,
});

// ----------------------------------------------------------------------
// Main class
// ----------------------------------------------------------------------
class CooldownFatigueEngine {
  /**
   * @param {object} options
   * @param {object} [options.config]      - override of DEFAULT_CONFIG
   * @param {object} [options.eventBus]    - optional { emit(eventName, payload, now, priority, source) }
   * @param {object} [options.logger]      - optional logger-v2 compatible { debug, info, warn, error }
   * @param {string} [options.sessionId]   - optional sessionId for log/event correlation
   */
  constructor(options = {}) {
    const { config = {}, eventBus = null, logger = null, sessionId = null } = options;

    // Deep-frozen config (only DEFAULT_CONFIG inner objects were frozen; freeze the merge result too)
    this.config = Object.freeze({ ...DEFAULT_CONFIG, ...config });

    this._eventBus = eventBus;
    this._logger = logger || noopLogger();
    this._sessionId = sessionId;

    this._disposed = false;

    // Cooldown stores: Map<key, expirationTimestamp>
    // Using LRUMap with high capacity since lazy GC + pruneExpired handle freshness.
    this._cooldowns = new Map();

    // Decomposed fatigue scores (each carries its own "anchor" for decay materialization)
    this._fatigueGlobal = this.config.fatigueInitial;
    this._fatigueGlobalAnchorAt = 0; // last time fatigueGlobal was materialized

    this._fatigueByContext = new LRUMap(this.config.maxFatigueByContextMemory);   // ctx -> { value, anchorAt }
    this._fatigueByFamily = new LRUMap(this.config.maxFatigueByFamilyMemory);     // fam -> { value, anchorAt }

    this._lastInterventionTime = 0;
    this._lastFatigueChangeAt = 0;

    // Per-context last intervention (pacing)
    this._lastContextIntervention = new LRUMap(this.config.maxContextMemory);

    // Per-context sliding window of timestamps
    this._contextMessageHistory = new LRUMap(this.config.maxContextMemory);
    // Note: values inside are SlidingWindow instances

    // Per-product / family / hover last shown (true LRU)
    this._lastProductShown = new LRUMap(this.config.maxProductMemory);
    this._lastFamilyShown = new LRUMap(this.config.maxFamilyMemory);
    this._lastHoverShown = new LRUMap(this.config.maxHoverMemory);

    // Repetition protection (messageId -> lastShownAt)
    this._recentMessageIds = new LRUMap(this.config.repetitionMaxRecentIds);

    // Idempotency dedup (messageId -> processedAt)
    this._idempotencyIds = new LRUMap(this.config.idempotencyMaxRecentIds);

    // Session counters
    this._sessionStartAt = 0;
    this._sessionMessageCount = 0;
    this._sessionDismissals = 0;
    this._sessionIgnores = 0;

    // Saturation watchdog
    this._saturatedSince = 0;
    this._watchdogFiredAt = 0;

    // Tokens for atomic tryAcquire / commit
    this._tokens = new Map(); // tokenId -> { context, productId, family, hoverElementId, now, expiresAt }
    this._tokenCounter = 0;

    // Diagnostics cache
    this._diagnosticsCache = null;
    this._diagnosticsCacheAt = 0;

    this._version = 1;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  _assertAlive() {
    if (this._disposed) {
      throw new Error('CooldownFatigueEngine: instance has been disposed.');
    }
  }

  _emit(eventName, payload, now, priority = 'NORMAL') {
    if (!this._eventBus || typeof this._eventBus.emit !== 'function') return;
    try {
      this._eventBus.emit(
        eventName,
        { sessionId: this._sessionId, ...payload },
        now,
        priority,
        'cooldown-fatigue-engine'
      );
    } catch (err) {
      this._logger.warn?.('[cooldown-fatigue-engine] eventBus.emit failed', {
        eventName,
        error: err?.message,
      });
    }
  }

  _log(level, message, meta) {
    if (!this._logger || typeof this._logger[level] !== 'function') return;
    try {
      this._logger[level](message, { sessionId: this._sessionId, ...(meta || {}) });
    } catch {
      /* swallow */
    }
  }

  _ensureSessionStart(now) {
    if (this._sessionStartAt === 0) this._sessionStartAt = now;
  }

  // Materialize decay on the global fatigue, returns the post-decay value.
  _materializeGlobalDecay(now) {
    if (this._fatigueGlobal <= 0) {
      this._fatigueGlobalAnchorAt = now;
      return 0;
    }
    const elapsedMs = now - this._fatigueGlobalAnchorAt;
    if (elapsedMs > 0) {
      this._fatigueGlobal = exponentialDecay(this._fatigueGlobal, elapsedMs, this.config.fatigueHalfLifeMs);
      this._fatigueGlobalAnchorAt = now;
    }
    return this._fatigueGlobal;
  }

  _materializeBucketDecay(bucketMap, key, now) {
    const entry = bucketMap.peek(key);
    if (!entry) return 0;
    const elapsedMs = now - entry.anchorAt;
    if (elapsedMs > 0) {
      entry.value = exponentialDecay(entry.value, elapsedMs, this.config.fatigueHalfLifeMs);
      entry.anchorAt = now;
      if (entry.value < 1e-6) {
        // GC tiny buckets
        bucketMap.delete(key);
        return 0;
      }
      bucketMap.set(key, entry); // refresh recency in LRU
    }
    return entry.value;
  }

  _addToBucket(bucketMap, key, delta, halfLifeMs, now) {
    // First decay existing bucket
    let entry = bucketMap.peek(key);
    if (entry) {
      const elapsedMs = now - entry.anchorAt;
      if (elapsedMs > 0) {
        entry.value = exponentialDecay(entry.value, elapsedMs, halfLifeMs);
      }
      entry.value = clamp(entry.value + delta, 0, this.config.fatigueMax);
      entry.anchorAt = now;
    } else {
      entry = { value: clamp(delta, 0, this.config.fatigueMax), anchorAt: now };
    }
    if (entry.value <= 0) {
      bucketMap.delete(key);
    } else {
      bucketMap.set(key, entry);
    }
  }

  _applyFatigueChange(delta, halfLifeMs, scope, now) {
    // Materialize first, then add. Anchor stays at `now` after the change.
    this._materializeGlobalDecay(now);
    this._fatigueGlobal = clamp(this._fatigueGlobal + delta, 0, this.config.fatigueMax);
    this._fatigueGlobalAnchorAt = now;
    this._lastFatigueChangeAt = now;

    if (scope?.context) {
      this._addToBucket(this._fatigueByContext, scope.context, delta, halfLifeMs, now);
    }
    if (scope?.family) {
      this._addToBucket(this._fatigueByFamily, scope.family, delta, halfLifeMs, now);
    }

    this._updateSaturationWatchdog(now);
    this._invalidateDiagnostics();
    this._version++;

    this._emit(
      '__cooldown:fatigue_changed',
      {
        delta,
        global: this._fatigueGlobal,
        context: scope?.context || null,
        family: scope?.family || null,
        reason: scope?.reason || null,
      },
      now,
      'LOW'
    );
  }

  _effectiveFatigue(context, family, now) {
    const w = this.config.fatigueWeights;
    const g = this._materializeGlobalDecay(now);
    const c = context ? this._materializeBucketDecay(this._fatigueByContext, context, now) : 0;
    const f = family ? this._materializeBucketDecay(this._fatigueByFamily, family, now) : 0;
    return clamp(g * w.global + c * w.context + f * w.family, 0, this.config.fatigueMax);
  }

  _updateSaturationWatchdog(now) {
    const saturated = this._fatigueGlobal >= this.config.saturationThreshold;
    if (saturated) {
      if (this._saturatedSince === 0) this._saturatedSince = now;
      const duration = now - this._saturatedSince;
      if (duration >= this.config.saturationWatchdogMs && now - this._watchdogFiredAt >= this.config.saturationWatchdogMs) {
        this._watchdogFiredAt = now;
        this._log('warn', '[cooldown-fatigue-engine] saturation watchdog: fatigue >= threshold for too long', {
          fatigueGlobal: this._fatigueGlobal,
          durationMs: duration,
        });
        this._emit('__cooldown:saturation_persistent', {
          fatigueGlobal: this._fatigueGlobal,
          durationMs: duration,
        }, now, 'NORMAL');
      }
    } else {
      this._saturatedSince = 0;
    }
  }

  _invalidateDiagnostics() {
    this._diagnosticsCache = null;
    this._diagnosticsCacheAt = 0;
  }

  _isBypassFamily(family) {
    return this.config.priorityBypassFamilies.includes(family);
  }

  _normalizeContext(context) {
    return isPlainString(context) ? context : 'unknown';
  }

  _normalizeFamily(family) {
    return isPlainString(family) ? family : 'GENERIC';
  }

  _checkIdempotency(messageId, now) {
    if (!messageId) return false;
    const processedAt = this._idempotencyIds.peek(messageId);
    if (processedAt && now - processedAt < this.config.idempotencyWindowMs) {
      return true;
    }
    this._idempotencyIds.set(messageId, now);
    return false;
  }

  _checkRepetition(messageId, now) {
    if (!messageId) return false;
    const lastShownAt = this._recentMessageIds.peek(messageId);
    if (lastShownAt && now - lastShownAt < this.config.repetitionWindowMs) {
      return true;
    }
    return false;
  }

  _markMessageShown(messageId, now) {
    if (!messageId) return;
    this._recentMessageIds.set(messageId, now);
  }

  _newTokenId() {
    this._tokenCounter = (this._tokenCounter + 1) | 0;
    return `tok_${this._sessionId || 'anon'}_${this._tokenCounter}_${this._version}`;
  }

  // ------------------------------------------------------------------
  // Public API: check (read-only)
  // ------------------------------------------------------------------

  /**
   * Checks whether an intervention is allowed.
   *
   * @param {object} params
   * @param {string} params.context
   * @param {string|null} params.productId
   * @param {string} params.family
   * @param {string|null} [params.hoverElementId]
   * @param {string|null} [params.messageId] - if provided, repetition is checked
   * @param {number} params.now
   * @returns {{ allowed: boolean, reason: string|null, bypassed: boolean, effectiveFatigue: number }}
   */
  canIntervene(params) {
    this._assertAlive();
    if (!params || typeof params !== 'object') {
      throw new TypeError('canIntervene: params object required');
    }
    const now = params.now;
    if (!Number.isFinite(now)) {
      throw new TypeError('canIntervene: now must be a finite number');
    }
    this._ensureSessionStart(now);

    const context = this._normalizeContext(params.context);
    const family = this._normalizeFamily(params.family);
    const productId = params.productId || null;
    const hoverElementId = params.hoverElementId || null;
    const messageId = params.messageId || null;
    const isBypass = this._isBypassFamily(family);

    // 0. Repetition (never bypassable: same message shown twice is always bad UX)
    if (this._checkRepetition(messageId, now)) {
      return {
        allowed: false,
        reason: BLOCK_REASONS.REPETITION_BLOCKED,
        bypassed: false,
        effectiveFatigue: this._effectiveFatigue(context, family, now),
      };
    }

    // 1. Global cooldown (NEVER bypassable - hard pacing)
    const globalExpires = this._cooldowns.get('global');
    if (globalExpires && now < globalExpires) {
      return {
        allowed: false,
        reason: BLOCK_REASONS.GLOBAL_COOLDOWN,
        bypassed: false,
        effectiveFatigue: this._effectiveFatigue(context, family, now),
      };
    }

    // 2. Context cooldown
    const contextKey = `context:${context}`;
    const contextExpires = this._cooldowns.get(contextKey);
    if (contextExpires && now < contextExpires) {
      if (!isBypass) {
        return {
          allowed: false,
          reason: BLOCK_REASONS.CONTEXT_COOLDOWN,
          bypassed: false,
          effectiveFatigue: this._effectiveFatigue(context, family, now),
        };
      }
    }

    // 3. Product cooldown
    if (productId) {
      const productExpires = this._cooldowns.get(`product:${productId}`);
      if (productExpires && now < productExpires) {
        if (!isBypass) {
          return {
            allowed: false,
            reason: BLOCK_REASONS.PRODUCT_COOLDOWN,
            bypassed: false,
            effectiveFatigue: this._effectiveFatigue(context, family, now),
          };
        }
      }
    }

    // 4. Family cooldown
    const familyExpires = this._cooldowns.get(`family:${family}`);
    if (familyExpires && now < familyExpires) {
      if (!isBypass) {
        return {
          allowed: false,
          reason: BLOCK_REASONS.FAMILY_COOLDOWN,
          bypassed: false,
          effectiveFatigue: this._effectiveFatigue(context, family, now),
        };
      }
    }

    // 5. Hover cooldown (now implemented)
    if (hoverElementId) {
      const hoverExpires = this._cooldowns.get(`hover:${hoverElementId}`);
      if (hoverExpires && now < hoverExpires) {
        if (!isBypass) {
          return {
            allowed: false,
            reason: BLOCK_REASONS.HOVER_COOLDOWN,
            bypassed: false,
            effectiveFatigue: this._effectiveFatigue(context, family, now),
          };
        }
      }
    }

    // 6. Pacing (NEVER bypassable)
    const lastContextTime = this._lastContextIntervention.peek(context) || 0;
    if (now - lastContextTime < this.config.pacingMinIntervalMs) {
      return {
        allowed: false,
        reason: BLOCK_REASONS.PACING_TOO_RAPID,
        bypassed: false,
        effectiveFatigue: this._effectiveFatigue(context, family, now),
      };
    }

    // 7. Context saturation (NEVER bypassable - protects against burst storms)
    const slidingWindow = this._contextMessageHistory.peek(context);
    if (slidingWindow) {
      const count = slidingWindow.count(now);
      if (count >= this.config.maxMessagesPerContext) {
        return {
          allowed: false,
          reason: BLOCK_REASONS.CONTEXT_SATURATION,
          bypassed: false,
          effectiveFatigue: this._effectiveFatigue(context, family, now),
        };
      }
    }

    // 8. Fatigue check — uses effective (decayed + decomposed) fatigue, not raw
    const effective = this._effectiveFatigue(context, family, now);
    if (effective >= this.config.saturationThreshold) {
      if (!isBypass) {
        return {
          allowed: false,
          reason: BLOCK_REASONS.HIGH_FATIGUE,
          bypassed: false,
          effectiveFatigue: effective,
        };
      }
    }

    // 9. Session hard limit (configurable bypass)
    if (this._sessionMessageCount >= this.config.sessionHardLimit) {
      if (!isBypass || !this.config.bypassFamiliesCanOverrideHardLimit) {
        return {
          allowed: false,
          reason: BLOCK_REASONS.SESSION_HARD_LIMIT,
          bypassed: false,
          effectiveFatigue: effective,
        };
      }
    }

    // Detect whether any cooldown was bypassed for telemetry
    const bypassed = isBypass && (
      (contextExpires && now < contextExpires) ||
      (productId && this._cooldowns.get(`product:${productId}`) && now < this._cooldowns.get(`product:${productId}`)) ||
      (familyExpires && now < familyExpires) ||
      (hoverElementId && this._cooldowns.get(`hover:${hoverElementId}`) && now < this._cooldowns.get(`hover:${hoverElementId}`)) ||
      (effective >= this.config.saturationThreshold)
    );

    return { allowed: true, reason: null, bypassed: !!bypassed, effectiveFatigue: effective };
  }

  // ------------------------------------------------------------------
  // Public API: atomic acquire / commit / rollback
  // ------------------------------------------------------------------

  /**
   * Atomically reserves an intervention slot. Returns a token to be passed to commit() or rollback().
   * The token reserves immediate-pacing slots (global + pacing) preventing two concurrent acquires
   * from both succeeding between check and commit.
   */
  tryAcquire(params) {
    this._assertAlive();
    const decision = this.canIntervene(params);
    if (!decision.allowed) return { ...decision, token: null };

    const now = params.now;
    const context = this._normalizeContext(params.context);
    const family = this._normalizeFamily(params.family);

    // Provisional pacing reservation (prevents the race window)
    this._cooldowns.set('global', now + this.config.globalCooldownMs);
    this._lastContextIntervention.set(context, now);

    const tokenId = this._newTokenId();
    this._tokens.set(tokenId, {
      context,
      productId: params.productId || null,
      family,
      hoverElementId: params.hoverElementId || null,
      messageId: params.messageId || null,
      now,
      bypassed: decision.bypassed,
      expiresAt: now + this.config.acquireTokenTtlMs,
    });

    return { ...decision, token: tokenId };
  }

  /**
   * Commits a reservation: applies all real cooldowns, fatigue, counters, repetition mark, and idempotency.
   * If `wasSeenByUser === false` (presence/visibility integration), the intervention is NOT counted toward fatigue.
   */
  commit(token, params = {}) {
    this._assertAlive();
    const reservation = this._tokens.get(token);
    if (!reservation) {
      throw new Error('CooldownFatigueEngine.commit: unknown or expired token');
    }
    this._tokens.delete(token);

    const now = Number.isFinite(params.now) ? params.now : reservation.now;
    const wasSeenByUser = params.wasSeenByUser !== false; // default true
    const messageId = params.messageId || reservation.messageId;

    // Idempotency: if same messageId committed within window, skip side-effects
    if (messageId && this._checkIdempotency(messageId, now)) {
      this._log('debug', '[cooldown-fatigue-engine] commit skipped: idempotent duplicate', { messageId });
      return { committed: false, reason: BLOCK_REASONS.IDEMPOTENCY_DUPLICATE };
    }

    const { context, productId, family, hoverElementId, bypassed } = reservation;

    // Confirm/refresh global cooldown (already set in tryAcquire)
    this._cooldowns.set('global', now + this.config.globalCooldownMs);

    // Context cooldown
    const ctxMs = this.config.contextCooldownMs[context] ?? this.config.contextCooldownMs.listing;
    this._cooldowns.set(`context:${context}`, now + ctxMs);

    // Product cooldown
    if (productId) {
      this._cooldowns.set(`product:${productId}`, now + this.config.productCooldownMs);
      this._lastProductShown.set(productId, now);
    }

    // Family cooldown (bypass families get a shorter mini-cooldown to prevent spam, plus their full cooldown)
    this._cooldowns.set(`family:${family}`, now + this.config.familyCooldownMs);
    this._lastFamilyShown.set(family, now);

    // Bypass mini-cooldown: when a bypass family fires, re-arm a short global protection
    // so EXIT_RISK cannot trigger 20 times in a row even though it bypasses other cooldowns.
    if (bypassed || this._isBypassFamily(family)) {
      const miniExpires = now + this.config.bypassMiniCooldownMs;
      const currentGlobal = this._cooldowns.get('global') || 0;
      if (miniExpires > currentGlobal) {
        this._cooldowns.set('global', miniExpires);
      }
      // Also bump family cooldown for the bypass family explicitly
      const familyExpires = this._cooldowns.get(`family:${family}`) || 0;
      const bumpedFamily = now + Math.max(this.config.familyCooldownMs, this.config.bypassMiniCooldownMs * 3);
      if (bumpedFamily > familyExpires) {
        this._cooldowns.set(`family:${family}`, bumpedFamily);
      }
    }

    // Hover cooldown
    if (hoverElementId) {
      this._cooldowns.set(`hover:${hoverElementId}`, now + this.config.hoverCooldownMs);
      this._lastHoverShown.set(hoverElementId, now);
    }

    // Pacing: update last context intervention
    this._lastContextIntervention.set(context, now);

    // Sliding window: only push if seen by user (matches "real exposure")
    if (wasSeenByUser) {
      let sw = this._contextMessageHistory.peek(context);
      if (!sw) {
        sw = new SlidingWindow(this.config.maxMessagesPerContextWindowMs);
        this._contextMessageHistory.set(context, sw);
      }
      sw.push(now);
    }

    // Repetition mark
    this._markMessageShown(messageId, now);

    // Fatigue: only count if message was actually seen by the user
    if (wasSeenByUser) {
      // Base increment
      let fatigueInc = this.config.messageShownIncrement;

      // Density-based bonus (msgs/min over the session, NOT raw count)
      const sessionDurationMin = Math.max((now - this._sessionStartAt) / 60000, 1 / 60); // floor at 1s
      const msgsPerMin = (this._sessionMessageCount + 1) / sessionDurationMin;
      if (msgsPerMin > this.config.highDensityMsgsPerMin) {
        fatigueInc += this.config.highDensityFatigueBonus;
      }

      this._applyFatigueChange(
        fatigueInc,
        this.config.halfLifeOverrides.messageShown,
        { context, family, reason: 'message_shown' },
        now
      );
    }

    // Session counters
    this._sessionMessageCount++;
    this._lastInterventionTime = now;
    this._invalidateDiagnostics();
    this._version++;

    this._emit('__cooldown:intervention_committed', {
      context, productId, family, hoverElementId, messageId,
      wasSeenByUser, bypassed,
      sessionMessageCount: this._sessionMessageCount,
    }, now, 'NORMAL');

    return { committed: true, reason: null };
  }

  /**
   * Releases a token without applying side-effects. Reverts the provisional global cooldown
   * IF no other commit has set a later one in the meantime.
   */
  rollback(token, now) {
    this._assertAlive();
    const reservation = this._tokens.get(token);
    if (!reservation) return { rolledBack: false };
    this._tokens.delete(token);

    // Best-effort: only revert global cooldown if it is still the one we set
    // (i.e. no commit happened after). We can't perfectly revert without an undo log, but
    // we can prune if the current global cooldown equals exactly our provisional value.
    const ourGlobalExpiry = reservation.now + this.config.globalCooldownMs;
    const currentGlobal = this._cooldowns.get('global');
    if (currentGlobal === ourGlobalExpiry) {
      this._cooldowns.delete('global');
    }
    this._log('debug', '[cooldown-fatigue-engine] rollback', { token, context: reservation.context });
    return { rolledBack: true };
  }

  // ------------------------------------------------------------------
  // Public API: dismissal / ignore / positive signals
  // ------------------------------------------------------------------

  registerDismissal({ context = null, productId = null, family = null, messageId = null, now } = {}) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('registerDismissal: now must be a finite number');
    if (messageId && this._checkIdempotency(`dismiss:${messageId}`, now)) return { applied: false };
    this._ensureSessionStart(now);
    const scope = {
      context: context ? this._normalizeContext(context) : null,
      family: family ? this._normalizeFamily(family) : null,
      reason: 'dismissal',
    };
    this._applyFatigueChange(
      this.config.dismissalFatigueIncrement,
      this.config.halfLifeOverrides.dismissal,
      scope,
      now
    );
    this._sessionDismissals++;
    if (productId) this._lastProductShown.set(productId, now);
    this._emit('__cooldown:dismissal', { context: scope.context, family: scope.family, productId, messageId }, now, 'LOW');
    return { applied: true };
  }

  registerIgnore({ context = null, productId = null, family = null, messageId = null, now } = {}) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('registerIgnore: now must be a finite number');
    if (messageId && this._checkIdempotency(`ignore:${messageId}`, now)) return { applied: false };
    this._ensureSessionStart(now);
    const scope = {
      context: context ? this._normalizeContext(context) : null,
      family: family ? this._normalizeFamily(family) : null,
      reason: 'ignore',
    };
    this._applyFatigueChange(
      this.config.ignoreFatigueIncrement,
      this.config.halfLifeOverrides.ignore,
      scope,
      now
    );
    this._sessionIgnores++;
    this._emit('__cooldown:ignore', { context: scope.context, family: scope.family, productId, messageId }, now, 'LOW');
    return { applied: true };
  }

  registerPositiveSignal({ context = null, family = null, now } = {}) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('registerPositiveSignal: now must be a finite number');
    this._ensureSessionStart(now);
    const scope = {
      context: context ? this._normalizeContext(context) : null,
      family: family ? this._normalizeFamily(family) : null,
      reason: 'positive_signal',
    };
    this._applyFatigueChange(
      this.config.positiveSignalRecovery,
      this.config.halfLifeOverrides.positive,
      scope,
      now
    );
    this._emit('__cooldown:positive_signal', { context: scope.context, family: scope.family }, now, 'LOW');
    return { applied: true };
  }

  // ------------------------------------------------------------------
  // Public API: read-only views
  // ------------------------------------------------------------------

  getFatigueScore(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('getFatigueScore: now must be a finite number');
    return this._materializeGlobalDecay(now);
  }

  getEffectiveFatigue(context, family, now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('getEffectiveFatigue: now must be a finite number');
    return this._effectiveFatigue(this._normalizeContext(context), this._normalizeFamily(family), now);
  }

  getFatigueBreakdown(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('getFatigueBreakdown: now must be a finite number');
    const global = this._materializeGlobalDecay(now);
    const byContext = {};
    for (const ctx of this._fatigueByContext.keys()) {
      byContext[ctx] = this._materializeBucketDecay(this._fatigueByContext, ctx, now);
    }
    const byFamily = {};
    for (const fam of this._fatigueByFamily.keys()) {
      byFamily[fam] = this._materializeBucketDecay(this._fatigueByFamily, fam, now);
    }
    return { global, byContext, byFamily };
  }

  getCooldownState(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('getCooldownState: now must be a finite number');
    const result = {
      global: this._cooldowns.get('global') || null,
      contexts: [],
      products: [],
      families: [],
      hovers: [],
    };
    for (const [key, expires] of this._cooldowns.entries()) {
      if (expires <= now) continue;
      if (key === 'global') continue;
      if (key.startsWith('context:')) result.contexts.push({ context: key.slice(8), expires });
      else if (key.startsWith('product:')) result.products.push({ productId: key.slice(8), expires });
      else if (key.startsWith('family:')) result.families.push({ family: key.slice(7), expires });
      else if (key.startsWith('hover:')) result.hovers.push({ elementId: key.slice(6), expires });
    }
    return result;
  }

  getDiagnostics(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('getDiagnostics: now must be a finite number');
    if (this._diagnosticsCache && now - this._diagnosticsCacheAt < this.config.diagnosticsCacheMs) {
      return this._diagnosticsCache;
    }
    const fatigueNow = this._materializeGlobalDecay(now);
    const breakdown = this.getFatigueBreakdown(now);
    const activeCooldowns = this.getCooldownState(now);

    const contexts = [];
    for (const ctx of this._contextMessageHistory.keys()) {
      const sw = this._contextMessageHistory.peek(ctx);
      contexts.push({ context: ctx, recentMessages: sw ? sw.count(now) : 0 });
    }

    const sessionDurationMs = this._sessionStartAt > 0 ? now - this._sessionStartAt : 0;
    const msgsPerMin = sessionDurationMs > 0
      ? (this._sessionMessageCount * 60000) / sessionDurationMs
      : 0;

    const diag = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      fatigueScore: fatigueNow,
      fatigueRaw: this._fatigueGlobal,
      fatigueBreakdown: breakdown,
      saturated: fatigueNow >= this.config.saturationThreshold,
      saturatedDurationMs: this._saturatedSince > 0 ? now - this._saturatedSince : 0,
      sessionMessageCount: this._sessionMessageCount,
      sessionDismissals: this._sessionDismissals,
      sessionIgnores: this._sessionIgnores,
      sessionDurationMs,
      messagesPerMinute: msgsPerMin,
      activeCooldowns,
      contextMessageHistories: contexts,
      lastInterventionTime: this._lastInterventionTime,
      lastFatigueChangeAt: this._lastFatigueChangeAt,
      pendingTokens: this._tokens.size,
      recentMessageIds: this._recentMessageIds.size,
      version: this._version,
    };
    this._diagnosticsCache = diag;
    this._diagnosticsCacheAt = now;
    return diag;
  }

  // ------------------------------------------------------------------
  // Public API: GC / maintenance
  // ------------------------------------------------------------------

  /**
   * Purges expired cooldowns, expired tokens, and decayed-to-zero fatigue buckets.
   * Safe to call from a scheduler at low frequency.
   */
  pruneExpired(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('pruneExpired: now must be a finite number');

    let removedCooldowns = 0;
    for (const [k, v] of this._cooldowns.entries()) {
      if (v <= now) {
        this._cooldowns.delete(k);
        removedCooldowns++;
      }
    }

    let removedTokens = 0;
    for (const [k, tok] of this._tokens.entries()) {
      if (tok.expiresAt <= now) {
        this._tokens.delete(k);
        removedTokens++;
        this._log('warn', '[cooldown-fatigue-engine] token TTL expired without commit/rollback', {
          token: k,
          context: tok.context,
          family: tok.family,
        });
      }
    }

    // Decay buckets to release tiny values
    for (const ctx of Array.from(this._fatigueByContext.keys())) {
      this._materializeBucketDecay(this._fatigueByContext, ctx, now);
    }
    for (const fam of Array.from(this._fatigueByFamily.keys())) {
      this._materializeBucketDecay(this._fatigueByFamily, fam, now);
    }

    this._invalidateDiagnostics();
    return { removedCooldowns, removedTokens };
  }

  reset(now) {
    this._assertAlive();
    if (!Number.isFinite(now)) throw new TypeError('reset: now must be a finite number');
    this._cooldowns.clear();
    this._fatigueGlobal = this.config.fatigueInitial;
    this._fatigueGlobalAnchorAt = now;
    this._fatigueByContext.clear();
    this._fatigueByFamily.clear();
    this._lastInterventionTime = 0;
    this._lastFatigueChangeAt = 0;
    this._lastContextIntervention.clear();
    this._contextMessageHistory.clear();
    this._lastProductShown.clear();
    this._lastFamilyShown.clear();
    this._lastHoverShown.clear();
    this._recentMessageIds.clear();
    this._idempotencyIds.clear();
    this._sessionStartAt = 0;
    this._sessionMessageCount = 0;
    this._sessionDismissals = 0;
    this._sessionIgnores = 0;
    this._saturatedSince = 0;
    this._watchdogFiredAt = 0;
    this._tokens.clear();
    this._tokenCounter = 0;
    this._invalidateDiagnostics();
    this._version++;
    this._emit('__cooldown:reset', {}, now, 'NORMAL');
  }

  dispose() {
    if (this._disposed) return;
    this._cooldowns.clear();
    this._fatigueByContext.clear();
    this._fatigueByFamily.clear();
    this._lastContextIntervention.clear();
    this._contextMessageHistory.clear();
    this._lastProductShown.clear();
    this._lastFamilyShown.clear();
    this._lastHoverShown.clear();
    this._recentMessageIds.clear();
    this._idempotencyIds.clear();
    this._tokens.clear();
    this._diagnosticsCache = null;
    this._eventBus = null;
    this._logger = noopLogger();
    this._disposed = true;
  }

  // ------------------------------------------------------------------
  // Public API: snapshot / restore (versioned)
  // ------------------------------------------------------------------

  snapshot() {
    this._assertAlive();

    const cooldownsObj = {};
    for (const [k, v] of this._cooldowns.entries()) cooldownsObj[k] = v;

    const fatigueByContextObj = {};
    for (const [k, v] of this._fatigueByContext.entries()) {
      fatigueByContextObj[k] = { value: v.value, anchorAt: v.anchorAt };
    }
    const fatigueByFamilyObj = {};
    for (const [k, v] of this._fatigueByFamily.entries()) {
      fatigueByFamilyObj[k] = { value: v.value, anchorAt: v.anchorAt };
    }

    const contextHistoryObj = {};
    for (const [k, sw] of this._contextMessageHistory.entries()) {
      contextHistoryObj[k] = sw.toArray();
    }

    return {
      __schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      cooldowns: cooldownsObj,
      fatigueGlobal: this._fatigueGlobal,
      fatigueGlobalAnchorAt: this._fatigueGlobalAnchorAt,
      fatigueByContext: fatigueByContextObj,
      fatigueByFamily: fatigueByFamilyObj,
      lastInterventionTime: this._lastInterventionTime,
      lastFatigueChangeAt: this._lastFatigueChangeAt,
      lastContextIntervention: this._lastContextIntervention.toObject(),
      contextMessageHistory: contextHistoryObj,
      lastProductShown: this._lastProductShown.toObject(),
      lastFamilyShown: this._lastFamilyShown.toObject(),
      lastHoverShown: this._lastHoverShown.toObject(),
      recentMessageIds: this._recentMessageIds.toObject(),
      idempotencyIds: this._idempotencyIds.toObject(),
      sessionStartAt: this._sessionStartAt,
      sessionMessageCount: this._sessionMessageCount,
      sessionDismissals: this._sessionDismissals,
      sessionIgnores: this._sessionIgnores,
      saturatedSince: this._saturatedSince,
      watchdogFiredAt: this._watchdogFiredAt,
      version: this._version,
    };
  }

  /**
   * Restore from a snapshot.
   * @param {object} snapshot
   * @param {number} now - REQUIRED. Used to filter expired cooldowns/tokens.
   */
  restore(snapshot, now) {
    this._assertAlive();
    if (!snapshot || typeof snapshot !== 'object') {
      throw new TypeError('restore: snapshot object required');
    }
    if (!Number.isFinite(now)) {
      throw new TypeError('restore: now is required (finite number)');
    }
    if (snapshot.__schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(
        `restore: snapshot schema version mismatch (expected ${SNAPSHOT_SCHEMA_VERSION}, got ${snapshot.__schemaVersion})`
      );
    }

    // Cooldowns: drop expired
    this._cooldowns.clear();
    for (const [k, v] of Object.entries(snapshot.cooldowns || {})) {
      if (typeof v !== 'number') continue;
      if (v > now) this._cooldowns.set(k, v);
    }

    this._fatigueGlobal = clamp(snapshot.fatigueGlobal ?? 0, 0, this.config.fatigueMax);
    this._fatigueGlobalAnchorAt = snapshot.fatigueGlobalAnchorAt ?? now;

    this._fatigueByContext.clear();
    for (const [k, v] of Object.entries(snapshot.fatigueByContext || {})) {
      if (v && typeof v === 'object' && typeof v.value === 'number' && typeof v.anchorAt === 'number') {
        this._fatigueByContext.set(k, { value: clamp(v.value, 0, this.config.fatigueMax), anchorAt: v.anchorAt });
      }
    }
    this._fatigueByFamily.clear();
    for (const [k, v] of Object.entries(snapshot.fatigueByFamily || {})) {
      if (v && typeof v === 'object' && typeof v.value === 'number' && typeof v.anchorAt === 'number') {
        this._fatigueByFamily.set(k, { value: clamp(v.value, 0, this.config.fatigueMax), anchorAt: v.anchorAt });
      }
    }

    this._lastInterventionTime = snapshot.lastInterventionTime ?? 0;
    this._lastFatigueChangeAt = snapshot.lastFatigueChangeAt ?? 0;

    this._lastContextIntervention.clear();
    this._lastContextIntervention.loadFromObject(snapshot.lastContextIntervention);

    this._contextMessageHistory.clear();
    const windowMs = this.config.maxMessagesPerContextWindowMs;
    for (const [k, arr] of Object.entries(snapshot.contextMessageHistory || {})) {
      const sw = new SlidingWindow(windowMs);
      if (Array.isArray(arr)) {
        // Filter out anything older than the window relative to `now`
        const cutoff = now - windowMs;
        const filtered = arr.filter(ts => typeof ts === 'number' && ts >= cutoff);
        sw.loadFromArray(filtered);
      }
      this._contextMessageHistory.set(k, sw);
    }

    this._lastProductShown.clear();
    this._lastProductShown.loadFromObject(snapshot.lastProductShown);
    this._lastFamilyShown.clear();
    this._lastFamilyShown.loadFromObject(snapshot.lastFamilyShown);
    this._lastHoverShown.clear();
    this._lastHoverShown.loadFromObject(snapshot.lastHoverShown);

    this._recentMessageIds.clear();
    this._recentMessageIds.loadFromObject(snapshot.recentMessageIds);
    this._idempotencyIds.clear();
    this._idempotencyIds.loadFromObject(snapshot.idempotencyIds);

    this._sessionStartAt = snapshot.sessionStartAt ?? 0;
    this._sessionMessageCount = snapshot.sessionMessageCount ?? 0;
    this._sessionDismissals = snapshot.sessionDismissals ?? 0;
    this._sessionIgnores = snapshot.sessionIgnores ?? 0;
    this._saturatedSince = snapshot.saturatedSince ?? 0;
    this._watchdogFiredAt = snapshot.watchdogFiredAt ?? 0;

    // Tokens are NOT restored (in-flight reservations don't survive a restore).
    this._tokens.clear();
    this._tokenCounter = 0;

    this._invalidateDiagnostics();
    this._version = (snapshot.version ?? this._version) + 1;
  }
}

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------
module.exports = {
  CooldownFatigueEngine,
  DEFAULT_CONFIG,
  SNAPSHOT_SCHEMA_VERSION,
  BLOCK_REASONS,
};
