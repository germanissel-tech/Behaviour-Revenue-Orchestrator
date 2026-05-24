'use strict';

/**
 * human-message-engine.js
 *
 * Generates contextually appropriate, naturally-phrased advisor messages
 * based on the user's exact behavioral state and journey progression.
 *
 * Core design principles:
 * 1. Messages escalate in specificity as the user deepens engagement.
 * 2. Revisiting a product never shows the same message twice.
 * 3. Pre-remove intent (hovering trash icon) triggers a timely assist — not urgency.
 * 4. Cart hesitation gets a question, not a pressure tactic.
 * 5. Messages feel like a knowledgeable friend, never a salesperson.
 * 6. Category-aware: indumentaria, tecnología, hogar, and luxury get distinct voice.
 *
 * Integrates with:
 * - funnel-stage-engine (FUNNEL_STAGES)
 * - behavioral-intelligence-layer (micro-intentions)
 * - cart-intelligence-engine (cart type)
 * - ope-constants (INTENT_STATES)
 */

const { INTENT_STATES, FUNNEL_STAGES, STAGE_MESSAGE_CONFIG } = require('./ope-constants');

// ---------------------------------------------------------------------------
// Product category detection
// ---------------------------------------------------------------------------
const CATEGORY_PROFILES = Object.freeze({
  indumentaria: {
    keywords: ['ropa', 'vestido', 'pantalon', 'remera', 'camisa', 'zapatilla', 'zapato',
                'campera', 'jean', 'calza', 'buzo', 'talle', 'color', 'fashion', 'moda'],
    voice: 'social_fit',        // Focuses on style, occasion, social validation
    hesitationFocus: 'fit',     // Size and aesthetic compatibility
    urgencyApproach: 'scarcity_social', // "Queda poco de este talle"
  },
  tecnologia: {
    keywords: ['celular', 'laptop', 'notebook', 'tablet', 'auricular', 'camara', 'tv',
                'gaming', 'procesador', 'gb', 'ram', 'bateria', 'pantalla', 'tech'],
    voice: 'expert_clarity',    // Focuses on specs, compatibility, performance
    hesitationFocus: 'specs',
    urgencyApproach: 'feature_value', // "La actualización baja el precio"
  },
  hogar: {
    keywords: ['silla', 'mesa', 'lampara', 'sofa', 'cama', 'colchon', 'almohadon',
                'cortina', 'alfombra', 'estante', 'cocina', 'baño', 'deco', 'mueble'],
    voice: 'practical_fit',     // Focuses on space, utility, combination
    hesitationFocus: 'dimensions',
    urgencyApproach: 'availability', // "Stock limitado en este color"
  },
  luxury: {
    keywords: ['premium', 'lujo', 'exclusivo', 'edicion', 'limitada', 'artesanal',
                'cuero', 'seda', 'oro', 'plata', 'reloj', 'joya', 'perfume', 'alta gama'],
    voice: 'aspirational_exclusive',
    hesitationFocus: 'value',
    urgencyApproach: 'exclusivity', // "Pieza de edición limitada"
  },
});

function detectCategory(productMeta = {}) {
  const text = [
    productMeta.category || '',
    productMeta.name || '',
    productMeta.description || '',
    productMeta.tags?.join(' ') || '',
  ].join(' ').toLowerCase();

  for (const [cat, profile] of Object.entries(CATEGORY_PROFILES)) {
    if (profile.keywords.some(k => text.includes(k))) return cat;
  }
  return 'general';
}

// ---------------------------------------------------------------------------
// Message templates by behavioral moment
// Each template is a function to allow dynamic context injection.
// All messages are in natural, conversational Spanish.
// ---------------------------------------------------------------------------

