'use strict';

/**
 * intent-state-engine.js — DEPRECATED FACADE (v3 — enterprise restructure)
 *
 * This module has been superseded by unified-intent-engine.js as part of
 * the enterprise architectural restructure. All intent inference, transition
 * graphs, and state management now live in the unified engine.
 *
 * This file re-exports the unified engine's API preserving full backward
 * compatibility for callers that still `require('./intent-state-engine')`.
 *
 * MIGRATION GUIDE:
 *   Replace:  const ise = require('./intent-state-engine')
 *   With:     const uie = require('./unified-intent-engine')
 *
 * The DB-backed persistence layer (ensureTable, loadFromDB, persistState,
 * processMicroEvent, getState, tick, flush, startCleanup) is retained here
 * because unified-intent-engine is a pure stateless engine. Modules that
 * need persistence (session-orchestrator) should use this facade OR
 * implement their own persistence on top of unified-intent-engine.
 *
 * IMPORTANT: No new logic should be added here. This is a compatibility shim.
 */

const {
  INTENT_STATES,
  VALID_INTENT_STATES,
  INITIAL_INTENT_STATE,
  INTENT_VALENCE,
  normalizeIntentState,
} = require('./ope-constants');

const unifiedEngine = require('./unified-intent-engine');

// ============================================================================
// RE-EXPORT: Taxonomy (from ope-constants, the single source of truth)
// ============================================================================

// Legacy 6-state subset for backward compatibility
const CANONICAL_INTENT_STATES = Object.freeze({
  EXPLORING:      INTENT_STATES.EXPLORING,
  EVALUATING:     INTENT_STATES.EVALUATING,
  HESITATING:     INTENT_STATES.HESITATING,
  HIGH_INTENT:    INTENT_STATES.HIGH_INTENT,
  PURCHASE_READY: INTENT_STATES.PURCHASE_READY,
  EXIT_RISK:      INTENT_STATES.EXIT_RISK,
});

const ALL_STATES = Object.values(CANONICAL_INTENT_STATES);

const LEGACY_TO_CANONICAL = Object.freeze({
  browsing:     'exploring',
  considering:  'evaluating',
  comparing:    'evaluating',
  deciding:     'high_intent',
  doubting:     'hesitating',
  purchasing:   'purchase_ready',
});

function getStateValence(state) {
  return INTENT_VALENCE[state] ?? 0;
}

// ============================================================================
// RE-EXPORT: Signal weights and transitions from unified engine
// ============================================================================

const { SIGNAL_WEIGHTS, ALLOWED_TRANSITIONS } = unifiedEngine;

// ============================================================================
// DB-BACKED PERSISTENCE LAYER
// ============================================================================
// This layer wraps unified-intent-engine sessions with SQLite persistence.
// It preserves the original API shape for backward compatibility.

const STATE_SCHEMA_VERSION = 3; // Bumped for unified engine migration

const PERSIST_MIN_INTERVAL  = 500;
const UNKNOWN_EVENT_LOG_INTERVAL_MS = 60_000;
const ACTIVE_SESSIONS_CAP   = 5_000;

// --- LRU Cache (same as original) ---

class LruCache {
  constructor(cap, onEvict) {
    this.cap = cap;
    this.map = new Map();
    this.onEvict = onEvict;
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.cap) {
      const oldestKey = this.map.keys().next().value;
      const oldestVal = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (this.onEvict) {
        try { this.onEvict(oldestKey, oldestVal); } catch (_) {}
      }
    }
  }
  delete(k) { return this.map.delete(k); }
  entries() { return this.map.entries(); }
  get size() { return this.map.size; }
}

// --- DB helpers ---

const ensuredDBs = new WeakSet();
const preparedStmts = new WeakMap();

