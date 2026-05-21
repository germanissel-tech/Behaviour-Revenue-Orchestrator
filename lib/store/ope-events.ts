// =============================================================================
// OPE BEHAVIORAL EVENT SYSTEM
// Enterprise-grade event hooks for behavioral testing
// =============================================================================

export type OPEEventType =
  // Product visibility events
  | 'product:visible'
  | 'product:hidden'
  // Interaction events
  | 'product:hover'
  | 'product:hover_end'
  | 'product:click'
  | 'product:dwell'
  // Page events
  | 'pdp:open'
  | 'pdp:close'
  | 'pdp:scroll'
  // Cart events
  | 'cart:add'
  | 'cart:remove'
  | 'cart:quantity_change'
  | 'cart:view'
  | 'cart:hesitation'
  // Checkout events
  | 'checkout:start'
  | 'checkout:step'
  | 'checkout:complete'
  | 'checkout:abandon'
  // Session events
  | 'session:start'
  | 'session:end'
  | 'session:revisit'
  | 'session:duration_update'
  // Scroll/behavior events
  | 'scroll:velocity'
  | 'scroll:direction'
  | 'scroll:pause'
  // Category events
  | 'category:view'
  | 'category:change'
  // Search events
  | 'search:query'
  | 'search:result_click';

export interface OPEEvent {
  type: OPEEventType;
  timestamp: number;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface ProductVisibilityData {
  productId: string;
  category: string;
  canonicalType: string;
  visibilityRatio: number;
  viewportPosition: 'top' | 'center' | 'bottom';
}

export interface ProductHoverData {
  productId: string;
  category: string;
  canonicalType: string;
  duration?: number;
  cursorPath?: { x: number; y: number }[];
}

export interface ProductDwellData {
  productId: string;
  category: string;
  canonicalType: string;
  dwellTime: number;
  scrollPauses: number;
  returnVisits: number;
}

export interface PDPData {
  productId: string;
  category: string;
  canonicalType: string;
  price: number;
  timeOnPage?: number;
  scrollDepth?: number;
  imagesViewed?: number;
  reviewsExpanded?: boolean;
}

export interface CartEventData {
  productId: string;
  category: string;
  canonicalType: string;
  quantity: number;
  price: number;
  cartTotal: number;
  cartItemCount: number;
  previousQuantity?: number;
}

export interface CartHesitationData {
  cartTotal: number;
  cartItemCount: number;
  hesitationDuration: number;
  viewCount: number;
  mouseMovements: number;
}

export interface CheckoutEventData {
  step: 'cart' | 'shipping' | 'payment' | 'review' | 'complete';
  cartTotal: number;
  itemCount: number;
  duration?: number;
  abandonReason?: string;
}

export interface ScrollData {
  velocity: number;
  direction: 'up' | 'down';
  pauseDuration?: number;
  position: number;
  maxPosition: number;
}

export interface SessionData {
  sessionId: string;
  isRevisit: boolean;
  previousVisitTimestamp?: number;
  duration?: number;
  pageViews: number;
  productsViewed: string[];
  cartInteractions: number;
}

// =============================================================================
// OPE EVENT EMITTER
// =============================================================================

type EventCallback = (event: OPEEvent) => void;

class OPEEventEmitter {
  private listeners: Map<OPEEventType | '*', Set<EventCallback>> = new Map();
  private eventHistory: OPEEvent[] = [];
  private maxHistorySize = 1000;
  private sessionId: string;
  private sessionStartTime: number;

  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();
  }

  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionDuration(): number {
    return Date.now() - this.sessionStartTime;
  }