const MESSAGES = Object.freeze({

  // -------------------------------------------------------------------------
  // LISTING — first visit
  // -------------------------------------------------------------------------
  listing_discovery: {
    general: [
      'Este es uno de los más elegidos esta semana.',
      'Tiene muy buenas reseñas de compradores frecuentes.',
      'Lo compran mucho quienes buscan calidad sin pagar de más.',
    ],
    indumentaria: [
      'Queda muy bien en varias ocasiones: casual o un poco más arreglado.',
      'Es de los que terminan usando seguido, no solo una vez.',
      'Los talles están disponibles en este momento — algo que no siempre pasa.',
    ],
    tecnologia: [
      'Tiene una relación precio-prestaciones difícil de igualar en este rango.',
      'Es compatible con la mayoría de los equipos que ya tenés.',
      'Los que lo compran generalmente vuelven satisfechos.',
    ],
    hogar: [
      'Funciona bien en espacios de distintos tamaños.',
      'Lo combinan fácil con lo que ya existe en el ambiente.',
      'Tiene una durabilidad por encima del promedio en su categoría.',
    ],
    luxury: [
      'Es una pieza que gana valor con el tiempo.',
      'Está hecho con materiales que muy pocos productos en esta categoría usan.',
      'Pocas unidades disponibles en este momento.',
    ],
  },

  // -------------------------------------------------------------------------
  // LISTING — revisit (user came back to the same product)
  // -------------------------------------------------------------------------
  listing_revisit: {
    general: [
      '¿Quedaste pensando en este? Tiene sentido — es de los que valen la pena.',
      'Volviste a verlo. Algo llamó tu atención. ¿Querés más detalle?',
      'Este producto tiene bastantes fans que también lo miraron varias veces antes de decidir.',
    ],
    indumentaria: [
      'Si la duda es el talle, podés ver la guía de medidas — suele aclarar bastante.',
      'Lo miraste antes. ¿Es por el color o la talla? Puedo ayudarte con eso.',
      'Los que lo miran varias veces suelen terminar eligiéndolo — el estilo convence.',
    ],
    tecnologia: [
      '¿La duda es técnica? Puedo orientarte sobre qué modelo se adapta mejor a tu uso.',
      'Volviste a verlo — ¿hay alguna especificación que te genera duda?',
      'Es uno de los que merece tomarse el tiempo para decidir bien.',
    ],
    hogar: [
      '¿Quedó la duda de si entraría en tu espacio? Las medidas están en la descripción.',
      'Volviste a verlo. Si la duda es de combinación, suele quedar bien con neutros.',
      'Muchos lo compran después de verlo más de una vez — hace bien pensar.',
    ],
    luxury: [
      'Las piezas de esta categoría merecen tomarse el tiempo. ¿Alguna duda puntual?',
      'Volviste a verlo — estas cosas hay que sentirlas bien antes de decidir.',
      'Pocas unidades disponibles. Si te interesa, conviene no esperar mucho.',
    ],
  },

  // -------------------------------------------------------------------------
  // MODAL — first open (user is evaluating details)
  // -------------------------------------------------------------------------
  modal_evaluation: {
    general: [
      'Las reseñas mencionan especialmente la calidad del material.',
      'Este producto tiene política de devolución dentro de los 30 días.',
      'Es de los que la gente compra pensando en el largo plazo.',
    ],
    indumentaria: [
      'El talle suele ser fiel a la descripción — si sos entre tallas, los que lo compraron recomiendan el mayor.',
      'El color en pantalla es bastante fiel al real en esta categoría.',
      'Lo combinan bien con básicos: se adapta a varios looks.',
    ],
    tecnologia: [
      'Tiene garantía de fábrica de 12 meses.',
      'Los accesorios que usás habitualmente son compatibles con este modelo.',
      'Consume menos batería de lo que parece por sus prestaciones.',
    ],
    hogar: [
      'Viene listo para usar — sin instalación compleja.',
      'El material es resistente al uso cotidiano sin necesitar mantenimiento especial.',
      'Las medidas permiten ubicarlo en espacios estándar sin dificultad.',
    ],
    luxury: [
      'Cada pieza pasa por un control de calidad manual antes de salir.',
      'Los materiales provienen de producción limitada — garantiza exclusividad.',
      'Tiene certificado de autenticidad incluido.',
    ],
  },

  // -------------------------------------------------------------------------
  // MODAL — hesitation detected (user is going back and forth on variants)
  // -------------------------------------------------------------------------
  modal_hesitation: {
    general: [
      '¿Tenés alguna duda puntual? A veces un detalle termina de aclararlo todo.',
      'Si la duda es entre dos opciones, los que lo compraron suelen recomendar la más versátil.',
      'Es normal tomarse el tiempo — es una compra que vale la pena hacer bien.',
    ],
    indumentaria: [
      '¿La duda es entre colores o talles? Ambos tienen ventajas — depende de tu uso habitual.',
      'Si no estás seguro del talle, los compradores frecuentes recomiendan pedir el mayor cuando hay duda.',
      '¿Querés saber con qué prendas combina mejor? Puedo orientarte.',
    ],
    tecnologia: [
      '¿La duda es entre dos modelos? Puedo ayudarte a ver cuál se adapta mejor a tu uso real.',
      'Los que dudaron entre estas opciones terminaron eligiendo según el uso más frecuente.',
      '¿Hay alguna función específica que estás evaluando?',
    ],
    hogar: [
      '¿La duda es sobre medidas o combinación? Ambas tienen respuesta clara.',
      'Si no estás seguro de cómo entraría en tu espacio, las medidas están en la ficha técnica.',
      '¿Querés saber cómo lo combinan habitualmente?',
    ],
    luxury: [
      'Es una decisión que merece estar seguro. ¿Hay alguna duda puntual que pueda aclarar?',
      'En esta categoría, tomarse el tiempo siempre vale más que apresurarse.',
      '¿La duda es sobre algún detalle específico del producto?',
    ],
  },

  // -------------------------------------------------------------------------
  // MODAL — high intent, about to add to cart
  // -------------------------------------------------------------------------
  modal_high_intent: {
    general: [
      'Buena elección. Tiene todo lo que buscás en un producto de esta categoría.',
      'Si decidís llevarlo, el proceso de compra es muy simple.',
      'Los que lo eligieron volvieron satisfechos.',
    ],
    indumentaria: [
      'El talle que elegiste tiene disponibilidad ahora.',
      'Buena elección — es un básico que siempre rinde.',
      'Va a quedar bien — confiá en tu elección.',
    ],
    tecnologia: [
      'Es la configuración que más se adapta a lo que describiste.',
      'Vas a notar la diferencia desde el primer uso.',
      'Buena decisión — en este rango es difícil encontrar mejor relación calidad-precio.',
    ],
    hogar: [
      'Va a quedar bien en ese espacio.',
      'Es una compra que vas a agradecer en el día a día.',
      'Buena elección para el uso que le vas a dar.',
    ],
    luxury: [
      'Es una inversión que vale cada peso.',
      'Estás eligiendo algo que va a durar mucho tiempo.',
      'Es de los que con el tiempo apreciás cada vez más.',
    ],
  },

  // -------------------------------------------------------------------------
  // CART — product just added
  // -------------------------------------------------------------------------
  cart_just_added: {
    general: [
      'Buena elección. El envío llega en los próximos días hábiles.',
      'Podés devolverlo dentro de los 30 días si algo no cierra.',
      'Lo tenés en el carrito. Cuando estés listo, el checkout es rápido.',
    ],
    indumentaria: [
      'Si el talle no es exactamente lo que esperabas, el cambio es sin costo.',
      'Guardaste una buena opción. El stock de este talle puede cambiar.',
      'Las devoluciones por talle son sin costo — así que sin presión.',
    ],
    tecnologia: [
      'Viene con garantía de fábrica — cualquier defecto está cubierto.',
      'El envío incluye embalaje protegido para este tipo de producto.',
      'Si al abrirlo algo no funciona, el proceso de cambio es inmediato.',
    ],
    hogar: [
      'Se envía con protección especial para que llegue en perfectas condiciones.',
      'Si las medidas no encajan como esperabas, la devolución es simple.',
      'Buena adición. Es de los que se usan a diario sin pensar.',
    ],
    luxury: [
      'El embalaje es premium — llega como corresponde a un producto de esta categoría.',
      'Tiene seguro de envío incluido.',
      'Elegiste bien. Es una pieza que vale cada peso.',
    ],
  },

  // -------------------------------------------------------------------------
  // CART — hesitation (long dwell without action)
  // -------------------------------------------------------------------------
  cart_hesitation: {
    general: [
      '¿Hay algo que te genera duda antes de completar la compra?',
      'Podés seguir mirando sin perderlo — está guardado acá.',
      '¿Es por el costo de envío o algún otro detalle?',
    ],
    indumentaria: [
      '¿La duda es sobre el talle? El cambio sin costo hace que sea bajo riesgo.',
      '¿Quedó alguna duda sobre cómo quedaría? El retorno es fácil si no es lo que esperabas.',
      '¿Estás esperando algún descuento? Puedo decirte si hubo movimiento de precio.',
    ],
    tecnologia: [
      '¿La duda es técnica? Puedo aclarar alguna especificación antes de que decidas.',
      '¿Estás comparando con otra opción? Cuéntame y te oriento.',
      '¿Es el precio lo que detiene la decisión?',
    ],
    hogar: [
      '¿La duda es si entraría bien en tu espacio?',
      '¿Quedó alguna duda sobre el armado o el envío?',
      '¿Estás esperando ver si baja de precio?',
    ],
    luxury: [
      '¿Hay algún detalle del producto sobre el que querés más información antes de decidir?',
      'Tomarse el tiempo está bien — es una inversión que tiene que estar clara.',
      '¿Es el primer artículo de esta categoría que comprás? Con gusto te explico qué esperar.',
    ],
  },

  // -------------------------------------------------------------------------
  // CART — pre-remove intent (user hovering the remove button)
  // This is the most critical moment: a well-timed question can save the sale
  // WITHOUT feeling manipulative.
  // -------------------------------------------------------------------------
  cart_pre_remove: {
    general: [
      '¿Encontraste algo mejor? Con gusto te ayudo a comparar.',
      'Antes de sacarlo — ¿hay algo puntual que no terminó de convencerte?',
      '¿Es por el precio, el envío o algo del producto en sí?',
    ],
    indumentaria: [
      '¿La duda es el talle? El cambio es sin costo, así que hay poco riesgo.',
      '¿No terminó de convencerte el color? Hay otras opciones del mismo modelo.',
      'Antes de sacarlo — ¿qué fue lo que dudaste?',
    ],
    tecnologia: [
      '¿Encontraste una opción más conveniente? Cuéntame y lo comparamos.',
      '¿La duda es técnica? Puedo orientarte antes de que decidas.',
      'Antes de sacarlo — ¿qué te generó la duda?',
    ],
    hogar: [
      '¿El tamaño no cerraba? Te cuento si hay una variante que se adapte mejor.',
      '¿Cambiaste de idea sobre el espacio donde lo ibas a poner?',
      'Antes de sacarlo — ¿qué fue lo que dudaste?',
    ],
    luxury: [
      '¿Querés pensarlo más? Podés guardarlo en favoritos sin perderlo.',
      'Antes de sacarlo — ¿hay algo puntual del producto que no quedó claro?',
      'Las piezas de esta categoría valen la pena pensarlas bien — pero el stock cambia.',
    ],
  },

  // -------------------------------------------------------------------------
  // CART — post remove (user just removed an item)
  // -------------------------------------------------------------------------
  cart_post_remove: {
    general: [
      'Lo quitaste. Si lo querés volver a agregar, está disponible.',
      'Si fue por el precio, avisame — a veces hay alternativas.',
      '¿Encontraste algo que se adapte mejor a lo que buscabas?',
    ],
    indumentaria: [
      'Lo sacaste. Si la duda era el talle, podés probar con el próximo y devolver sin costo.',
      '¿Cambiaste por otro modelo o lo descartaste por completo?',
    ],
    tecnologia: [
      'Lo sacaste. ¿Era por las especificaciones o el precio?',
      'Si la duda era técnica, podés decirme tu uso principal y te oriento hacia algo que encaje mejor.',
    ],
    hogar: [
      'Lo sacaste. ¿Fue por las medidas o por otra razón?',
      'Si querés una alternativa del mismo estilo pero diferente tamaño, puedo orientarte.',
    ],
    luxury: [
      'Lo sacaste. Si fue por el precio, a veces hay formas de hacerlo más accesible.',
      '¿Querés que te muestre alternativas en un rango similar?',
    ],
  },

  // -------------------------------------------------------------------------
  // CHECKOUT — final reassurance
  // -------------------------------------------------------------------------
  checkout_reassurance: {
    general: [
      'Todo en orden. El proceso es seguro y el envío está confirmado.',
      'Tomaste una buena decisión. Podés completar la compra con confianza.',
      'Una vez confirmado, el seguimiento es en tiempo real.',
    ],
    indumentaria: [
      'Si algo no encaja como esperabas, el proceso de cambio es simple y sin costo.',
    ],
    tecnologia: [
      'Viene con garantía completa. Cualquier inconveniente está cubierto.',
    ],
    hogar: [
      'El envío está asegurado — llega en perfectas condiciones.',
    ],
    luxury: [
      'Es una muy buena adquisición. Llegará con el embalaje y los certificados correspondientes.',
    ],
  },

  // -------------------------------------------------------------------------
  // RETURN RISK — impulsive buyer patterns detected
  // -------------------------------------------------------------------------
  return_risk_clarity: {
    general: [
      'Antes de confirmar — ¿revisaste las medidas o el talle?',
      'Compraste rápido — eso está bien. Solo asegurate de la variante que elegiste.',
      'Un detalle a chequear: ¿es el modelo que necesitás para tu uso habitual?',
    ],
    indumentaria: [
      '¿Chequeaste el talle contra la guía? Vale la pena un minuto antes de confirmar.',
      '¿Es para uso habitual o para una ocasión específica? Eso puede cambiar el talle ideal.',
    ],
    tecnologia: [
      '¿Chequeaste que sea compatible con lo que ya tenés?',
      '¿La versión que elegiste tiene las funciones que buscabas?',
    ],
    hogar: [
      '¿Mediste el espacio donde va a ir? Las medidas están en la ficha técnica.',
      '¿Es el color que se adapta mejor al ambiente?',
    ],
    luxury: [
      '¿Es el modelo que tenías en mente? En esta categoría, vale asegurarse del detalle.',
    ],
  },

});