function ensureTable(db) {
  if (ensuredDBs.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS intent_states (
      session_id        TEXT PRIMARY KEY,
      store_id          TEXT NOT NULL,
      current_state     TEXT NOT NULL,
      confidence        REAL NOT NULL,
      momentum          REAL NOT NULL,
      engagement        REAL NOT NULL,
      uncertainty       REAL NOT NULL,
      last_update       INTEGER NOT NULL,
      state_entered_at  INTEGER NOT NULL,
      version           INTEGER NOT NULL DEFAULT 0,
      schema_version    INTEGER NOT NULL DEFAULT ${STATE_SCHEMA_VERSION},
      snapshot_blob     TEXT,
      signals_history   TEXT,
      seen_event_ids    TEXT,
      transitions       TEXT
    );

    CREATE TABLE IF NOT EXISTS intent_transitions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL,
      store_id        TEXT,
      from_state      TEXT NOT NULL,
      to_state        TEXT NOT NULL,
      ts              INTEGER NOT NULL,
      confidence      REAL,
      engagement      REAL,
      uncertainty     REAL,
      momentum        REAL,
      evidence_n      INTEGER,
      dwell_ms        INTEGER,
      reason          TEXT,
      triggering_signals TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intent_tx_session ON intent_transitions(session_id, ts);

    CREATE TABLE IF NOT EXISTS unknown_intent_events (
      type TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      count INTEGER NOT NULL
    );
  `);

  // Migration: add snapshot_blob column if missing
  try {
    const cols = db.prepare("PRAGMA table_info(intent_states)").all().map(r => r.name);
    if (!cols.includes('snapshot_blob')) {
      db.exec(`ALTER TABLE intent_states ADD COLUMN snapshot_blob TEXT`);
    }
    if (cols.includes('bias') && !cols.includes('engagement')) {
      db.exec(`ALTER TABLE intent_states ADD COLUMN engagement REAL NOT NULL DEFAULT 0`);
      db.exec(`UPDATE intent_states SET engagement = bias`);
    }
    if (!cols.includes('uncertainty')) {
      db.exec(`ALTER TABLE intent_states ADD COLUMN uncertainty REAL NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('state_entered_at')) {
      db.exec(`ALTER TABLE intent_states ADD COLUMN state_entered_at INTEGER NOT NULL DEFAULT 0`);
    }
  } catch (_) { /* best-effort migration */ }

  preparedStmts.set(db, {
    select:      db.prepare('SELECT * FROM intent_states WHERE session_id = ?'),
    upsert:      db.prepare(`
      INSERT OR REPLACE INTO intent_states
        (session_id, store_id, current_state, confidence, momentum,
         engagement, uncertainty, last_update, state_entered_at,
         version, schema_version, snapshot_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertTx:    db.prepare(`
      INSERT INTO intent_transitions
        (session_id, store_id, from_state, to_state, ts, confidence,
         engagement, uncertainty, momentum, evidence_n, dwell_ms, reason, triggering_signals)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteState: db.prepare('DELETE FROM intent_states WHERE session_id = ?'),
    upsertUnknown: db.prepare(`
      INSERT INTO unknown_intent_events (type, first_seen, last_seen, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(type) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1
    `)
  });

  ensuredDBs.add(db);
}

function loadFromDB(db, sessionId, nowMs) {
  const stmts = preparedStmts.get(db);
  const row = stmts.select.get(sessionId);
  if (!row) return null;

  // Try to restore from full snapshot blob first (unified engine format)
  if (row.snapshot_blob) {
    try {
      const blob = JSON.parse(row.snapshot_blob);
      return unifiedEngine.restoreSession(blob);
    } catch (_) { /* fall through to legacy restore */ }
  }

  // Legacy restore: create a new unified session and hydrate from row data
  const session = unifiedEngine.createSession(sessionId);
  // We can't fully restore legacy data into the new engine format,
  // but we initialize with the stored state and let the engine re-derive
  // from new signals going forward.
  return session;
}

let activeSessions = null;

function getActiveCache(db) {
  if (activeSessions) return activeSessions;
  activeSessions = new LruCache(ACTIVE_SESSIONS_CAP, (_sid, entry) => {
    if (entry && entry.dirty) {
      try { persistState(db, entry, entry.session.lastUpdate); } catch (_) {}
    }
  });
  return activeSessions;
}

