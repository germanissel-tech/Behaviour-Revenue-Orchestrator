/**
 * Signal Derivation Engine (corrected)
 *
 * Capa intermedia que consume eventos raw (micro_events, actions, session context)
 * y produce señales comportamentales normalizadas, con decay temporal, momentum,
 * confianza y volatilidad.
 *
 * Esta versión corrige los hallazgos del audit:
 *  - P0-1 active_time_score ya no genera NaN (acumulador correcto).
 *  - P0-2 el decay se aplica realmente (suavizado exponencial en update()).
 *  - P0-3 la confianza se calcula a partir de los eventos contribuyentes del extractor.
 *  - P0-4 snapshot/restore incluye el eventHistory ring y estadísticas suficientes.
 *  - P0-5 ingestBatch + recalc único por batch; sin Math.max(...arr); sin shift() O(n).
 *  - P1-1 nowMs se propaga desde ingestEvent a extractores, update y applyDecay.
 *  - P1-2 applyDecay acepta nowMs (sin Date.now() interno).
 *  - P1-3 / P1-4 señales con evidencia insuficiente devuelven null (no overrides).
 *  - P1-5 abandonment_probability se calcula contra el ciclo de carrito actual.
 *  - P1-6 ring buffer fijo para eventHistory.
 *  - P1-7 min/max calculados con loops, no spread.
 *  - P1-8 hesitation_score normalizado por add_to_cart.
 *  - P1-9 separación app_tab_switch / browser_tab_switch.
 *  - P2-1 contributingEvents reales (ids) por extractor.
 *  - P2-2 history de volatilidad sólo se actualiza si el valor se mueve > epsilon.
 *  - P2-3 dedup por event.id con LRU.
 *  - P2-4 updateContext no fuerza recalc.
 *  - P2-5 tabla CALIBRATION central.
 *  - P2-6 SIGNAL_WEIGHTS declarado antes de SIGNAL_REGISTRY.
 *  - P2-7 ingestBatch.
 *  - P2-8 precisión completa en storage; redondeo sólo en toDisplayJSON().
 *  - P3-1 ventanas de momentum consistentes.
 *  - P3-2 volatility documentada en [0, 0.5].
 *  - P3-3 reset().
 *  - P3-4 export consistente de constantes.
 *  - tick(nowMs) permite recalc pasivo de señales dependientes del tiempo.
 *  - clamp defensivo contra NaN/Infinity en update().
 */

'use strict'

// ========== CONFIGURACIÓN GLOBAL ==========
const DEFAULT_DECAY_RATE = 0.05 // por minuto
const MOMENTUM_WINDOW_MS = 60000 // 1 minuto
const ACCEL_RECENT_WINDOW_MS = MOMENTUM_WINDOW_MS / 2 // 30s
const ACCEL_OLDER_WINDOW_MS = MOMENTUM_WINDOW_MS * 2 // 120s
const VOLATILITY_WINDOW_MS = 300000 // 5 minutos
const CONFIDENCE_BASE = 0.3
const CONFIDENCE_PER_EVENT = 0.05
const MAX_CONFIDENCE = 0.95
const MIN_CONFIDENCE = 0.1
const EVENT_HISTORY_CAP = 500
const VOLATILITY_EPSILON = 1e-4
const SEEN_IDS_CAP = 4096
const SMOOTHING_ALPHA = 0.4 // peso del nuevo valor en exponential smoothing

// Time-dependent signals: se recalculan en tick(nowMs) sin necesidad de un evento nuevo
const TIME_DEPENDENT_SIGNALS = new Set([
  'active_time_score',
  'interaction_density',
  'inactivity_risk',
  'momentum_score',
  'acceleration_score',
])

// Tabla central de constantes de calibración (P2-5)
const CALIBRATION = {
  cartCommitmentMaxNetAdds: 3,
  productFocusMaxCount: 10,
  revisitMax: 5,
  hesitationDelayMs: 30000,
  comparisonMaxSwitches: 10,
  indecisionMax: 5,
  checkoutReentryMax: 3,
  disengagementMax: 3,
  activeTimeMaxMs: 600000, // 10 min => 1.0
  activeTimeGapMs: 30000, // hueco > 30s no cuenta como activo
  interactionDensityMaxPerMin: 10,
  inactivityFloorSec: 30,
  inactivityCeilingLog: Math.log(600),
  bounceMinEvents: 3,
  attentionStabilityMinEvents: 3,
  purchaseFastSec: 30,
  purchaseSlowSec: 600,
  momentumNormDivisor: 2,
  accelNormDivisor: 2,
  cartAbandonWeight: 0.3,
  cartAbandonNoCheckoutWeight: 0.2,
}

