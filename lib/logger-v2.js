/**
 * logger-v2.js — Reescritura bajo arquitectura corregida
 *
 * Capa de captura de señales y transporte. NO renderiza, NO decide
 * visibilidad, NO toca el DOM de mensajes.
 *
 * Responsabilidades (las únicas permitidas):
 *  - Capturar señales del DOM (scroll, hover, click, modal, cart, contexto).
 *  - Detectar el contexto activo de forma reactiva (IntersectionObserver +
 *    MutationObserver sobre contenedores estables, sin polling).
 *  - Mantener sesión con el backend (start, eventos, micro-signals, flush).
 *  - Pedir decisiones al backend con coalescing, throttling, snapshot de
 *    contexto y correlation IDs.
 *  - Reenviar la decisión recibida al message-visibility-controller, que
 *    es el ÚNICO autorizado a renderizar/ocultar mensajes.
 *  - Notificar al intervention-lifecycle-manager los hechos visuales
 *    reportados por el controller (vía adaptadores externos), pero el
 *    propio logger no maneja el FSM.
 *
 * Lo que este archivo NO puede hacer (por arquitectura):
 *  - Crear, insertar, mover, ocultar o eliminar nodos de mensaje.
 *  - Mantener punteros a elementos visibles ("currentMessageElement").
 *  - Decidir autohide con setTimeout sobre mensajes.
 *  - Aplicar estilos a mensajes ni inyectar HTML.
 *  - Usar Date.now() directamente: todo "now" pasa por una función
 *    inyectable para que session-simulator-runner pueda replayar.
 *
 * Determinista respecto a sus entradas (DOM events + clock inyectado).
 * Replay-safe siempre que el host inyecte clock y RNG controlados.
 */