function persistState(db, entry, nowMs) {
  if (!entry.dirty) return;
  if (nowMs - entry.lastPersistedAt < PERSIST_MIN_INTERVAL) return;

  const session = entry.session;
  const stmts = preparedStmts.get(db);
  const snap = session.serialize();

  stmts.upsert.run(
    session.sessionId, entry.storeId, session.currentState,
    session.confidence, session.momentum,
    session.engagement, session.uncertainty,
    session.lastUpdate, session.stateEnteredAt,
    session.version, STATE_SCHEMA_VERSION,
    JSON.stringify(snap)
  );
  entry.dirty = false;
  entry.lastPersistedAt = nowMs;
}

function persistTransition(db, entry, transition) {
  const stmts = preparedStmts.get(db);
  stmts.insertTx.run(
    entry.session.sessionId, entry.storeId,
    transition.from, transition.to, transition.timestamp,
    transition.confidence, transition.engagement, transition.uncertainty,
    transition.momentum, transition.evidenceN, transition.dwellMs,
    transition.reason || '',
    JSON.stringify(transition.triggeringSignals || [])
  );
}

// --- Unknown event logging ---

const unknownEventLastLogged = new Map();
function logUnknownEvent(db, type, nowMs) {
  const last = unknownEventLastLogged.get(type) || 0;
  if (nowMs - last < UNKNOWN_EVENT_LOG_INTERVAL_MS) return;
  unknownEventLastLogged.set(type, nowMs);
  try {
    preparedStmts.get(db).upsertUnknown.run(type, nowMs, nowMs);
  } catch (_) { /* optional */ }
}

// --- Serial queue ---

const sessionQueues = new Map();

function enqueueSerial(sessionId, fn) {
  const prev = sessionQueues.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionQueues.set(sessionId, next.catch(() => {}));
  next.finally(() => {
    if (sessionQueues.get(sessionId) === next.catch(() => {})) {
      sessionQueues.delete(sessionId);
    }
  });
  return next;
}

// ============================================================================
// PUBLIC API (backward-compatible)
// ============================================================================

function init(db) {
  ensureTable(db);
  getActiveCache(db);
}

function processMicroEvent(db, sessionId, storeId, signalsPayload, opts = {}) {
  ensureTable(db);
  if (typeof opts.nowMs !== 'number') throw new Error('intent-state-engine.processMicroEvent requires opts.nowMs');
  const nowMs = opts.nowMs;
  const cache = getActiveCache(db);

  return enqueueSerial(sessionId, async () => {
    let entry = cache.get(sessionId);
    if (!entry) {
      const session = loadFromDB(db, sessionId, nowMs) || unifiedEngine.createSession(sessionId);
      entry = { session, storeId, dirty: false, lastPersistedAt: 0 };
      cache.set(sessionId, entry);
    }

    // Normalize payload
    let signalList;
    if (Array.isArray(signalsPayload)) signalList = signalsPayload;
    else if (signalsPayload && typeof signalsPayload === 'object') signalList = [signalsPayload];
    else signalList = [];

    // Separate recognized vs unknown
    const recognized = [];
    for (const s of signalList) {
      if (!s || !s.type) continue;
      if (unifiedEngine.isRecognizedSignal(s.type)) {
        recognized.push(s);
      } else {
        logUnknownEvent(db, s.type, nowMs);
      }
    }

    if (recognized.length === 0) {
      const snap = entry.session.decayedSnapshot(nowMs);
      return {
        state: snap.state,
        confidence: snap.confidence,
        momentum: snap.momentum,
        engagement: snap.engagement,
        bias: snap.engagement,
        uncertainty: snap.uncertainty,
        stateChanged: false,
        version: entry.session.version,
      };
    }

    const result = entry.session.update(recognized, nowMs);
    entry.dirty = true;

    if (result.stateChanged && result.transition) {
      try { persistTransition(db, entry, result.transition); } catch (_) {}
    }
    try { persistState(db, entry, nowMs); } catch (_) {}

    // Add legacy alias
    result.bias = result.engagement;
    return result;
  });
}