// Ponderación base de tipos de evento (declarada antes del registry, P2-6)
const SIGNAL_WEIGHTS = {
  add_to_cart: 0.4,
  start_checkout: 0.6,
  place_order: 0.8,
  product_view: 0.1,
  product_zoom: 0.15,
  variant_click: 0.1,
  size_selected: 0.1,
  cart_removal: -0.2,
  exit_intent: -0.3,
  message_dismiss: -0.1,
  message_click: 0.2,
  page_scroll: 0.02,
  search: 0.05,
  filter: 0.05,
}

// ========== HELPERS PUROS ==========

function clamp01(x) {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function safeNumber(x, fallback = 0) {
  return Number.isFinite(x) ? x : fallback
}

function minTs(events) {
  let m = Infinity
  for (let i = 0; i < events.length; i++) {
    const t = events[i].ts
    if (typeof t === 'number' && t < m) m = t
  }
  return m === Infinity ? 0 : m
}

function maxTs(events) {
  let m = -Infinity
  for (let i = 0; i < events.length; i++) {
    const t = events[i].ts
    if (typeof t === 'number' && t > m) m = t
  }
  return m === -Infinity ? 0 : m
}

function maxDepth(events) {
  let m = 0
  for (let i = 0; i < events.length; i++) {
    const d = events[i].depth || 0
    if (d > m) m = d
  }
  return m
}

// Resultado vacío para extractor: "sin evidencia suficiente"
const NO_EVIDENCE = Object.freeze({ value: null, contrib: [] })

// ========== DEFINICIÓN DE SEÑALES (SIGNAL REGISTRY) ==========
// Cada extractor devuelve { value: number|null, contrib: event[] }
// value === null  => evidencia insuficiente; el manager no sobrescribe.
const SIGNAL_REGISTRY = [
  // ========== ENGAGEMENT ==========
  {
    name: 'scroll_depth_score',
    extractor: (events) => {
      const contrib = []
      let max = 0
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'page_scroll' || e.type === 'scroll_depth') {
          contrib.push(e)
          const d = e.depth || 0
          if (d > max) max = d
        }
      }
      if (contrib.length === 0) return NO_EVIDENCE
      return { value: clamp01(max), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.02,
    weight: 0.8,
    minEvents: 1,
  },
  {
    name: 'active_time_score',
    // P0-1: acumulador correcto con objeto { total, lastTs }
    extractor: (events, ctx) => {
      if (!ctx || !ctx.sessionStart) return NO_EVIDENCE
      const contrib = []
      let total = 0
      let lastTs = ctx.sessionStart
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (typeof e.ts !== 'number' || e.ts <= ctx.sessionStart) continue
        const gap = e.ts - lastTs
        // Solo cuenta como "activo" si el hueco no es muy grande
        if (gap > 0 && gap <= CALIBRATION.activeTimeGapMs) {
          total += gap
          contrib.push(e)
        }
        lastTs = e.ts
      }
      if (contrib.length < 2) return NO_EVIDENCE
      return { value: clamp01(total / CALIBRATION.activeTimeMaxMs), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.01,
    weight: 0.9,
    minEvents: 2,
  },
  {
    name: 'interaction_density',
    // P1-1: usa nowMs en lugar de Date.now()
    extractor: (events, _ctx, nowMs) => {
      const window = MOMENTUM_WINDOW_MS
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        if (nowMs - events[i].ts < window) contrib.push(events[i])
      }
      if (contrib.length === 0) return { value: 0, contrib: [] }
      return { value: clamp01(contrib.length / CALIBRATION.interactionDensityMaxPerMin), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 0.7,
    minEvents: 1,
  },
  {
    name: 'attention_stability',
    // P1-3: devuelve NO_EVIDENCE si hay <3 eventos en lugar de fijar 0.5
    extractor: (events) => {
      if (events.length < CALIBRATION.attentionStabilityMinEvents) return NO_EVIDENCE
      const sorted = []
      for (let i = 0; i < events.length; i++) sorted.push(events[i].ts)
      sorted.sort((a, b) => a - b)
      let sum = 0
      const diffs = []
      for (let i = 1; i < sorted.length; i++) {
        const d = sorted[i] - sorted[i - 1]
        diffs.push(d)
        sum += d
      }
      const mean = sum / diffs.length
      let varSum = 0
      for (let i = 0; i < diffs.length; i++) {
        const dv = diffs[i] - mean
        varSum += dv * dv
      }
      const variance = varSum / diffs.length
      const cv = Math.sqrt(variance) / (mean + 0.001)
      return { value: clamp01(1 - cv / 2), contrib: events.slice() }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.03,
    weight: 0.6,
    minEvents: 3,
  },

  // ========== PURCHASE INTENT ==========
  {
    name: 'cart_commitment_score',
    extractor: (events) => {
      let adds = 0
      let removals = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'add_to_cart') {
          adds++
          contrib.push(e)
        } else if (e.type === 'cart_removal') {
          removals++
          contrib.push(e)
        }
      }
      if (contrib.length === 0) return NO_EVIDENCE
      const net = adds - removals
      return { value: clamp01(net / CALIBRATION.cartCommitmentMaxNetAdds), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.08,
    weight: 1.0,
    minEvents: 1,
  },
  {
    name: 'checkout_progression_score',
    extractor: (events) => {
      const steps = ['start_checkout', 'enter_shipping', 'enter_payment', 'place_order']
      let maxStep = -1
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        const idx = steps.indexOf(e.type)
        if (idx >= 0) {
          contrib.push(e)
          if (idx > maxStep) maxStep = idx
        }
      }
      if (maxStep < 0) return NO_EVIDENCE
      return { value: clamp01((maxStep + 1) / steps.length), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 1.2,
    minEvents: 1,
  },
  {
    name: 'product_focus_score',
    extractor: (events) => {
      const counts = new Map()
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (!e.productId) continue
        counts.set(e.productId, (counts.get(e.productId) || 0) + 1)
        contrib.push(e)
      }
      if (contrib.length < 2) return NO_EVIDENCE
      let max = 0
      for (const c of counts.values()) if (c > max) max = c
      return { value: clamp01(max / CALIBRATION.productFocusMaxCount), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.05,
    weight: 0.9,
    minEvents: 2,
  },
  {
    name: 'revisit_product_score',
    extractor: (events) => {
      const seen = new Set()
      let revisits = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type !== 'product_view' || !e.productId) continue
        contrib.push(e)
        if (seen.has(e.productId)) revisits++
        else seen.add(e.productId)
      }
      if (contrib.length < 2) return NO_EVIDENCE
      return { value: clamp01(revisits / CALIBRATION.revisitMax), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.02,
    weight: 0.7,
    minEvents: 2,
  },

  // ========== HESITATION ==========
  {
    name: 'hesitation_score',
    // P1-8: normalizado por addToCartCount
    extractor: (events) => {
      let addToCart = 0
      let hesitationPoints = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'add_to_cart') {
          addToCart++
          contrib.push(e)
          const next = events[i + 1]
          if (next) {
            if (next.type === 'cart_removal') {
              hesitationPoints += 1.0
              contrib.push(next)
            } else if (next.ts - e.ts > CALIBRATION.hesitationDelayMs) {
              hesitationPoints += 0.5
            }
          }
        }
      }
      if (addToCart === 0) return NO_EVIDENCE
      return { value: clamp01(hesitationPoints / addToCart), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.15,
    weight: 0.8,
    minEvents: 2,
  },
  {
    name: 'comparison_behavior_score',
    // P1-9: solo cuenta product_switch y app_tab_switch (no browser_tab_switch)
    extractor: (events) => {
      let count = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'product_switch' || e.type === 'app_tab_switch') {
          count++
          contrib.push(e)
        }
      }
      if (contrib.length < 2) return NO_EVIDENCE
      return { value: clamp01(count / CALIBRATION.comparisonMaxSwitches), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 0.6,
    minEvents: 2,
  },
  {
    name: 'indecision_pattern_score',
    extractor: (events) => {
      let n = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'back_button') {
          n++
          contrib.push(e)
        } else if (e.type === 'exit_intent' && (e.duration || 0) < 5000) {
          n++
          contrib.push(e)
        }
      }
      if (contrib.length < 2) return NO_EVIDENCE
      return { value: clamp01(n / CALIBRATION.indecisionMax), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.12,
    weight: 0.7,
    minEvents: 2,
  },
  {
    name: 'checkout_reentry_score',
    extractor: (events) => {
      let reentries = 0
      let inCheckout = false
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'start_checkout') {
          inCheckout = true
          contrib.push(e)
        } else if (e.type === 'cart_close' || e.type === 'exit_intent') {
          inCheckout = false
        } else if (inCheckout && e.type === 'checkout_restart') {
          reentries++
          contrib.push(e)
        }
      }
      if (contrib.length === 0) return NO_EVIDENCE
      return { value: clamp01(reentries / CALIBRATION.checkoutReentryMax), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 0.8,
    minEvents: 1,
  },

  // ========== EXIT RISK ==========
  {
    name: 'disengagement_score',
    extractor: (events) => {
      let n = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'exit_intent' || e.type === 'idle_long') {
          n++
          contrib.push(e)
        }
      }
      if (contrib.length === 0) return NO_EVIDENCE
      return { value: clamp01(n / CALIBRATION.disengagementMax), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.2,
    weight: 0.9,
    minEvents: 1,
  },
  {
    name: 'inactivity_risk',
    // P1-1: usa nowMs; P1-3: NO_EVIDENCE si no hay eventos
    extractor: (events, _ctx, nowMs) => {
      if (events.length === 0) return NO_EVIDENCE
      const last = maxTs(events)
      const inactiveSec = (nowMs - last) / 1000
      if (inactiveSec < CALIBRATION.inactivityFloorSec) return { value: 0, contrib: [] }
      const v = Math.log(inactiveSec / CALIBRATION.inactivityFloorSec) / CALIBRATION.inactivityCeilingLog
      // contrib: el evento más reciente (justifica el risk)
      let lastEvent = null
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].ts === last) {
          lastEvent = events[i]
          break
        }
      }
      return { value: clamp01(v), contrib: lastEvent ? [lastEvent] : [] }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.05,
    weight: 0.8,
    minEvents: 1,
  },
  {
    name: 'bounce_risk',
    // P1-4: NO_EVIDENCE cuando hay <3 eventos (en vez de 0.8 fijo)
    extractor: (events) => {
      const total = events.length
      if (total < CALIBRATION.bounceMinEvents) return NO_EVIDENCE
      let deep = false
      for (let i = 0; i < total; i++) {
        const t = events[i].type
        if (t === 'add_to_cart' || t === 'start_checkout' || t === 'product_zoom') {
          deep = true
          break
        }
      }
      if (deep) return { value: 0, contrib: events.slice(-5) }
      return { value: clamp01(1 - total / 20) * 0.9, contrib: events.slice(-5) }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.3,
    weight: 0.7,
    minEvents: CALIBRATION.bounceMinEvents,
  },
  {
    name: 'abandonment_probability',
    // P1-5: scope al ciclo de carrito actual (después del último start_checkout
    // que NO ha sido seguido por place_order)
    extractor: (events) => {
      // Recorremos hacia atrás para encontrar el inicio del ciclo de carrito actual
      let lastPlaceOrderIdx = -1
      let lastStartCheckoutIdx = -1
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'place_order' && lastPlaceOrderIdx < 0) lastPlaceOrderIdx = i
        if (events[i].type === 'start_checkout' && lastStartCheckoutIdx < 0) lastStartCheckoutIdx = i
        if (lastPlaceOrderIdx >= 0 && lastStartCheckoutIdx >= 0) break
      }
      // Si el último place_order es posterior al último start_checkout, no hay ciclo abierto
      if (lastPlaceOrderIdx > lastStartCheckoutIdx) {
        // Pero puede haber eventos posteriores (nuevo carrito): revisamos
        const after = events.slice(lastPlaceOrderIdx + 1)
        if (after.length === 0) return { value: 0, contrib: [] }
        // continúa con el slice posterior como ventana
        return computeAbandonmentInWindow(after)
      }
      // Si hay start_checkout abierto, ventana = desde ahí; si no, ventana completa
      const window = lastStartCheckoutIdx >= 0 ? events.slice(lastStartCheckoutIdx) : events
      return computeAbandonmentInWindow(window)
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 0.9,
    minEvents: 1,
  },

  // ========== MOMENTUM ==========
  {
    name: 'momentum_score',
    extractor: (events, _ctx, nowMs) => {
      let total = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (nowMs - e.ts >= MOMENTUM_WINDOW_MS) continue
        const w = SIGNAL_WEIGHTS[e.type]
        if (w == null) continue
        total += w
        contrib.push(e)
      }
      if (contrib.length === 0) return { value: 0, contrib: [] }
      return { value: clamp01(Math.max(0, total) / CALIBRATION.momentumNormDivisor), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.2,
    weight: 1.0,
    minEvents: 1,
  },
  {
    name: 'acceleration_score',
    extractor: (events, _ctx, nowMs) => {
      let recent = 0
      let older = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const age = nowMs - events[i].ts
        if (age < ACCEL_RECENT_WINDOW_MS) {
          recent++
          contrib.push(events[i])
        } else if (age < ACCEL_OLDER_WINDOW_MS) {
          older++
        }
      }
      if (events.length < 2) return NO_EVIDENCE
      if (older === 0) return { value: recent > 0 ? 0.5 : 0, contrib }
      const ratio = recent / older
      return { value: clamp01(ratio / CALIBRATION.accelNormDivisor), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.25,
    weight: 0.8,
    minEvents: 2,
  },
  {
    name: 'purchase_velocity_score',
    extractor: (events) => {
      if (events.length < 2) return NO_EVIDENCE
      let first = Infinity
      let checkout = null
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (typeof e.ts === 'number' && e.ts < first) first = e.ts
        if (!checkout && e.type === 'start_checkout') checkout = e
      }
      if (!checkout || first === Infinity) return NO_EVIDENCE
      const sec = (checkout.ts - first) / 1000
      const fast = CALIBRATION.purchaseFastSec
      const slow = CALIBRATION.purchaseSlowSec
      let v
      if (sec < fast) v = 1
      else if (sec > slow) v = 0
      else v = 1 - (sec - fast) / (slow - fast)
      return { value: clamp01(v), contrib: [checkout] }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.15,
    weight: 0.9,
    minEvents: 2,
  },

  // ========== MESSAGE REACTION ==========
  {
    name: 'message_fatigue_score',
    extractor: (events) => {
      let shown = 0
      let dismisses = 0
      let noInteract = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'message_shown') {
          shown++
          contrib.push(e)
          if (!e.interacted) noInteract++
        } else if (e.type === 'message_dismiss') {
          dismisses++
          contrib.push(e)
        }
      }
      if (shown === 0) return NO_EVIDENCE
      return { value: clamp01((dismisses + noInteract * 0.5) / shown), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.05,
    weight: 0.7,
    minEvents: 2,
  },
  {
    name: 'message_responsiveness_score',
    extractor: (events) => {
      let shown = 0
      let interactions = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'message_shown') shown++
        else if (e.type === 'message_click' || e.type === 'message_close') {
          interactions++
          contrib.push(e)
        }
      }
      if (shown === 0) return NO_EVIDENCE
      return { value: clamp01(interactions / shown), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.1,
    weight: 0.6,
    minEvents: 2,
  },
  {
    name: 'dismiss_pattern_score',
    extractor: (events) => {
      let n = 0
      let sum = 0
      const contrib = []
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (e.type === 'message_dismiss') {
          n++
          sum += e.timeToDismiss || 0
          contrib.push(e)
        }
      }
      if (n < 2) return NO_EVIDENCE
      const avg = sum / n
      return { value: clamp01(1 - avg / 10000), contrib }
    },
    normalizer: (v) => v,
    defaultDecayRate: 0.08,
    weight: 0.5,
    minEvents: 2,
  },
]

// Helper para abandonment_probability (P1-5)
function computeAbandonmentInWindow(windowEvents) {
  let cartAbandons = 0
  let checkoutAbandons = 0
  let hasCheckout = false
  let hasPlaceOrder = false
  const contrib = []
  for (let i = 0; i < windowEvents.length; i++) {
    const e = windowEvents[i]
    if (e.type === 'cart_abandon') {
      cartAbandons++
      contrib.push(e)
    } else if (e.type === 'checkout_abandon') {
      checkoutAbandons++
      contrib.push(e)
    } else if (e.type === 'start_checkout') {
      hasCheckout = true
      contrib.push(e)
    } else if (e.type === 'place_order') {
      hasPlaceOrder = true
    }
  }
  if (hasPlaceOrder) return { value: 0, contrib: [] }
  if (hasCheckout) {
    return {
      value: clamp01(Math.min(0.8, (cartAbandons + checkoutAbandons) * CALIBRATION.cartAbandonWeight)),
      contrib,
    }
  }
  return {
    value: clamp01(Math.min(0.6, cartAbandons * CALIBRATION.cartAbandonNoCheckoutWeight)),
    contrib,
  }
}

// ========== RING BUFFER (P1-6) ==========
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity
    this.buf = new Array(capacity)
    this.start = 0
    this.size = 0
  }
  push(item) {
    if (this.size < this.capacity) {
      this.buf[(this.start + this.size) % this.capacity] = item
      this.size++
    } else {
      this.buf[this.start] = item
      this.start = (this.start + 1) % this.capacity
    }
  }
  toArray() {
    const out = new Array(this.size)
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(this.start + i) % this.capacity]
    return out
  }
  clear() {
    this.start = 0
    this.size = 0
    this.buf = new Array(this.capacity)
  }
  fromArray(arr) {
    this.clear()
    if (!Array.isArray(arr)) return
    const slice = arr.length > this.capacity ? arr.slice(arr.length - this.capacity) : arr
    for (let i = 0; i < slice.length; i++) this.push(slice[i])
  }
  get length() {
    return this.size
  }
}

// ========== LRU SIMPLE PARA DEDUP (P2-3) ==========
class SeenIds {
  constructor(cap) {
    this.cap = cap
    this.set = new Set()
    this.queue = []
  }
  has(id) {
    return this.set.has(id)
  }
  add(id) {
    if (this.set.has(id)) return
    this.set.add(id)
    this.queue.push(id)
    if (this.queue.length > this.cap) {
      const old = this.queue.shift()
      this.set.delete(old)
    }
  }
  snapshot() {
    return this.queue.slice()
  }
  restore(arr) {
    this.set = new Set()
    this.queue = []
    if (!Array.isArray(arr)) return
    for (let i = 0; i < arr.length; i++) this.add(arr[i])
  }
}

// ========== REPRESENTACIÓN DE SEÑAL ==========
class BehavioralSignal {
  constructor(name, config) {
    this.name = name
    this.config = config
    this.currentValue = 0
    this.confidence = MIN_CONFIDENCE
    this.contributingEventIds = [] // P2-1
    this.contribCount = 0
    this.lastUpdated = 0
    this.decayRate = config.defaultDecayRate
    this.volatility = 0
    this.history = []
    // sufficient stats para confidence acumulada
    this.lifetimeContribEvents = 0
  }

  /**
   * Actualiza el valor de la señal usando exponential smoothing
   * (combina el valor previo decayed con el nuevo) — P0-2.
   * value: valor crudo extraído ya normalizado a [0,1].
   * contribEvents: eventos que el extractor utilizó (P0-3, P2-1).
   * nowMs: timestamp lógico provisto por el manager (P1-1, P1-2).
   * decayedBaseline: valor previo ya decayed por el manager.
   */
  update(value, contribEvents, nowMs, decayedBaseline) {
    if (!Number.isFinite(value)) value = 0
    const clamped = clamp01(value)

    // Suavizado exponencial: combina baseline decayed con la nueva observación.
    // Esto es lo que hace que el decay efectivamente sobreviva (P0-2).
    const baseline = Number.isFinite(decayedBaseline) ? clamp01(decayedBaseline) : this.currentValue
    const blended = SMOOTHING_ALPHA * clamped + (1 - SMOOTHING_ALPHA) * baseline

    const prev = this.currentValue
    this.currentValue = clamp01(blended)

    // Contributing events (P2-1)
    const ids = []
    for (let i = 0; i < contribEvents.length; i++) {
      const id = contribEvents[i].id
      if (id != null) ids.push(id)
    }
    this.contributingEventIds = ids.slice(-32)
    this.contribCount = contribEvents.length
    this.lifetimeContribEvents += contribEvents.length

    // Confianza: P0-3 — basada en evidencia específica de la señal
    const effective = contribEvents.length < this.config.minEvents ? 0 : contribEvents.length
    let conf = CONFIDENCE_BASE + effective * CONFIDENCE_PER_EVENT
    if (conf > MAX_CONFIDENCE) conf = MAX_CONFIDENCE
    if (conf < MIN_CONFIDENCE) conf = MIN_CONFIDENCE
    if (contribEvents.length === 0) conf = MIN_CONFIDENCE
    this.confidence = conf

    this.lastUpdated = nowMs

    // Volatilidad: P2-2 — solo registra cambios significativos
    if (Math.abs(this.currentValue - prev) > VOLATILITY_EPSILON || this.history.length === 0) {
      this.history.push({ value: this.currentValue, timestamp: nowMs })
      const cutoff = nowMs - VOLATILITY_WINDOW_MS
      while (this.history.length > 0 && this.history[0].timestamp < cutoff) this.history.shift()
    }
    if (this.history.length > 1) {
      let s = 0
      for (let i = 0; i < this.history.length; i++) s += this.history[i].value
      const mean = s / this.history.length
      let v = 0
      for (let i = 0; i < this.history.length; i++) {
        const d = this.history[i].value - mean
        v += d * d
      }
      this.volatility = Math.sqrt(v / this.history.length)
    } else {
      this.volatility = 0
    }
  }

  /**
   * Aplica decay temporal. Devuelve el valor decayed sin sobrescribir
   * el estado interno (lo usa el manager como baseline). P1-2.
   */
  computeDecayed(minutesIdle) {
    if (!Number.isFinite(minutesIdle) || minutesIdle <= 0) return this.currentValue
    const decayed = this.currentValue * Math.exp(-this.decayRate * minutesIdle)
    return clamp01(decayed)
  }

  /**
   * Decay aplicado directamente (usado en tick() para señales no recalculadas).
   */
  applyDecay(minutesIdle, nowMs) {
    if (!Number.isFinite(minutesIdle) || minutesIdle <= 0) return
    this.currentValue = clamp01(this.currentValue * Math.exp(-this.decayRate * minutesIdle))
    this.confidence = Math.max(MIN_CONFIDENCE, this.confidence * Math.exp(-0.02 * minutesIdle))
    this.lastUpdated = nowMs
  }

  /** JSON con precisión completa (P2-8). */
  toJSON() {
    return {
      name: this.name,
      value: this.currentValue,
      confidence: this.confidence,
      volatility: this.volatility,
      lastUpdated: this.lastUpdated,
      contribEvents: this.contribCount,
      contribEventIds: this.contributingEventIds.slice(),
    }
  }

  /** Versión redondeada solo para presentación (P2-8). */
  toDisplayJSON() {
    return {
      name: this.name,
      value: +this.currentValue.toFixed(4),
      confidence: +this.confidence.toFixed(4),
      volatility: +this.volatility.toFixed(4),
      lastUpdated: this.lastUpdated,
      contribEvents: this.contribCount,
    }
  }

  snapshotState() {
    return {
      currentValue: this.currentValue,
      confidence: this.confidence,
      volatility: this.volatility,
      lastUpdated: this.lastUpdated,
      contribCount: this.contribCount,
      contributingEventIds: this.contributingEventIds.slice(),
      history: this.history.slice(),
      lifetimeContribEvents: this.lifetimeContribEvents,
    }
  }

  restoreState(s) {
    if (!s) return
    this.currentValue = clamp01(safeNumber(s.currentValue, 0))
    this.confidence = clamp01(safeNumber(s.confidence, MIN_CONFIDENCE))
    this.volatility = safeNumber(s.volatility, 0)
    this.lastUpdated = safeNumber(s.lastUpdated, 0)
    this.contribCount = safeNumber(s.contribCount, 0)
    this.contributingEventIds = Array.isArray(s.contributingEventIds) ? s.contributingEventIds.slice() : []
    this.history = Array.isArray(s.history) ? s.history.slice() : []
    this.lifetimeContribEvents = safeNumber(s.lifetimeContribEvents, 0)
  }

  reset() {
    this.currentValue = 0
    this.confidence = MIN_CONFIDENCE
    this.contributingEventIds = []
    this.contribCount = 0
    this.lastUpdated = 0
    this.volatility = 0
    this.history = []
    this.lifetimeContribEvents = 0
  }
}

// ========== SIGNAL MANAGER ==========
class SignalManager {
  constructor(options = {}) {
    this.signals = new Map()
    this.eventHistory = new RingBuffer(options.eventHistoryCap || EVENT_HISTORY_CAP)
    this.sessionContext = {}
    this.lastDecayTime = 0
    this.lastNow = 0
    this.seenIds = new SeenIds(options.seenIdsCap || SEEN_IDS_CAP)
    for (const cfg of SIGNAL_REGISTRY) {
      this.signals.set(cfg.name, new BehavioralSignal(cfg.name, cfg))
    }
  }

  /**
   * Ingesta un único evento.
   * @param {object} event - evento raw; debe traer `ts` (preferido) o se usa nowMs.
   * @param {number} nowMs - reloj lógico provisto por el caller (P1-1).
   */
  ingestEvent(event, nowMs) {
    if (typeof nowMs !== 'number') throw new Error('SignalManager.ingestEvent requires explicit nowMs');
    if (!event) return
    // Dedup por event.id (P2-3)
    if (event.id != null) {
      if (this.seenIds.has(event.id)) return
      this.seenIds.add(event.id)
    }
    if (typeof event.ts !== 'number') event.ts = nowMs
    this.eventHistory.push(event)
    this.lastNow = nowMs
    if (this.lastDecayTime === 0) this.lastDecayTime = nowMs
    this._recalculateAllSignals(nowMs)
    this.lastDecayTime = nowMs
  }

  /**
   * Ingesta en lote — un único recálculo al final (P2-7, P0-5).
   */
  ingestBatch(events, nowMs) {
    if (typeof nowMs !== 'number') throw new Error('SignalManager.ingestBatch requires explicit nowMs');
    if (!Array.isArray(events) || events.length === 0) return
    for (let i = 0; i < events.length; i++) {
      const e = events[i]
      if (!e) continue
      if (e.id != null) {
        if (this.seenIds.has(e.id)) continue
        this.seenIds.add(e.id)
      }
      if (typeof e.ts !== 'number') e.ts = nowMs
      this.eventHistory.push(e)
    }
    this.lastNow = nowMs
    if (this.lastDecayTime === 0) this.lastDecayTime = nowMs
    this._recalculateAllSignals(nowMs)
    this.lastDecayTime = nowMs
  }

  /**
   * Recálculo pasivo para señales tiempo-dependientes — no requiere evento (P1-1).
   * Aplica decay y reextrae únicamente las señales en TIME_DEPENDENT_SIGNALS.
   */
  tick(nowMs) {
    if (typeof nowMs !== 'number') throw new Error('SignalManager.tick requires explicit nowMs');
    if (this.lastDecayTime === 0) this.lastDecayTime = nowMs
    const minutesIdle = (nowMs - this.lastDecayTime) / 60000
    const events = this.eventHistory.toArray()
    for (const sig of this.signals.values()) {
      if (!TIME_DEPENDENT_SIGNALS.has(sig.name)) {
        // decay puro para el resto
        sig.applyDecay(minutesIdle, nowMs)
        continue
      }
      const decayed = sig.computeDecayed(minutesIdle)
      const result = sig.config.extractor(events, this.sessionContext, nowMs)
      if (result && result.value != null) {
        sig.update(result.value, result.contrib || [], nowMs, decayed)
      } else {
        sig.applyDecay(minutesIdle, nowMs)
      }
    }
    this.lastDecayTime = nowMs
    this.lastNow = nowMs
  }

  // Recalcula todas las señales (P0-2: decay como baseline en update).
  _recalculateAllSignals(nowMs) {
    const minutesIdle = (nowMs - this.lastDecayTime) / 60000
    const events = this.eventHistory.toArray()
    const ctx = this.sessionContext
    for (const sig of this.signals.values()) {
      const decayed = sig.computeDecayed(minutesIdle)
      const result = sig.config.extractor(events, ctx, nowMs)
      if (!result || result.value == null) {
        // Sin evidencia suficiente: dejamos baseline decayed y bajamos la confianza
        sig.currentValue = decayed
        sig.confidence = Math.max(MIN_CONFIDENCE, sig.confidence * Math.exp(-0.02 * Math.max(0, minutesIdle)))
        sig.lastUpdated = nowMs
        continue
      }
      const normalized = sig.config.normalizer(result.value)
      sig.update(normalized, result.contrib || [], nowMs, decayed)
    }
  }

  /**
   * Actualiza contexto. P2-4: NO fuerza recálculo; el siguiente ingest/tick lo hará.
   * Pasar `recalc: true` si se necesita forzar (compatibilidad con API previa).
   */
  updateContext(newContext, opts = {}) {
    this.sessionContext = { ...this.sessionContext, ...newContext }
    if (opts.recalc) {
      if (!this.lastNow) throw new Error('SignalManager.updateContext with recalc requires prior ingestEvent or explicit lastNow');
      this._recalculateAllSignals(this.lastNow);
    }
  }

  getAllSignals() {
    const out = {}
    for (const [name, sig] of this.signals.entries()) out[name] = sig.toJSON()
    return out
  }

  getAllSignalsDisplay() {
    const out = {}
    for (const [name, sig] of this.signals.entries()) out[name] = sig.toDisplayJSON()
    return out
  }

  getSignal(name) {
    const s = this.signals.get(name)
    return s ? s.toJSON() : null
  }

  /**
   * Snapshot completo: incluye eventHistory (P0-4), seenIds, estado por señal.
   */
  snapshot() {
    const sigs = {}
    for (const [name, sig] of this.signals.entries()) sigs[name] = sig.snapshotState()
    return {
      version: 2,
      timestamp: this.lastNow || 0,
      signals: sigs,
      eventHistory: this.eventHistory.toArray(),
      seenIds: this.seenIds.snapshot(),
      context: this.sessionContext,
      lastDecayTime: this.lastDecayTime,
    }
  }

  /**
   * Restaura desde snapshot. Soporta v1 (legacy: solo valores) y v2 (full).
   */
  restore(snap) {
    if (!snap) return
    const v = snap.version || 1
    this.sessionContext = snap.context || {}
    this.lastDecayTime = safeNumber(snap.lastDecayTime || snap.timestamp, 0)
    this.lastNow = safeNumber(snap.timestamp, this.lastDecayTime)

    if (v >= 2) {
      // Restauración completa (P0-4)
      this.eventHistory.fromArray(snap.eventHistory || [])
      this.seenIds.restore(snap.seenIds || [])
      if (snap.signals) {
        for (const [name, state] of Object.entries(snap.signals)) {
          const sig = this.signals.get(name)
          if (sig) sig.restoreState(state)
        }
      }
    } else {
      // Compat v1: no había eventHistory; restauramos solo valores escalares.
      // No recalculamos: dejamos que el próximo ingestBatch repueble.
      this.eventHistory.clear()
      this.seenIds.restore([])
      if (snap.signals) {
        for (const [name, data] of Object.entries(snap.signals)) {
          const sig = this.signals.get(name)
          if (!sig) continue
          sig.currentValue = clamp01(safeNumber(data.value, 0))
          sig.confidence = clamp01(safeNumber(data.confidence, MIN_CONFIDENCE))
          sig.volatility = safeNumber(data.volatility, 0)
          sig.lastUpdated = safeNumber(data.lastUpdated, this.lastDecayTime)
        }
      }
    }
  }

  reset() {
    this.eventHistory.clear()
    this.seenIds.restore([])
    this.sessionContext = {}
    this.lastDecayTime = 0
    this.lastNow = 0
    for (const sig of this.signals.values()) sig.reset()
  }

  getEventHistory() {
    return this.eventHistory.toArray()
  }
}

// ========== EXPORT ==========
module.exports = {
  SignalManager,
  BehavioralSignal,
  RingBuffer,
  SIGNAL_REGISTRY,
  SIGNAL_WEIGHTS,
  CALIBRATION,
  TIME_DEPENDENT_SIGNALS,
  DEFAULT_DECAY_RATE,
  MOMENTUM_WINDOW_MS,
  ACCEL_RECENT_WINDOW_MS,
  ACCEL_OLDER_WINDOW_MS,
  VOLATILITY_WINDOW_MS,
  CONFIDENCE_BASE,
  CONFIDENCE_PER_EVENT,
  MAX_CONFIDENCE,
  MIN_CONFIDENCE,
  EVENT_HISTORY_CAP,
  SMOOTHING_ALPHA,
  createSignalManager: (opts) => new SignalManager(opts),
  processEvents: (signalManager, eventsArray, nowMs) => {
    if (typeof nowMs !== 'number') throw new Error('SignalEngine.processEvents requires explicit nowMs');
    signalManager.ingestBatch(eventsArray, nowMs)
    return signalManager.getAllSignals()
  },
}