(function () {
  "use strict"

  if (typeof window === "undefined" || typeof document === "undefined") {
    return
  }

  if (window.__opeLoggerV2Loaded) {
    console.warn("[OPE2] logger-v2 already loaded; skipping duplicate init")
    return
  }

  // ============================================================
  // Inyección de dependencias controlables (clock, rng, transport)
  // P1-DET: hoisted BEFORE any usage so loadedAt uses injected clock.
  // ============================================================

  const injected = window.__OPE_inject || {}

  const _now =
    typeof injected.now === "function"
      ? injected.now
      : () => Date.now()

  // P1-HARDEN: Monotonic sequence counter eliminates Math.random() entirely.
  // Guarantees deterministic, collision-free IDs when crypto.randomUUID is
  // unavailable (simulator, legacy browsers, SSR tests).
  let _seqCounter = 0

  const _uuid =
    typeof injected.uuid === "function"
      ? injected.uuid
      : () => {
          if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID()
          }
          // Deterministic fallback: monotonic sequence + clock (NO Math.random)
          _seqCounter++
          return (
            "uuid-" +
            _now().toString(36) +
            "-" +
            _seqCounter.toString(36).padStart(6, "0")
          )
        }

  window.__opeLoggerV2Loaded = {
    version: "2.1.0-hardened",
    loadedAt: _now(),
  }

  // ============================================================
  // Configuración
  // ============================================================

  const tag = document.currentScript
  const STORE = (tag && tag.dataset && tag.dataset.store) || "demo"
  const API = ((tag && tag.dataset && tag.dataset.api) || "http://localhost:3002").replace(/\/$/, "")
  const DEBUG = !!(tag && tag.dataset && tag.dataset.debug === "true")
  const USER_KEY = `ope_user:${STORE}`

  const CONFIG = Object.freeze({
    // Throttling de requestDecision
    decisionMinIntervalMs: 1500,
    decisionMaxBackoffMs: 30000,
    decisionBackoffBaseMs: 2000,
    // Periodic decision (heartbeat) cuando no hay actividad
    periodicDecisionMs: 12000,
    periodicDecisionMinInactivityMs: 6000,
    // Micro signals
    microSignalsIntervalMs: 30000,
    // Debounces
    scrollDebounceMs: 200,
    mousemoveDebounceMs: 500,
    hoverIntentMs: 300,
    // Network
    fetchTimeoutMs: 4000,
    // Buffer de eventos pre-init
    preInitBufferMax: 200,
    // sendBeacon en pagehide
    beaconEndpoint: "/action/log/batch",
    // Snapshot de contexto stale-cutoff: si la respuesta de decisión llega
    // después de N ms y el contexto cambió, se descarta.
    contextSnapshotMaxAgeMs: 4000,
  })

  const log = (...args) => {
    if (DEBUG) console.log("[OPE2]", ...args)
  }

  // ============================================================
  // Estado interno (mínimo; sin punteros a DOM de mensajes)
  // ============================================================

  let sessionId = null
  let variant = null
  let userId = null

  try {
    userId = localStorage.getItem(USER_KEY)
    if (!userId) {
      userId = _uuid()
      localStorage.setItem(USER_KEY, userId)
    }
  } catch {
    userId = _uuid()
  }

  // P1-HARDEN: Bounded visibility map with configurable cap.
  // Prevents unbounded growth if page has infinite scroll / large catalog.
  const PRODUCT_VISIBILITY_CAP = 256

  // Contexto detectado reactivamente
  const contextState = {
    pageType: "listing", // 'listing' | 'product_detail' | 'cart'
    activeProductId: null,
    modalOpen: false,
    cartOpen: false,
    productVisibility: new Map(), // productId -> { ratio, lastSeenAt }
    lastChangeAt: _now(),
  }

  /**
   * P1-HARDEN: Bounded set for productVisibility.
   * Evicts least-recently-observed entries when cap is exceeded.
   */
  function setProductVisibility(pid, ratio) {
    contextState.productVisibility.set(pid, { ratio, lastSeenAt: _now() })
    if (contextState.productVisibility.size > PRODUCT_VISIBILITY_CAP) {
      // Evict oldest (first inserted) — Map preserves insertion order
      const oldest = contextState.productVisibility.keys().next().value
      contextState.productVisibility.delete(oldest)
    }
  }

  /**
   * P1-HARDEN: Purge stale visibility entries (not seen for > 60s).
   * Called periodically by the micro-signal loop to bound memory.
   */
  const VISIBILITY_STALE_MS = 60000
  function purgeStaleVisibility() {
    const now = _now()
    for (const [pid, entry] of contextState.productVisibility) {
      if (now - entry.lastSeenAt > VISIBILITY_STALE_MS) {
        contextState.productVisibility.delete(pid)
      }
    }
  }

  // Throttle/backoff de decisiones
  const decisionGate = {
    inFlight: false,
    lastRequestAt: 0,
    consecutiveFailures: 0,
    queuedTrigger: null, // último trigger coalescido
  }

  // Última actividad relevante (para periodic loop)
  let lastUserActivityAt = _now()

  // Buffer de eventos antes de tener sessionId
  const preInitBuffer = []

  // Buffer de eventos para sendBeacon en pagehide
  const pendingBatch = []

  // Disposers de listeners/observers
  const disposers = []
  let disposed = false

  // P1-HARDEN: Track in-flight AbortControllers for safe teardown.
  const _inFlightControllers = new Set()

  // Pausa cuando la pestaña está oculta
  let isHidden = document.visibilityState === "hidden"

  // ============================================================
  // Transport: safeFetch con timeout y resultado estructurado
  // ============================================================

  async function safeFetch(url, options = {}) {
    const controller = new AbortController()
    _inFlightControllers.add(controller)
    const timeoutId = setTimeout(
      () => controller.abort(),
      options.timeoutMs || CONFIG.fetchTimeoutMs,
    )
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      })
      const ct = res.headers.get("content-type") || ""
      let data = null
      if (ct.includes("application/json")) {
        try {
          data = await res.json()
        } catch {
          data = null
        }
      }
      return {
        ok: res.ok,
        status: res.status,
        data,
        error: res.ok ? null : new Error(`HTTP ${res.status}`),
      }
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: err,
      }
    } finally {
      clearTimeout(timeoutId)
      _inFlightControllers.delete(controller)
    }
  }

  // ============================================================
  // Bridges hacia message-visibility-controller y lifecycle-manager
  // ============================================================
  //
  // El logger NO conoce la implementación; solo llama a hooks expuestos
  // por el host. Si no existen, las decisiones se descartan silenciosamente
  // (modo "transport-only").
  //
  //   window.__OPE_visibilityController.evaluate({ decision, contextSnapshot, now })
  //   window.__OPE_lifecycleManager.observeContext({ context, now })
  //
  // Esto preserva la separación de concerns: si alguien intenta usar el
  // logger sin el controller, no renderiza nada (que es lo correcto).

  function forwardDecisionToController(decision, contextSnapshot) {
    const controller = window.__OPE_visibilityController
    if (!controller || typeof controller.evaluate !== "function") {
      log("No visibility controller registered; decision dropped", decision)
      return
    }
    try {
      controller.evaluate({
        decision,
        contextSnapshot,
        now: _now(),
      })
    } catch (err) {
      log("visibilityController.evaluate threw", err)
    }
  }

  function notifyLifecycleContext(context) {
    const manager = window.__OPE_lifecycleManager
    if (!manager || typeof manager.observeContext !== "function") return
    try {
      manager.observeContext({ context, now: _now() })
    } catch (err) {
      log("lifecycleManager.observeContext threw", err)
    }
  }

  // ============================================================
  // Envío de eventos y micro-signals
  // ============================================================

  function buildEvent(actionType, payload) {
    return {
      eventId: _uuid(),
      sessionId,
      storeId: STORE,
      actionType,
      payload: payload || {},
      ts: _now(),
      context: { ...snapshotContext() },
      variant,
    }
  }

  async function sendEvent(actionType, payload) {
    const evt = buildEvent(actionType, payload)
    if (!sessionId) {
      if (preInitBuffer.length < CONFIG.preInitBufferMax) {
        preInitBuffer.push(evt)
      }
      return { ok: false, status: 0, data: null, error: new Error("no_session") }
    }
    // Mantener copia para beacon de cierre
    pendingBatch.push(evt)
    if (pendingBatch.length > 100) pendingBatch.shift()

    return safeFetch(`${API}/action/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": evt.eventId },
      body: JSON.stringify(evt),
    })
  }

  async function flushPreInitBuffer() {
    if (!sessionId || preInitBuffer.length === 0) return
    const batch = preInitBuffer.splice(0, preInitBuffer.length)
    // Reasignar sessionId en cada evento (estaban con sessionId=null)
    batch.forEach((e) => {
      e.sessionId = sessionId
      e.variant = variant
    })
    await safeFetch(`${API}${CONFIG.beaconEndpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, storeId: STORE, events: batch }),
    })
  }

  async function sendMicroSignals() {
    if (!sessionId) return
    const sigs = {
      timestamp: _now(),
      scrollDepth: computeScrollDepth(),
      pageType: contextState.pageType,
      activeProductId: contextState.activeProductId,
      inactivityMs: _now() - lastUserActivityAt,
      hidden: isHidden,
    }
    await safeFetch(`${API}/micro/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, storeId: STORE, signals: sigs }),
    })
  }

  // ============================================================
  // Decisión de intervención con coalescing + backoff
  // ============================================================

  function snapshotContext() {
    return {
      pageType: contextState.pageType,
      activeProductId: contextState.activeProductId,
      modalOpen: contextState.modalOpen,
      cartOpen: contextState.cartOpen,
      capturedAt: _now(),
    }
  }

  async function requestDecision(triggerEvent) {
    if (!sessionId || disposed) return

    const now = _now()

    // Coalescing: si ya hay una en vuelo, guardamos el último trigger
    // y salimos. Cuando termine, se reevalúa.
    if (decisionGate.inFlight) {
      decisionGate.queuedTrigger = triggerEvent
      return
    }

    // Throttle: respetar intervalo mínimo
    const sinceLast = now - decisionGate.lastRequestAt
    if (sinceLast < CONFIG.decisionMinIntervalMs) {
      decisionGate.queuedTrigger = triggerEvent
      const wait = CONFIG.decisionMinIntervalMs - sinceLast
      const t = setTimeout(() => {
        const q = decisionGate.queuedTrigger
        decisionGate.queuedTrigger = null
        if (q && !disposed) requestDecision(q)
      }, wait)
      disposers.push(() => clearTimeout(t))
      return
    }

    // Backoff: si hubo fallos consecutivos, esperar
    if (decisionGate.consecutiveFailures > 0) {
      const backoff = Math.min(
        CONFIG.decisionMaxBackoffMs,
        CONFIG.decisionBackoffBaseMs * Math.pow(2, decisionGate.consecutiveFailures - 1),
      )
      if (sinceLast < backoff) {
        return
      }
    }

    decisionGate.inFlight = true
    decisionGate.lastRequestAt = now

    const correlationId = _uuid()
    const contextSnapshot = snapshotContext()

    const payload = {
      sessionId,
      storeId: STORE,
      context: contextSnapshot.pageType,
      productId: contextSnapshot.activeProductId,
      contextSnapshot,
      triggerEvent: triggerEvent || null,
      correlationId,
      now,
    }

    let result
    try {
      result = await safeFetch(`${API}/api/decision/request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": correlationId,
        },
        body: JSON.stringify(payload),
      })
    } finally {
      decisionGate.inFlight = false
    }

    if (!result || !result.ok) {
      decisionGate.consecutiveFailures += 1
      log("decision request failed", result && result.error)
    } else {
      decisionGate.consecutiveFailures = 0
    }

    if (result && result.ok && result.data && result.data.shouldIntervene && result.data.intervention) {
      // Verificar que el contexto sigue siendo coherente antes de
      // reenviar al controller (anti stale-context).
      const ageMs = _now() - contextSnapshot.capturedAt
      const currentSnap = snapshotContext()
      const stillCoherent =
        ageMs <= CONFIG.contextSnapshotMaxAgeMs &&
        currentSnap.pageType === contextSnapshot.pageType &&
        currentSnap.activeProductId === contextSnapshot.activeProductId

      if (!stillCoherent) {
        log("decision discarded: stale context", {
          ageMs,
          snapshot: contextSnapshot,
          current: currentSnap,
        })
        // Notificar al backend del descarte para evitar contar como "shown"
        sendEvent("DECISION_DISCARDED_STALE", {
          correlationId,
          snapshot: contextSnapshot,
          current: currentSnap,
          ageMs,
        })
      } else {
        forwardDecisionToController(
          {
            ...result.data.intervention,
            correlationId,
          },
          contextSnapshot,
        )
      }
    }

    // Si quedó un trigger encolado durante el request, dispararlo
    if (decisionGate.queuedTrigger && !disposed) {
      const q = decisionGate.queuedTrigger
      decisionGate.queuedTrigger = null
      // No re-disparar en stack profundo
      const t = setTimeout(() => requestDecision(q), 0)
      disposers.push(() => clearTimeout(t))
    }
  }

  // ============================================================
  // Detección de contexto (reactiva, sin polling)
  // ============================================================

  function computeScrollDepth() {
    const denom = document.documentElement.scrollHeight - window.innerHeight
    if (denom <= 0) return 0
    const raw = window.scrollY / denom
    if (!isFinite(raw)) return 0
    return Math.max(0, Math.min(1, raw))
  }

  function recomputeActiveProduct() {
    if (contextState.modalOpen) {
      // El modal manda
      return
    }
    let best = null
    let bestRatio = 0
    contextState.productVisibility.forEach((entry, pid) => {
      const ratio = typeof entry === "object" ? entry.ratio : entry
      if (ratio > bestRatio) {
        bestRatio = ratio
        best = pid
      }
    })
    if (best !== contextState.activeProductId) {
      const prev = contextState.activeProductId
      contextState.activeProductId = best
      contextState.lastChangeAt = _now()
      log("activeProductId changed", { from: prev, to: best, ratio: bestRatio })
    }
  }

  function setPageType(next, opts = {}) {
    if (contextState.pageType === next) return
    const prev = contextState.pageType
    contextState.pageType = next
    contextState.lastChangeAt = _now()
    sendEvent("CONTEXT_CHANGED", {
      from: prev,
      to: next,
      productId: contextState.activeProductId,
      ...opts,
    })
    notifyLifecycleContext(next)
    requestDecision({ type: "context_change", context: next, productId: contextState.activeProductId })
  }

  function setupProductIntersectionObserver() {
    if (typeof IntersectionObserver === "undefined") return

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const card = entry.target
          const pid = card.getAttribute("data-product-id")
          if (!pid) continue
          setProductVisibility(pid, entry.intersectionRatio)
        }
        recomputeActiveProduct()
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    )

    function observeAll() {
      document.querySelectorAll(".product-card[data-product-id]").forEach((card) => {
        io.observe(card)
      })
    }
    observeAll()

    // Re-observar cuando se monten nuevas cards
    const mo = new MutationObserver((mutations) => {
      let dirty = false
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length > 0) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue
            if (n.matches && n.matches(".product-card[data-product-id]")) {
              io.observe(n)
              dirty = true
            } else if (n.querySelectorAll) {
              n.querySelectorAll(".product-card[data-product-id]").forEach((c) => {
                io.observe(c)
                dirty = true
              })
            }
          }
        }
        if (m.removedNodes && m.removedNodes.length > 0) {
          for (const n of m.removedNodes) {
            if (n.nodeType !== 1) continue
            const pid = n.getAttribute && n.getAttribute("data-product-id")
            if (pid) {
              contextState.productVisibility.delete(pid)
              dirty = true
            }
          }
        }
      }
      if (dirty) recomputeActiveProduct()
    })
    mo.observe(document.body, { childList: true, subtree: true })

    disposers.push(() => io.disconnect())
    disposers.push(() => mo.disconnect())
  }

  function setupModalAndCartObservers() {
    // Observador robusto: vigila body con subtree y detecta cambios de
    // clase en #productModal y #cartOverlay, aunque se remonten.
    const mo = new MutationObserver(() => {
      const modal = document.getElementById("productModal")
      const cart = document.getElementById("cartOverlay")

      const modalOpen = !!(modal && modal.classList.contains("active"))
      const cartOpen = !!(cart && cart.classList.contains("open"))

      if (modalOpen !== contextState.modalOpen) {
        contextState.modalOpen = modalOpen
        if (modalOpen) {
          const pid = modal.getAttribute("data-product-id") || contextState.activeProductId
          contextState.activeProductId = pid
          sendEvent("MODAL_OPENED", { productId: pid })
          setPageType("product_detail")
        } else {
          sendEvent("MODAL_CLOSED", {})
          // Volver a listing salvo que el cart esté abierto
          setPageType(cartOpen ? "cart" : "listing")
          recomputeActiveProduct()
        }
      }

      if (cartOpen !== contextState.cartOpen) {
        contextState.cartOpen = cartOpen
        if (cartOpen) {
          sendEvent("CART_OPENED", {})
          if (!modalOpen) setPageType("cart")
        } else {
          sendEvent("CART_CLOSED", {})
          if (!modalOpen) setPageType("listing")
        }
      }
    })

    mo.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
      childList: true,
    })
    disposers.push(() => mo.disconnect())
  }

  // ============================================================
  // Event listeners de usuario
  // ============================================================

  function markActivity() {
    lastUserActivityAt = _now()
  }

  function setupEventListeners() {
    // Scroll
    let scrollT = null
    const onScroll = () => {
      markActivity()
      if (scrollT) clearTimeout(scrollT)
      scrollT = setTimeout(() => {
        sendEvent("SCROLL", { depth: computeScrollDepth() })
      }, CONFIG.scrollDebounceMs)
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    disposers.push(() => {
      window.removeEventListener("scroll", onScroll)
      if (scrollT) clearTimeout(scrollT)
    })

    // Mousemove
    let moveT = null
    const onMove = () => {
      markActivity()
      if (moveT) clearTimeout(moveT)
      moveT = setTimeout(() => {
        sendEvent("MOUSEMOVE", {})
      }, CONFIG.mousemoveDebounceMs)
    }
    window.addEventListener("mousemove", onMove, { passive: true })
    disposers.push(() => {
      window.removeEventListener("mousemove", onMove)
      if (moveT) clearTimeout(moveT)
    })

    // Click
    const onClick = (e) => {
      markActivity()
      const addBtn = e.target.closest && e.target.closest(".btn-add")
      const productCard = e.target.closest && e.target.closest(".product-card")
      const modalClose = e.target.closest && e.target.closest(".modal-close")

      if (addBtn) {
        const productId =
          (addBtn.closest("[data-product-id]") &&
            addBtn.closest("[data-product-id]").getAttribute("data-product-id")) ||
          contextState.activeProductId
        sendEvent("ADD_TO_CART", { productId })
        requestDecision({ type: "add_to_cart", productId })
        return
      }
      if (modalClose) {
        // No emitimos MODAL_CLOSED aquí: el MutationObserver lo hará al
        // detectar el cambio real de clase en el modal. Evita duplicados.
        return
      }
      if (productCard && contextState.pageType === "listing") {
        const productId = productCard.getAttribute("data-product-id")
        sendEvent("PRODUCT_VIEW", { productId, source: "listing" })
      }
    }
    document.addEventListener("click", onClick)
    disposers.push(() => document.removeEventListener("click", onClick))

    // Hover-intent con mouseenter/leave delegados manualmente
    const hoverState = { btn: null, startedAt: 0, timer: null }
    const onMouseOver = (e) => {
      const btn = e.target.closest && e.target.closest(".btn-add")
      if (!btn) return
      if (hoverState.btn === btn) return // ya estamos en el mismo botón
      hoverState.btn = btn
      hoverState.startedAt = _now()
      if (hoverState.timer) clearTimeout(hoverState.timer)
      if (contextState.pageType === "product_detail") {
        hoverState.timer = setTimeout(() => {
          sendEvent("HOVER_CTA", {
            productId: contextState.activeProductId,
            durationMs: _now() - hoverState.startedAt,
          })
          requestDecision({ type: "hover_cta", productId: contextState.activeProductId })
        }, CONFIG.hoverIntentMs)
      }
    }
    const onMouseOut = (e) => {
      const btn = e.target.closest && e.target.closest(".btn-add")
      if (!btn || hoverState.btn !== btn) return
      const related = e.relatedTarget
      if (related && btn.contains(related)) return // sigue dentro
      if (hoverState.timer) {
        clearTimeout(hoverState.timer)
        hoverState.timer = null
      }
      const duration = _now() - hoverState.startedAt
      if (duration >= 80) {
        sendEvent("HOVER_CTA_END", {
          productId: contextState.activeProductId,
          durationMs: duration,
        })
      }
      hoverState.btn = null
    }
    document.addEventListener("mouseover", onMouseOver)
    document.addEventListener("mouseout", onMouseOut)
    disposers.push(() => {
      document.removeEventListener("mouseover", onMouseOver)
      document.removeEventListener("mouseout", onMouseOut)
      if (hoverState.timer) clearTimeout(hoverState.timer)
    })

    // Visibility (pausa intervalos cuando la pestaña está oculta)
    const onVisibility = () => {
      isHidden = document.visibilityState === "hidden"
      sendEvent("VISIBILITY", { hidden: isHidden })
    }
    document.addEventListener("visibilitychange", onVisibility)
    disposers.push(() => document.removeEventListener("visibilitychange", onVisibility))

    // pagehide: flush final con sendBeacon
    const onPagehide = () => {
      flushBeacon("pagehide")
    }
    window.addEventListener("pagehide", onPagehide)
    disposers.push(() => window.removeEventListener("pagehide", onPagehide))
  }

  // ============================================================
  // Loops: micro-signals y heartbeat de decisión
  // ============================================================

  function startMicroLoop() {
    let lastSignature = ""
    const interval = setInterval(() => {
      if (isHidden || !sessionId) return
      // P1-HARDEN: purge stale visibility entries every cycle
      purgeStaleVisibility()
      const signature = `${computeScrollDepth().toFixed(2)}|${contextState.pageType}|${contextState.activeProductId}`
      if (signature === lastSignature) {
        // Heartbeat 1 de cada 4 ciclos para no perder presencia
        if (Math.floor(_now() / CONFIG.microSignalsIntervalMs) % 4 !== 0) return
      }
      lastSignature = signature
      sendMicroSignals()
    }, CONFIG.microSignalsIntervalMs)
    disposers.push(() => clearInterval(interval))
  }

  function startDecisionHeartbeat() {
    const interval = setInterval(() => {
      if (isHidden || !sessionId || disposed) return
      const inactivity = _now() - lastUserActivityAt
      if (inactivity < CONFIG.periodicDecisionMinInactivityMs) return
      // Solo pedimos heartbeat si el controller dice que no hay nada visible
      const controller = window.__OPE_visibilityController
      const hasVisible =
        controller &&
        typeof controller.hasVisibleMessage === "function" &&
        controller.hasVisibleMessage()
      if (hasVisible) return
      requestDecision({ type: "periodic", inactivityMs: inactivity })
    }, CONFIG.periodicDecisionMs)
    disposers.push(() => clearInterval(interval))
  }

  // ============================================================
  // Cierre: sendBeacon con eventos pendientes
  // ============================================================

  function flushBeacon(reason) {
    if (!sessionId) return
    if (pendingBatch.length === 0 && !reason) return
    const payload = {
      sessionId,
      storeId: STORE,
      reason: reason || "manual",
      events: pendingBatch.splice(0, pendingBatch.length),
      ts: _now(),
    }
    try {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" })
      if (navigator.sendBeacon) {
        navigator.sendBeacon(`${API}${CONFIG.beaconEndpoint}`, blob)
      } else {
        // Fallback síncrono best-effort
        fetch(`${API}${CONFIG.beaconEndpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        })
      }
    } catch (err) {
      log("beacon flush failed", err)
    }
  }

  // ============================================================
  // Inicialización
  // ============================================================

  async function initSession() {
    const trafficSource = (() => {
      try {
        return document.referrer ? new URL(document.referrer).hostname : "direct"
      } catch {
        return "direct"
      }
    })()

    const result = await safeFetch(`${API}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storeId: STORE,
        userId,
        device: /Mobi|Android/i.test(navigator.userAgent) ? "mobile" : "desktop",
        trafficSource,
        clientNow: _now(),
      }),
    })

    if (result && result.ok && result.data && result.data.sessionId) {
      sessionId = result.data.sessionId
      variant = result.data.variant || null
      window.OPE_sessionId = sessionId
      window.OPE_variant = variant
      log("session initialized", sessionId, variant)
      return true
    }
    console.error("[OPE2] failed to initialize session", result && result.error)
    return false
  }

  // Reconciliación inicial del contexto (sin polling: solo una vez al
  // arrancar, después todo es reactivo)
  function reconcileInitialContext() {
    const modal = document.getElementById("productModal")
    const cart = document.getElementById("cartOverlay")
    contextState.modalOpen = !!(modal && modal.classList.contains("active"))
    contextState.cartOpen = !!(cart && cart.classList.contains("open"))
    if (contextState.modalOpen) {
      contextState.activeProductId =
        (modal && modal.getAttribute("data-product-id")) || null
      contextState.pageType = "product_detail"
    } else if (contextState.cartOpen) {
      contextState.pageType = "cart"
    } else {
      contextState.pageType = "listing"
    }
    notifyLifecycleContext(contextState.pageType)
  }

  async function init() {
    // 1) Listeners y observers ANTES de la sesión, para no perder eventos
    setupEventListeners()
    setupProductIntersectionObserver()
    setupModalAndCartObservers()
    reconcileInitialContext()

    // 2) Inicializar sesión
    const ok = await initSession()
    if (!ok) {
      log("session init failed; logger remains passive")
      return
    }

    // 3) Flush de eventos pre-init
    await flushPreInitBuffer()

    // 4) Loops
    startMicroLoop()
    startDecisionHeartbeat()

    // 5) Primera decisión con el contexto ya conocido
    requestDecision({ type: "session_start" })

    log("logger-v2 ready (transport-only, no DOM rendering)")
  }

  // ============================================================
  // API pública (mínima): teardown manual + introspección para tests
  // ============================================================

  window.__OPE_logger = {
    version: "2.1.0-hardened",
    getSessionId: () => sessionId,
    getVariant: () => variant,
    getContext: () => snapshotContext(),
    requestDecision: (trigger) => requestDecision(trigger || { type: "manual" }),
    sendEvent,
    dispose: () => {
      if (disposed) return
      disposed = true
      flushBeacon("dispose")
      // P1-HARDEN: Abort all in-flight fetch operations
      for (const ctrl of _inFlightControllers) {
        try { ctrl.abort() } catch { /* ignore */ }
      }
      _inFlightControllers.clear()
      // P1-HARDEN: Clear bounded maps to release memory
      contextState.productVisibility.clear()
      while (disposers.length > 0) {
        const d = disposers.pop()
        try {
          d()
        } catch {
          // ignore
        }
      }
      log("logger disposed")
    },
  }

  // ============================================================
  // Arranque
  // ============================================================

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init().catch((err) => console.error("[OPE2] init error", err))
    })
  } else {
    init().catch((err) => console.error("[OPE2] init error", err))
  }
})()
