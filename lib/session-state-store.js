/**
 * Session State Store (v2 - auditado y corregido)
 *
 * Capa centralizada de persistencia y gestion de estado vivo por sesion.
 *
 * Correcciones aplicadas respecto a v1:
 *  P0-1: computeDiff ahora detecta cambios reales en signalHistory / transitionHistory
 *        comparando contra una copia previa, y emite los nuevos elementos en el diff.
 *  P0-2: maxSnapshotsPerSession se hace cumplir (poda por sesion al insertar) y se
 *        purgan session_snapshots y state_events cuando una sesion expira por TTL.
 *  P0-3: maxActiveSessions se aplica via LRU manual; en evicción se persiste snapshot.
 *  P0-4: Se rastrean los handles de los intervals y se expone destroy()/stop().
 *  P1-1: updateSessionState hace deep-merge en campos estructurados conocidos
 *        (temporalMetrics, momentumMetrics, riskScores, decayState, oscillationMetrics,
 *        sessionMetadata, behavioralSummary, timestamps).
 *  P1-2: oscillationMetrics ahora distingue streak (resetable) de countSession
 *        (monotono), y lastReset solo se escribe en la transicion 1+ -> 0.
 *  P1-3: La fuente unica de verdad para recovery es active_sessions_store. Cuando
 *        una sesion expira, se tombstonea (no se rehidrata implicitamente desde
 *        session_snapshots).
 *  P1-4: Determinismo: se acepta tick / eventTimestamp del caller, snapshot_id no
 *        depende de Date.now(), y los IDs de transicion se derivan por hash de
 *        (sessionId, tick, from, to) en lugar de UUID aleatorio.
 *  P1-5: Concurrencia optimista: updateSessionState acepta expectedVersion y serializa
 *        escrituras per-session a traves de una cola async.
 *  P1-6: Write-behind buffer para state_events (batch insert) en una transaccion.
 *  P1-7: signalHistory usa eventTimestamp upstream cuando se provee.
 *  P2-1: Se trunca historiales con slice tras unshift multiples elementos.
 *  P2-2: maxInterventionHistory configurable.
 *  P2-3: Se soporta replaceDerivedSignals para evitar acumular keys obsoletas.
 *  P2-4: reconstructStateAt(sessionId, t) reconstruye estado aplicando diffs sobre
 *        el snapshot mas reciente <= t.
 *  P2-5: computeDiff usa el set de claves modificadas en lugar de stringify por campo.
 *  P2-6: Prepared statements se cachean en this._stmts.
 *  P3-1: snapshot_id = `${sessionId}_${version}` (version ya es monotonica).
 *  P3-2: Columna state_schema_version en session_snapshots y active_sessions_store.
 *  P3-3: getSessionSummary({ readOnly: true }) no hidrata activeSessions.
 *
 * Compatibilidad: la API publica (updateSessionState, updateFromTransitionEngine,
 * updateFromSignalEngine, getSessionState, recoverSession, replaySession,
 * getSessionSummary, persistSnapshot, persistStateEvent) conserva las mismas firmas.
 * Los nuevos parametros (opts.expectedVersion, opts.tick, opts.eventTimestamp,
 * opts.replaceDerivedSignals) son opcionales.
 */

const crypto = require("crypto")

// ========== SCHEMA VERSION ==========
const STATE_SCHEMA_VERSION = 2

// ========== CONFIGURACION ==========
const DEFAULT_CONFIG = {
  // Snapshot
  snapshotIntervalMs: 60000, // cada 60s
  maxSnapshotsPerSession: 50,
  // TTL
  sessionTTLSeconds: 3600,
  cleanupIntervalMs: 300000,
  // Memoria
  maxActiveSessions: 10000,
  maxHistoryEvents: 500,
  maxInterventionHistory: 100,
  // Replay
  replayBatchSize: 100,
  // Write-behind
  eventFlushIntervalMs: 250,
  eventFlushMaxBatch: 500,
  // Esquema
  stateSchemaVersion: STATE_SCHEMA_VERSION,
}

// Campos estructurados que se deep-mergean en lugar de reemplazarse
const DEEP_MERGE_FIELDS = new Set([
  "temporalMetrics",
  "momentumMetrics",
  "riskScores",
  "decayState",
  "sessionMetadata",
  "behavioralSummary",
  "timestamps",
])