// ---------------------------------------------------------------------------
// Core selection function
// ---------------------------------------------------------------------------

/**
 * selectMessage(context) — returns the best natural message for the moment.
 *
 * @param {object} context
 * @param {string} context.moment — one of the MESSAGES keys above
 * @param {string} [context.category] — product category string (raw metadata)
 * @param {object} [context.productMeta] — {name, category, tags, description}
 * @param {string} [context.sessionId]
 * @param {number} [context.revisitCount] — how many times this product was visited
 * @param {string[]} [context.shownMessages] — message texts already shown this session
 * @param {number} [context.nowMs]
 * @returns {{ text: string, moment: string, category: string, wasFiltered: boolean } | null}
 */
function selectMessage(context = {}) {
  const {
    moment,
    category: rawCategory,
    productMeta = {},
    shownMessages = [],
    revisitCount = 0,
  } = context;

  const detectedCategory = rawCategory || detectCategory(productMeta);
  const momentMessages = MESSAGES[moment];
  if (!momentMessages) return null;

  // Get category-specific messages, fallback to general
  const candidates = momentMessages[detectedCategory] || momentMessages.general || [];
  if (!candidates.length) return null;

  // Filter out already-shown messages
  const fresh = candidates.filter(m => !shownMessages.includes(m));
  const pool = fresh.length > 0 ? fresh : candidates; // fallback to all if exhausted

  // Select deterministically based on revisit count to ensure progression
  const index = revisitCount % pool.length;
  const text = pool[index];

  return {
    text,
    moment,
    category: detectedCategory,
    wasFiltered: fresh.length === 0,
  };
}