  on(type: OPEEventType | '*', callback: EventCallback): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }

  off(type: OPEEventType | '*', callback: EventCallback): void {
    this.listeners.get(type)?.delete(callback);
  }

  emit<T extends Record<string, unknown>>(type: OPEEventType, data: T): void {
    const event: OPEEvent = {
      type,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      data,
    };

    // Add to history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Notify specific listeners
    this.listeners.get(type)?.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('[OPE] Event callback error:', error);
      }
    });

    // Notify wildcard listeners
    this.listeners.get('*')?.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        console.error('[OPE] Wildcard callback error:', error);
      }
    });

    // Debug log in development
    if (process.env.NODE_ENV === 'development') {
      console.log('[OPE Event]', type, data);
    }
  }

  getEventHistory(): OPEEvent[] {
    return [...this.eventHistory];
  }

  getEventsByType(type: OPEEventType): OPEEvent[] {
    return this.eventHistory.filter(e => e.type === type);
  }

  clearHistory(): void {
    this.eventHistory = [];
  }

  // Session management
  startNewSession(): void {
    this.emit('session:end', {
      sessionId: this.sessionId,
      duration: this.getSessionDuration(),
    });

    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();
    this.clearHistory();

    this.emit('session:start', {
      sessionId: this.sessionId,
      isRevisit: false,
    });
  }

  markRevisit(previousTimestamp: number): void {
    this.emit('session:revisit', {
      sessionId: this.sessionId,
      previousVisitTimestamp: previousTimestamp,
      timeSinceLastVisit: Date.now() - previousTimestamp,
    });
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const opeEvents = new OPEEventEmitter();

// =============================================================================
// HELPER HOOKS FOR REACT COMPONENTS
// =============================================================================

export function emitProductVisible(data: ProductVisibilityData): void {
  opeEvents.emit('product:visible', data);
}

export function emitProductHidden(data: Omit<ProductVisibilityData, 'visibilityRatio' | 'viewportPosition'>): void {
  opeEvents.emit('product:hidden', data);
}

export function emitProductHover(data: ProductHoverData): void {
  opeEvents.emit('product:hover', data);
}

export function emitProductHoverEnd(data: ProductHoverData): void {
  opeEvents.emit('product:hover_end', data);
}

export function emitProductClick(data: Omit<ProductHoverData, 'duration' | 'cursorPath'>): void {
  opeEvents.emit('product:click', data);
}

export function emitProductDwell(data: ProductDwellData): void {
  opeEvents.emit('product:dwell', data);
}

export function emitPDPOpen(data: PDPData): void {
  opeEvents.emit('pdp:open', data);
}

export function emitPDPClose(data: PDPData): void {
  opeEvents.emit('pdp:close', data);
}

export function emitPDPScroll(data: PDPData & { scrollDepth: number }): void {
  opeEvents.emit('pdp:scroll', data);
}

export function emitCartAdd(data: CartEventData): void {
  opeEvents.emit('cart:add', data);
}

export function emitCartRemove(data: CartEventData): void {
  opeEvents.emit('cart:remove', data);
}

export function emitCartQuantityChange(data: CartEventData): void {
  opeEvents.emit('cart:quantity_change', data);
}

export function emitCartView(data: Omit<CartHesitationData, 'hesitationDuration' | 'mouseMovements'>): void {
  opeEvents.emit('cart:view', data);
}

export function emitCartHesitation(data: CartHesitationData): void {
  opeEvents.emit('cart:hesitation', data);
}

export function emitCheckoutStart(data: CheckoutEventData): void {
  opeEvents.emit('checkout:start', data);
}

export function emitCheckoutStep(data: CheckoutEventData): void {
  opeEvents.emit('checkout:step', data);
}

export function emitCheckoutComplete(data: CheckoutEventData): void {
  opeEvents.emit('checkout:complete', data);
}

export function emitCheckoutAbandon(data: CheckoutEventData): void {
  opeEvents.emit('checkout:abandon', data);
}

export function emitScrollVelocity(data: ScrollData): void {
  opeEvents.emit('scroll:velocity', data);
}

export function emitScrollPause(data: ScrollData): void {
  opeEvents.emit('scroll:pause', data);
}

export function emitCategoryView(data: { category: string; productCount: number }): void {
  opeEvents.emit('category:view', data);
}

export function emitSearch(data: { query: string; resultCount: number }): void {
  opeEvents.emit('search:query', data);
}

// =============================================================================
// DIAGNOSTIC EXPORTS FOR OPE INTEGRATION
// =============================================================================

export function getDiagnostics() {
  return {
    sessionId: opeEvents.getSessionId(),
    sessionDuration: opeEvents.getSessionDuration(),
    eventCount: opeEvents.getEventHistory().length,
    eventsByType: Object.fromEntries(
      ['product:visible', 'product:click', 'cart:add', 'pdp:open', 'checkout:start'].map(type => [
        type,
        opeEvents.getEventsByType(type as OPEEventType).length,
      ])
    ),
  };
}