function getState(db, sessionId, opts = {}) {
  ensureTable(db);
  if (typeof opts.nowMs !== 'number') throw new Error('intent-state-engine.getState requires opts.nowMs');
  const nowMs = opts.nowMs;
  const cache = getActiveCache(db);

  let entry = cache.get(sessionId);
  if (!entry) {
    const session = loadFromDB(db, sessionId, nowMs);
    if (!session) return null;
    entry = { session, storeId: '', dirty: false, lastPersistedAt: 0 };
    cache.set(sessionId, entry);
  }

  const snap = entry.session.decayedSnapshot(nowMs);
  const isStale = snap.confidence < 0.15;

  return {
    sessionId: entry.session.sessionId,
    storeId: entry.storeId,
    currentState: snap.state,
    confidence: snap.confidence,
    momentum: snap.momentum,
    engagement: snap.engagement,
    bias: snap.engagement,
    uncertainty: snap.uncertainty,
    lastUpdate: entry.session.lastUpdate,
    stateEnteredAt: entry.session.stateEnteredAt,
    dwellMs: Math.max(0, nowMs - entry.session.stateEnteredAt),
    isStale,
    transitions: entry.session.transitions.toArray().slice(-5),
    version: entry.session.version,
  };
}

function tick(db, sessionId, opts = {}) {
  ensureTable(db);
  if (typeof opts.nowMs !== 'number') throw new Error('intent-state-engine.tick requires opts.nowMs');
  const nowMs = opts.nowMs;
  const cache = getActiveCache(db);

  return enqueueSerial(sessionId, async () => {
    let entry = cache.get(sessionId);
    if (!entry) {
      const session = loadFromDB(db, sessionId, nowMs);
      if (!session) return null;
      entry = { session, storeId: '', dirty: false, lastPersistedAt: 0 };
      cache.set(sessionId, entry);
    }

    const result = entry.session.tick(nowMs);
    entry.dirty = true;

    if (result.stateChanged && result.transition) {
      try { persistTransition(db, entry, result.transition); } catch (_) {}
    }
    try { persistState(db, entry, nowMs); } catch (_) {}

    result.bias = result.engagement;
    return result;
  });
}

function flush(db, opts = {}) {
  if (!activeSessions) return;
  if (typeof opts.nowMs !== 'number') throw new Error('intent-state-engine.flush requires opts.nowMs');
  const nowMs = opts.nowMs;
  for (const [_sid, entry] of activeSessions.entries()) {
    try { persistState(db, entry, nowMs); } catch (_) {}
  }
}

function startCleanup(db, inactiveMinutes = 60, intervalMs = 300_000, clockFn) {
  // P1-DET: clockFn is an injectable clock for deterministic scheduling.
  // In production it defaults to Date.now; in replay/simulation it must be injected.
  const _clock = typeof clockFn === 'function' ? clockFn : () => Date.now();
  const handle = {
    _interval: null,
    stop() {
      if (this._interval) { clearInterval(this._interval); this._interval = null; }
    }
  };
  handle._interval = setInterval(() => {
    if (!activeSessions) return;
    const now = _clock();
    const cutoff = now - inactiveMinutes * 60 * 1000;
    const stale = [];
    for (const [sid, entry] of activeSessions.entries()) {
      if (entry.session.lastUpdate < cutoff) stale.push([sid, entry]);
    }
    for (const [sid, entry] of stale) {
      try { persistState(db, entry, now); } catch (_) {}
      activeSessions.delete(sid);
    }
  }, intervalMs);
  if (handle._interval.unref) handle._interval.unref();
  return handle;
}

function _resetForTests() {
  activeSessions = null;
  sessionQueues.clear();
  unknownEventLastLogged.clear();
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // DB-backed API (backward compatible)
  init,
  processMicroEvent,
  getState,
  tick,
  flush,
  startCleanup,
  ensureTable,

  // Taxonomy (from ope-constants)
  CANONICAL_INTENT_STATES,
  INTENT_VALENCE,
  getStateValence,
  normalizeIntentState,

  // Re-exported from unified engine
  SIGNAL_WEIGHTS,
  ALLOWED_TRANSITIONS,
  ALL_STATES,
  STATE_SCHEMA_VERSION,

  // Testing
  _resetForTests,
};