/**
 * getMomentForContext(params) — maps behavioral signals to a message moment key.
 *
 * @param {object} params
 * @param {string} params.context — 'listing' | 'modal' | 'cart' | 'checkout'
 * @param {string} params.funnelStage — FUNNEL_STAGES value
 * @param {string} params.intentState — INTENT_STATES value
 * @param {string} params.microIntention — from behavioral-intelligence-layer
 * @param {boolean} params.isRevisit — user has seen this product before
 * @param {boolean} params.isPreRemoveIntent — user hovering remove button
 * @param {boolean} params.isPostRemove — user just removed item
 * @param {boolean} [params.returnRiskHigh]
 * @returns {string|null} moment key
 */
function getMomentForContext(params) {
  const {
    context,
    funnelStage,
    intentState,
    microIntention,
    isRevisit = false,
    isPreRemoveIntent = false,
    isPostRemove = false,
    returnRiskHigh = false,
  } = params;

  // Cart remove events take absolute priority — they are time-sensitive
  if (isPreRemoveIntent) return 'cart_pre_remove';
  if (isPostRemove) return 'cart_post_remove';

  // Return-risk clarity message overrides normal cart/modal messages
  if (returnRiskHigh && (context === 'cart' || context === 'modal')) {
    return 'return_risk_clarity';
  }

  switch (context) {
    case 'listing':
      return isRevisit ? 'listing_revisit' : 'listing_discovery';

    case 'modal':
    case 'product_detail':
      if (intentState === INTENT_STATES.HIGH_INTENT || funnelStage === FUNNEL_STAGES.PURCHASE_INTENT) {
        return 'modal_high_intent';
      }
      if (microIntention === 'hesitating' || microIntention === 'uncertain' ||
          intentState === INTENT_STATES.HESITATING) {
        return 'modal_hesitation';
      }
      return 'modal_evaluation';

    case 'cart':
      if (funnelStage === FUNNEL_STAGES.POST_CART_HESITATION ||
          microIntention === 'hesitating' || microIntention === 'uncertain') {
        return 'cart_hesitation';
      }
      return 'cart_just_added';

    case 'checkout':
      return 'checkout_reassurance';

    default:
      return null;
  }
}