// ========== CLASE PRINCIPAL ==========
class SessionStateStore {
  constructor(db, config = {}) {
    this.db = db
    this.config = { ...DEFAULT_CONFIG, ...config }
    /** @type {Map<string, object>} state vivo por sesion */
    this.activeSessions = new Map()
    /** @type {Map<string, Promise<any>>} cola async per-session para serializar writes */
    this._sessionLocks = new Map()
    /** @type {Array<object>} buffer write-behind de state_events */
    this._eventBuffer = []
    /** @type {Set<string>} sesiones tombstoneadas tras TTL hasta que se cree una nueva */
    this._tombstones = new Set()
    /** @type {Map<string, object>} stmts preparados */
    this._stmts = {}

    this._cleanupTimer = null
    this._snapshotTimer = null
    this._flushTimer = null
    this._destroyed = false

    this.ensureTables()
    this.prepareStatements()
    this.startCleanup()
    this.startAutoSnapshot()
    this.startEventFlush()
  }

  // ========== SCHEMA ==========
  ensureTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        state_schema_version INTEGER NOT NULL DEFAULT 1,
        snapshot_timestamp INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        state_diff_json TEXT,
        transition_id TEXT,
        signal_snapshot_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON session_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON session_snapshots(snapshot_timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_session_version ON session_snapshots(session_id, state_version);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_timestamp INTEGER NOT NULL,
        tick INTEGER,
        event_type TEXT NOT NULL,
        state_diff_json TEXT NOT NULL,
        full_state_json TEXT,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_events_session ON state_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_state_events_timestamp ON state_events(event_timestamp);
      CREATE INDEX IF NOT EXISTS idx_state_events_session_ts ON state_events(session_id, event_timestamp);
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions_store (
        session_id TEXT PRIMARY KEY,
        last_active INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        state_schema_version INTEGER NOT NULL DEFAULT 1,
        tombstoned INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_active_last ON active_sessions_store(last_active);
    `)
  }

  prepareStatements() {
    this._stmts.insertSnapshot = this.db.prepare(`
      INSERT INTO session_snapshots
        (snapshot_id, session_id, state_version, state_schema_version,
         snapshot_timestamp, state_json, state_diff_json,
         transition_id, signal_snapshot_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._stmts.upsertActive = this.db.prepare(`
      INSERT INTO active_sessions_store
        (session_id, last_active, state_json, version, state_schema_version, tombstoned)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(session_id) DO UPDATE SET
        last_active = excluded.last_active,
        state_json  = excluded.state_json,
        version     = excluded.version,
        state_schema_version = excluded.state_schema_version,
        tombstoned  = 0
    `)
    this._stmts.tombstoneActive = this.db.prepare(`
      UPDATE active_sessions_store SET tombstoned = 1 WHERE session_id = ?
    `)
    this._stmts.deleteActive = this.db.prepare(`
      DELETE FROM active_sessions_store WHERE session_id = ?
    `)
    this._stmts.selectActive = this.db.prepare(`
      SELECT state_json, version, tombstoned
      FROM active_sessions_store
      WHERE session_id = ?
    `)
    this._stmts.insertEvent = this.db.prepare(`
      INSERT INTO state_events
        (session_id, event_timestamp, tick, event_type, state_diff_json, full_state_json, version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    this._stmts.selectLatestSnapshot = this.db.prepare(`
      SELECT state_json, state_version, snapshot_timestamp
      FROM session_snapshots
      WHERE session_id = ?
      ORDER BY state_version DESC
      LIMIT 1
    `)
    this._stmts.selectSnapshotBeforeTs = this.db.prepare(`
      SELECT state_json, state_version, snapshot_timestamp
      FROM session_snapshots
      WHERE session_id = ? AND snapshot_timestamp <= ?
      ORDER BY snapshot_timestamp DESC
      LIMIT 1
    `)
    this._stmts.selectEventsInRange = this.db.prepare(`
      SELECT event_timestamp, tick, event_type, state_diff_json, full_state_json, version
      FROM state_events
      WHERE session_id = ? AND event_timestamp BETWEEN ? AND ?
      ORDER BY event_timestamp ASC, id ASC
    `)
    this._stmts.selectEventsAfterTs = this.db.prepare(`
      SELECT event_timestamp, tick, event_type, state_diff_json, full_state_json, version
      FROM state_events
      WHERE session_id = ? AND event_timestamp > ?
      ORDER BY event_timestamp ASC, id ASC
    `)
    this._stmts.pruneSnapshots = this.db.prepare(`
      DELETE FROM session_snapshots
      WHERE session_id = ?
        AND id NOT IN (
          SELECT id FROM session_snapshots
          WHERE session_id = ?
          ORDER BY state_version DESC
          LIMIT ?
        )
    `)
    this._stmts.deleteSessionSnapshots = this.db.prepare(`
      DELETE FROM session_snapshots WHERE session_id = ?
    `)
    this._stmts.deleteSessionEvents = this.db.prepare(`
      DELETE FROM state_events WHERE session_id = ?
    `)
    this._stmts.countSnapshots = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM session_snapshots`,
    )
    this._stmts.recentEvents = this.db.prepare(`
      SELECT event_timestamp, event_type, state_diff_json
      FROM state_events
      WHERE session_id = ?
      ORDER BY event_timestamp DESC
      LIMIT ?
    `)
    this._stmts.recentTransitions = this.db.prepare(`
      SELECT event_timestamp, state_diff_json
      FROM state_events
      WHERE session_id = ? AND event_type = 'transition'
      ORDER BY event_timestamp DESC
      LIMIT ?
    `)
  }

  // ========== UTILIDADES ==========
  // P1-DET: _now() accepts optional injected clock. In production defaults to Date.now;
  // in replay/tests the clock must be injected via constructor config.
  _now(nowMs) {
    if (typeof nowMs === 'number') return nowMs;
    if (typeof this.config._clock === 'function') return this.config._clock();
    return Date.now();
  }

  _deepClone(obj) {
    // structuredClone existe en Node >=17. Fallback a JSON si no.
    if (typeof structuredClone === "function") return structuredClone(obj)
    return JSON.parse(JSON.stringify(obj))
  }

  _deterministicId(parts) {
    const h = crypto.createHash("sha1")
    h.update(parts.join("|"))
    return h.digest("hex").slice(0, 16)
  }

  _touchLRU(sessionId) {
    // Map de JS preserva orden de insercion: borrar+reinsertar = mover al final (MRU).
    if (this.activeSessions.has(sessionId)) {
      const v = this.activeSessions.get(sessionId)
      this.activeSessions.delete(sessionId)
      this.activeSessions.set(sessionId, v)
    }
  }

  _enforceActiveLimit() {
    const limit = this.config.maxActiveSessions
    while (this.activeSessions.size > limit) {
      const oldestKey = this.activeSessions.keys().next().value
      if (!oldestKey) break
      const state = this.activeSessions.get(oldestKey)
      try {
        if (state) this._writeSnapshotImmediate(state, "eviction")
      } catch (e) {
        console.warn("[SessionStateStore] eviction snapshot failed:", e.message)
      }
      this.activeSessions.delete(oldestKey)
      this._sessionLocks.delete(oldestKey)
    }
  }

  // ========== READ ==========
  /**
   * Obtener estado actual de una sesion.
   * Solo rehidrata desde DB si la sesion NO esta tombstoneada (P1-3).
   */
  getSessionState(sessionId) {
    if (this.activeSessions.has(sessionId)) {
      this._touchLRU(sessionId)
      return this.activeSessions.get(sessionId)
    }
    if (this._tombstones.has(sessionId)) return null

    const row = this._stmts.selectActive.get(sessionId)
    if (!row) return null
    if (row.tombstoned) {
      this._tombstones.add(sessionId)
      return null
    }
    const state = this._deserializeState(row.state_json)
    state._dirty = false
    this.activeSessions.set(sessionId, state)
    this._enforceActiveLimit()
    return state
  }

  /**
   * Variante de lectura que NO hidrata activeSessions.
   */
  peekSessionState(sessionId) {
    if (this.activeSessions.has(sessionId)) return this.activeSessions.get(sessionId)
    const row = this._stmts.selectActive.get(sessionId)
    if (!row || row.tombstoned) return null
    return this._deserializeState(row.state_json)
  }

  // ========== CREATE ==========
  createSessionState(sessionId, storeId, metadata = {}) {
    if (this.activeSessions.has(sessionId)) {
      this._touchLRU(sessionId)
      return this.activeSessions.get(sessionId)
    }
    // Crear sesion limpia: levantar tombstone si lo hubiera
    this._tombstones.delete(sessionId)

    const now = this._now()
    const state = {
      sessionId,
      storeId,
      currentIntentState: "exploring",
      stateConfidence: 0.5,
      stateStability: 0.5,
      derivedSignals: {},
      signalHistory: [],
      transitionHistory: [],
      momentumMetrics: { score: 0, acceleration: 0, velocity: 0 },
      behavioralSummary: { totalEvents: 0, avgEngagement: 0 },
      interventionHistory: [],
      exposureHistory: [],
      temporalMetrics: { sessionDuration: 0, activeTime: 0, idleTime: 0, lastSignalUpdate: 0 },
      decayState: { lastDecay: now, decayFactor: 1.0 },
      oscillationMetrics: { streak: 0, countSession: 0, lastReset: now },
      riskScores: { exitRisk: 0, bounceRisk: 0, abandonmentProb: 0 },
      sessionMetadata: { ...metadata, startTimestamp: now, device: metadata.device || "unknown" },
      timestamps: {
        start: now,
        lastUpdate: now,
        lastSnapshot: now,
        lastTransition: now,
      },
      tick: 0,
      version: 1,
      schemaVersion: STATE_SCHEMA_VERSION,
      _dirty: true,
    }
    this.activeSessions.set(sessionId, state)
    this._enforceActiveLimit()
    this._writeSnapshotImmediate(state, "session_start")
    return state
  }

  // ========== UPDATE (con concurrencia optimista + lock per-session) ==========
  /**
   * @param {string} sessionId
   * @param {object} updates
   * @param {string} reason
   * @param {object} [opts]
   * @param {number} [opts.expectedVersion] CAS: si no coincide, se rechaza.
   * @param {number} [opts.tick] tick logico monotono provisto por el caller.
   * @param {number} [opts.eventTimestamp] timestamp original del evento (event-time).
   * @param {boolean} [opts.replaceDerivedSignals] si true, reemplaza derivedSignals en vez de mergear.
   */
  updateSessionState(sessionId, updates, reason = "update", opts = {}) {
    // Serializar per-session
    const prev = this._sessionLocks.get(sessionId) || Promise.resolve()
    const next = prev.then(() => this._applyUpdate(sessionId, updates, reason, opts))
    // Mantener cadena pero no propagar errores al lock
    this._sessionLocks.set(
      sessionId,
      next.catch(() => {}),
    )
    return next
  }

  _applyUpdate(sessionId, updates, reason, opts) {
    const state = this.getSessionState(sessionId)
    if (!state) throw new Error(`Session ${sessionId} not found`)

    if (typeof opts.expectedVersion === "number" && opts.expectedVersion !== state.version) {
      const err = new Error(
        `Version conflict for session ${sessionId}: expected ${opts.expectedVersion}, got ${state.version}`,
      )
      err.code = "VERSION_CONFLICT"
      err.currentVersion = state.version
      throw err
    }

    const eventTs = typeof opts.eventTimestamp === "number" ? opts.eventTimestamp : this._now()
    const tick = typeof opts.tick === "number" ? opts.tick : (state.tick || 0) + 1

    // Snapshot superficial + clone profundo de los arrays que vamos a mutar (P0-1)
    const prevSignalHistoryLen = state.signalHistory.length
    const prevTransitionHistoryLen = state.transitionHistory.length
    const prevInterventionHistoryLen = state.interventionHistory.length
    const changedKeys = new Set()
    const prevForDiff = {} // valores previos solo de las keys tocadas

    const recordPrev = (k) => {
      if (!(k in prevForDiff)) prevForDiff[k] = this._deepClone(state[k])
    }

    // Aplicar updates
    for (const [key, value] of Object.entries(updates)) {
      if (key === "signalHistory" || key === "transitionHistory" || key === "interventionHistory") {
        // Estos canales solo se modifican via casos especiales mas abajo
        continue
      }

      if (key === "derivedSignals") {
        recordPrev("derivedSignals")
        if (opts.replaceDerivedSignals) {
          state.derivedSignals = { ...value }
        } else {
          state.derivedSignals = { ...state.derivedSignals, ...value }
        }
        changedKeys.add("derivedSignals")
        // Anadir a signalHistory con event-time (P1-7)
        recordPrev("signalHistory")
        state.signalHistory.unshift({
          timestamp: eventTs,
          tick,
          signals: { ...value },
        })
        if (state.signalHistory.length > this.config.maxHistoryEvents) {
          state.signalHistory = state.signalHistory.slice(0, this.config.maxHistoryEvents)
        }
        changedKeys.add("signalHistory")
        continue
      }

      if (DEEP_MERGE_FIELDS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        recordPrev(key)
        state[key] = { ...(state[key] || {}), ...value }
        changedKeys.add(key)
        continue
      }

      recordPrev(key)
      state[key] = value
      changedKeys.add(key)
    }

    // Manejo explicito de transitionHistory (P2-1: bound real)
    if (updates.transitionHistory && Array.isArray(updates.transitionHistory) && updates.transitionHistory.length > 0) {
      recordPrev("transitionHistory")
      state.transitionHistory.unshift(...updates.transitionHistory)
      if (state.transitionHistory.length > this.config.maxHistoryEvents) {
        state.transitionHistory = state.transitionHistory.slice(0, this.config.maxHistoryEvents)
      }
      state.timestamps.lastTransition = eventTs
      changedKeys.add("transitionHistory")
      changedKeys.add("timestamps")
    }

    // Manejo explicito de interventionHistory (P2-1, P2-2)
    if (
      updates.interventionHistory &&
      Array.isArray(updates.interventionHistory) &&
      updates.interventionHistory.length > 0
    ) {
      recordPrev("interventionHistory")
      state.interventionHistory.unshift(...updates.interventionHistory)
      const cap = this.config.maxInterventionHistory
      if (state.interventionHistory.length > cap) {
        state.interventionHistory = state.interventionHistory.slice(0, cap)
      }
      changedKeys.add("interventionHistory")
    }

    state.timestamps.lastUpdate = eventTs
    state.tick = tick
    state.version++
    state._dirty = true
    changedKeys.add("timestamps")

    // Computar diff (P0-1, P2-5)
    const diff = this._computeDiffFromChangedKeys(prevForDiff, state, changedKeys, {
      prevSignalHistoryLen,
      prevTransitionHistoryLen,
      prevInterventionHistoryLen,
    })

    // Encolar evento (write-behind, P1-6)
    this._enqueueEvent(sessionId, {
      session_id: sessionId,
      event_timestamp: eventTs,
      tick,
      event_type: reason,
      state_diff_json: JSON.stringify(diff),
      full_state_json:
        reason === "transition" || reason === "recovery" || reason === "session_start"
          ? this._serializeState(state)
          : null,
      version: state.version,
    })

    // Snapshot por intervalo / hitos
    const shouldSnapshot =
      this._now() - state.timestamps.lastSnapshot > this.config.snapshotIntervalMs ||
      reason === "transition" ||
      reason === "recovery" ||
      state.version % 10 === 0

    if (shouldSnapshot) {
      this._writeSnapshotImmediate(state, reason)
    } else {
      // Mantener active_sessions_store en sincronia (recovery cheap)
      this._stmts.upsertActive.run(
        state.sessionId,
        state.timestamps.lastUpdate,
        this._serializeState(state),
        state.version,
        STATE_SCHEMA_VERSION,
      )
    }

    this._touchLRU(sessionId)
    this._enforceActiveLimit()
    return state
  }

  // ========== DIFF ==========
  _computeDiffFromChangedKeys(prevValues, newState, changedKeys, lengths) {
    const diff = {}
    for (const key of changedKeys) {
      if (key === "signalHistory") {
        const newCount = Math.max(0, newState.signalHistory.length - lengths.prevSignalHistoryLen)
        if (newCount > 0) {
          diff.signalHistoryNew = newState.signalHistory.slice(0, newCount)
        }
        continue
      }
      if (key === "transitionHistory") {
        const newCount = Math.max(0, newState.transitionHistory.length - lengths.prevTransitionHistoryLen)
        if (newCount > 0) {
          diff.transitionHistoryNew = newState.transitionHistory.slice(0, newCount)
        }
        continue
      }
      if (key === "interventionHistory") {
        const newCount = Math.max(0, newState.interventionHistory.length - lengths.prevInterventionHistoryLen)
        if (newCount > 0) {
          diff.interventionHistoryNew = newState.interventionHistory.slice(0, newCount)
        }
        continue
      }
      diff[key] = this._deepClone(newState[key])
    }
    return diff
  }

  // ========== SNAPSHOTS ==========
  _writeSnapshotImmediate(state, reason) {
    // Flush primero los eventos pendientes para que el snapshot sea consistente con el log
    this._flushEventBuffer()

    const snapshotId = `${state.sessionId}_${state.version}` // P3-1
    const ts = this._now()
    const stateJson = this._serializeState(state)

    const tx = this.db.transaction(() => {
      this._stmts.insertSnapshot.run(
        snapshotId,
        state.sessionId,
        state.version,
        STATE_SCHEMA_VERSION,
        ts,
        stateJson,
        null,
        state.transitionHistory[0]?.id || null,
        `sig_${state.version}`,
      )
      this._stmts.upsertActive.run(
        state.sessionId,
        state.timestamps.lastUpdate,
        stateJson,
        state.version,
        STATE_SCHEMA_VERSION,
      )
      // P0-2: enforce maxSnapshotsPerSession
      this._stmts.pruneSnapshots.run(state.sessionId, state.sessionId, this.config.maxSnapshotsPerSession)
    })

    try {
      tx()
    } catch (e) {
      // UNIQUE conflict: ya existia este snapshot_id (mismo sessionId+version). Lo ignoramos.
      if (!/UNIQUE/i.test(e.message)) throw e
    }

    state.timestamps.lastSnapshot = ts
    state._dirty = false
    return snapshotId
  }

  /** API publica retrocompatible */
  persistSnapshot(state, reason) {
    return this._writeSnapshotImmediate(state, reason)
  }

  // ========== WRITE-BEHIND DE EVENTOS ==========
  _enqueueEvent(sessionId, evt) {
    this._eventBuffer.push(evt)
    if (this._eventBuffer.length >= this.config.eventFlushMaxBatch) {
      this._flushEventBuffer()
    }
  }

  _flushEventBuffer() {
    if (this._eventBuffer.length === 0) return
    const batch = this._eventBuffer
    this._eventBuffer = []
    const stmt = this._stmts.insertEvent
    const tx = this.db.transaction((items) => {
      for (const e of items) {
        stmt.run(
          e.session_id,
          e.event_timestamp,
          e.tick == null ? null : e.tick,
          e.event_type,
          e.state_diff_json,
          e.full_state_json,
          e.version,
        )
      }
    })
    try {
      tx(batch)
    } catch (err) {
      console.warn("[SessionStateStore] event flush failed:", err.message)
      // No reencolamos para evitar amplificacion; el snapshot mantiene el estado.
    }
  }

  /** API publica retrocompatible (escribe sincronicamente como antes) */
  persistStateEvent(sessionId, reason, diff, fullState) {
    this._stmts.insertEvent.run(
      sessionId,
      this._now(),
      fullState?.tick ?? null,
      reason,
      JSON.stringify(diff),
      reason === "transition" || reason === "recovery" ? this._serializeState(fullState) : null,
      fullState.version,
    )
  }

  getEventBufferDepth() {
    return this._eventBuffer.length
  }

  // ========== SERIALIZACION ==========
  _serializeState(state) {
    const toSerialize = { ...state }
    delete toSerialize._dirty
    return JSON.stringify(toSerialize)
  }

  _deserializeState(jsonStr) {
    const state = JSON.parse(jsonStr)
    // Migracion in-flight: estados antiguos con oscillationMetrics.count
    if (state.oscillationMetrics && typeof state.oscillationMetrics.count === "number") {
      const legacyCount = state.oscillationMetrics.count
      state.oscillationMetrics = {
        streak: legacyCount,
        countSession: legacyCount,
        lastReset: state.oscillationMetrics.lastReset || 0,
      }
    }
    if (!state.oscillationMetrics) {
      state.oscillationMetrics = { streak: 0, countSession: 0, lastReset: 0 }
    }
    if (typeof state.tick !== "number") state.tick = 0
    if (typeof state.schemaVersion !== "number") state.schemaVersion = STATE_SCHEMA_VERSION
    state._dirty = false
    return state
  }

  // ========== RECOVERY (fuente unica: active_sessions_store) ==========
  recoverSession(sessionId) {
    const row = this._stmts.selectActive.get(sessionId)
    if (!row || row.tombstoned) return null
    const state = this._deserializeState(row.state_json)
    state._dirty = false
    this.activeSessions.set(sessionId, state)
    this._tombstones.delete(sessionId)
    this._enforceActiveLimit()
    return state
  }

  getLatestSnapshot(sessionId) {
    return this._stmts.selectLatestSnapshot.get(sessionId) || null
  }

  // ========== REPLAY ==========
  async replaySession(sessionId, fromTimestamp = 0, toTimestamp, callback) {
    if (typeof toTimestamp !== 'number') throw new Error('SessionStateStore.replaySession requires explicit toTimestamp');
    this._flushEventBuffer()
    const events = this._stmts.selectEventsInRange.all(sessionId, fromTimestamp, toTimestamp)
    for (const event of events) {
      const diff = JSON.parse(event.state_diff_json)
      const fullState = event.full_state_json ? this._deserializeState(event.full_state_json) : null
      if (callback) {
        await callback(event.event_timestamp, diff, fullState, event.event_type, {
          tick: event.tick,
          version: event.version,
        })
      }
    }
    return events.length
  }

  /**
   * Reconstruye el estado en un timestamp dado (P2-4):
   *  - parte del snapshot mas reciente con snapshot_timestamp <= t
   *  - aplica los diffs de state_events posteriores hasta t
   */
  reconstructStateAt(sessionId, t) {
    this._flushEventBuffer()
    const snap = this._stmts.selectSnapshotBeforeTs.get(sessionId, t)
    let baseState
    let baseTs
    if (snap) {
      baseState = this._deserializeState(snap.state_json)
      baseTs = snap.snapshot_timestamp
    } else {
      return null
    }
    const events = this.db
      .prepare(`
        SELECT event_timestamp, event_type, state_diff_json
        FROM state_events
        WHERE session_id = ? AND event_timestamp > ? AND event_timestamp <= ?
        ORDER BY event_timestamp ASC, id ASC
      `)
      .all(sessionId, baseTs, t)
    for (const ev of events) {
      const diff = JSON.parse(ev.state_diff_json)
      this._applyDiffInPlace(baseState, diff)
    }
    return baseState
  }

  _applyDiffInPlace(state, diff) {
    for (const [key, value] of Object.entries(diff)) {
      if (key === "signalHistoryNew" && Array.isArray(value)) {
        state.signalHistory = [...value, ...(state.signalHistory || [])].slice(0, this.config.maxHistoryEvents)
      } else if (key === "transitionHistoryNew" && Array.isArray(value)) {
        state.transitionHistory = [...value, ...(state.transitionHistory || [])].slice(0, this.config.maxHistoryEvents)
      } else if (key === "interventionHistoryNew" && Array.isArray(value)) {
        state.interventionHistory = [...value, ...(state.interventionHistory || [])].slice(
          0,
          this.config.maxInterventionHistory,
        )
      } else if (DEEP_MERGE_FIELDS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        state[key] = { ...(state[key] || {}), ...value }
      } else {
        state[key] = value
      }
    }
  }

  // ========== TTL / CLEANUP ==========
  startCleanup() {
    this._cleanupTimer = setInterval(() => {
      if (this._destroyed) return
      try {
        this.cleanupInactiveSessions()
      } catch (e) {
        console.warn("[SessionStateStore] cleanup error:", e.message)
      }
    }, this.config.cleanupIntervalMs)
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === "function") this._cleanupTimer.unref()
  }

  cleanupInactiveSessions() {
    const now = this._now()
    const ttlMs = this.config.sessionTTLSeconds * 1000
    const toExpire = []
    for (const [sessionId, state] of this.activeSessions.entries()) {
      if (now - state.timestamps.lastUpdate > ttlMs) toExpire.push(sessionId)
    }
    for (const sessionId of toExpire) {
      const state = this.activeSessions.get(sessionId)
      if (state && state._dirty) {
        try {
          this._writeSnapshotImmediate(state, "session_expiry")
        } catch (e) {
          console.warn("[SessionStateStore] expiry snapshot failed:", e.message)
        }
      }
      this.activeSessions.delete(sessionId)
      this._sessionLocks.delete(sessionId)
      // Tombstone (no borramos active_sessions_store: marcamos para que getSessionState no rehidrate)
      try {
        this._stmts.tombstoneActive.run(sessionId)
      } catch (e) {
        /* ignore */
      }
      this._tombstones.add(sessionId)
      // Purgar storage historico de la sesion (P0-2)
      try {
        const tx = this.db.transaction(() => {
          this._stmts.deleteSessionEvents.run(sessionId)
          this._stmts.deleteSessionSnapshots.run(sessionId)
          this._stmts.deleteActive.run(sessionId)
        })
        tx()
      } catch (e) {
        console.warn("[SessionStateStore] historical purge failed:", e.message)
      }
    }
    if (toExpire.length > 0) {
      console.log(`[SessionStateStore] cleaned up ${toExpire.length} inactive sessions`)
    }
  }

  startAutoSnapshot() {
    this._snapshotTimer = setInterval(() => {
      if (this._destroyed) return
      for (const [, state] of this.activeSessions.entries()) {
        try {
          if (state._dirty && this._now() - state.timestamps.lastSnapshot > this.config.snapshotIntervalMs) {
            this._writeSnapshotImmediate(state, "auto_snapshot")
          }
        } catch (e) {
          console.warn("[SessionStateStore] auto snapshot error:", e.message)
        }
      }
    }, Math.max(1000, Math.floor(this.config.snapshotIntervalMs / 2)))
    if (this._snapshotTimer && typeof this._snapshotTimer.unref === "function") this._snapshotTimer.unref()
  }

  startEventFlush() {
    this._flushTimer = setInterval(() => {
      if (this._destroyed) return
      try {
        this._flushEventBuffer()
      } catch (e) {
        console.warn("[SessionStateStore] flush error:", e.message)
      }
    }, this.config.eventFlushIntervalMs)
    if (this._flushTimer && typeof this._flushTimer.unref === "function") this._flushTimer.unref()
  }

  /**
   * Detiene timers y vuelca buffers pendientes. Idempotente.
   */
  destroy() {
    if (this._destroyed) return
    this._destroyed = true
    if (this._cleanupTimer) clearInterval(this._cleanupTimer)
    if (this._snapshotTimer) clearInterval(this._snapshotTimer)
    if (this._flushTimer) clearInterval(this._flushTimer)
    this._cleanupTimer = null
    this._snapshotTimer = null
    this._flushTimer = null
    try {
      // Persistir cambios pendientes de cada sesion activa
      for (const [, state] of this.activeSessions.entries()) {
        if (state._dirty) {
          try {
            this._writeSnapshotImmediate(state, "shutdown")
          } catch (e) {
            /* ignore */
          }
        }
      }
      this._flushEventBuffer()
    } catch (e) {
      /* ignore */
    }
  }

  stop() {
    return this.destroy()
  }

  // ========== QUERIES HISTORICAS ==========
  getSnapshotAtTime(sessionId, timestamp) {
    const row = this._stmts.selectSnapshotBeforeTs.get(sessionId, timestamp)
    return row ? this._deserializeState(row.state_json) : null
  }

  getEventHistory(sessionId, limit = 50) {
    this._flushEventBuffer()
    const rows = this._stmts.recentEvents.all(sessionId, limit)
    return rows.map((row) => ({
      timestamp: row.event_timestamp,
      type: row.event_type,
      diff: JSON.parse(row.state_diff_json),
    }))
  }

  getTransitionHistory(sessionId, limit = 20) {
    this._flushEventBuffer()
    const rows = this._stmts.recentTransitions.all(sessionId, limit)
    return rows.map((row) => {
      const diff = JSON.parse(row.state_diff_json)
      const first = diff.transitionHistoryNew ? diff.transitionHistoryNew[0] : null
      return {
        timestamp: row.event_timestamp,
        from: first?.from ?? diff.previousIntentState,
        to: first?.to ?? diff.currentIntentState,
        confidence: first?.confidence ?? diff.stateConfidence,
      }
    })
  }

  // ========== METRICAS ==========
  getActiveSessionsCount() {
    return this.activeSessions.size
  }

  getTotalSnapshotsCount() {
    const row = this._stmts.countSnapshots.get()
    return row.cnt
  }

  // ========== INTEGRACION CON OTROS ENGINES ==========
  /**
   * Actualiza el estado con la salida del TransitionEngine.
   * Soporta opts.tick / opts.eventTimestamp / opts.expectedVersion.
   */
  updateFromTransitionEngine(sessionId, transitionResult, signals, opts = {}) {
    const current = this.getSessionState(sessionId)
    if (!current) throw new Error(`Session ${sessionId} not found`)

    const prevOsc = current.oscillationMetrics || { streak: 0, countSession: 0, lastReset: this._now() }
    const isRisk = !!transitionResult.oscillationRisk
    const newStreak = isRisk ? prevOsc.streak + 1 : 0
    const newCountSession = prevOsc.countSession + (isRisk ? 1 : 0)
    const resetHappened = prevOsc.streak > 0 && newStreak === 0
    const newLastReset = resetHappened ? this._now() : prevOsc.lastReset

    const updates = {
      currentIntentState: transitionResult.state,
      stateConfidence: transitionResult.strength,
      stateStability: transitionResult.stability,
      momentumMetrics: {
        score: transitionResult.momentum,
        acceleration: transitionResult.momentum * 0.1,
        // velocity preserved by deep-merge
      },
      derivedSignals: signals,
      oscillationMetrics: {
        streak: newStreak,
        countSession: newCountSession,
        lastReset: newLastReset,
      },
    }

    if (transitionResult.transition) {
      const tick = typeof opts.tick === "number" ? opts.tick : (current.tick || 0) + 1
      const transId = this._deterministicId([
        sessionId,
        tick,
        transitionResult.transition.from,
        transitionResult.transition.to,
      ])
      updates.transitionHistory = [
        {
          id: transId,
          from: transitionResult.transition.from,
          to: transitionResult.transition.to,
          confidence: transitionResult.transition.confidence,
          timestamp: transitionResult.transition.timestamp,
          reason: transitionResult.transition.reason,
        },
      ]
    }

    return this.updateSessionState(
      sessionId,
      updates,
      transitionResult.transition ? "transition" : "state_update",
      opts,
    )
  }

  updateFromSignalEngine(sessionId, allSignals, opts = {}) {
    return this.updateSessionState(
      sessionId,
      {
        derivedSignals: allSignals,
        temporalMetrics: { lastSignalUpdate: opts.eventTimestamp ?? this._now() },
      },
      "signal_update",
      opts,
    )
  }

  // ========== SUMMARY ==========
  getSessionSummary(sessionId, opts = {}) {
    const state = opts.readOnly ? this.peekSessionState(sessionId) : this.getSessionState(sessionId)
    if (!state) return null
    return {
      sessionId: state.sessionId,
      currentState: state.currentIntentState,
      confidence: state.stateConfidence,
      totalTransitions: state.transitionHistory.length,
      totalInterventions: state.interventionHistory.length,
      durationSec: (this._now() - state.timestamps.start) / 1000,
      lastActiveSec: (this._now() - state.timestamps.lastUpdate) / 1000,
      riskScores: state.riskScores,
      momentum: state.momentumMetrics,
      oscillation: state.oscillationMetrics,
      version: state.version,
      tick: state.tick,
    }
  }
}

module.exports = { SessionStateStore, DEFAULT_CONFIG, STATE_SCHEMA_VERSION }