/**
 * getMessageForSession(sessionState) — main entry point for orchestrators.
 *
 * Takes the full current session behavioral state and returns the most
 * appropriate natural message, or null if no intervention is warranted.
 *
 * @param {object} sessionState — combined state from all engines
 * @param {string} sessionState.context
 * @param {string} sessionState.funnelStage
 * @param {string} sessionState.intentState
 * @param {string} sessionState.microIntention
 * @param {boolean} sessionState.isRevisit
 * @param {number} sessionState.revisitCount
 * @param {boolean} sessionState.isPreRemoveIntent
 * @param {boolean} sessionState.isPostRemove
 * @param {boolean} sessionState.returnRiskHigh
 * @param {object} sessionState.productMeta
 * @param {string[]} sessionState.shownMessages — already-shown messages this session
 * @param {number} sessionState.nowMs
 * @returns {{ text: string, moment: string, category: string } | null}
 */
function getMessageForSession(sessionState) {
  const moment = getMomentForContext(sessionState);
  if (!moment) return null;

  return selectMessage({
    moment,
    productMeta: sessionState.productMeta || {},
    shownMessages: sessionState.shownMessages || [],
    revisitCount: sessionState.revisitCount || 0,
    nowMs: sessionState.nowMs,
  });
}

/**
 * isRevisit(productId, sessionProductHistory) — determines if user has seen
 * this product before in the current session.
 *
 * @param {string} productId
 * @param {Array} sessionProductHistory — from behavioral-intelligence-layer
 * @returns {{ isRevisit: boolean, revisitCount: number }}
 */
function isRevisit(productId, sessionProductHistory = []) {
  const views = sessionProductHistory.filter(p => p.productId === productId);
  return {
    isRevisit: views.length > 1,
    revisitCount: Math.max(0, views.length - 1),
  };
}

// ---------------------------------------------------------------------------
// Cart remove intent detection — to be called by logger-v2 or orchestrator
// when user's mouse/touch enters the remove button area
// ---------------------------------------------------------------------------

const _removeIntentTimers = new Map(); // productId -> { startedAt, nowMs }

/**
 * signalRemoveIntent(productId, nowMs) — records that user is hovering the remove button.
 * Returns true if the intent has been held long enough to trigger a message (> 400ms).
 */
function signalRemoveIntent(productId, nowMs) {
  if (!_removeIntentTimers.has(productId)) {
    _removeIntentTimers.set(productId, { startedAt: nowMs });
    return false;
  }
  const { startedAt } = _removeIntentTimers.get(productId);
  return (nowMs - startedAt) >= 400; // 400ms hover threshold
}

/**
 * clearRemoveIntent(productId) — clears the intent when the user moves away.
 */
function clearRemoveIntent(productId) {
  _removeIntentTimers.delete(productId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  // Main entry points
  getMessageForSession,
  getMomentForContext,
  selectMessage,

  // Utilities
  detectCategory,
  isRevisit,
  signalRemoveIntent,
  clearRemoveIntent,

  // Constants
  MESSAGES,
  CATEGORY_PROFILES,
};
