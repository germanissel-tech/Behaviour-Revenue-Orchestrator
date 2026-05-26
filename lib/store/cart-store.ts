'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Product } from './products';
import { emitCartAdd, emitCartRemove, emitCartQuantityChange, emitCartHesitation, opeEvents } from './ope-events';

export interface CartItem {
  product: Product;
  quantity: number;
  addedAt: number;
}

interface CartState {
  items: CartItem[];
  isOpen: boolean;
  lastInteraction: number;
  viewCount: number;
  
  // Actions
  addItem: (product: Product, quantity?: number) => void;
  removeItem: (productId: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  clearCart: () => void;
  toggleCart: () => void;
  openCart: () => void;
  closeCart: () => void;
  recordView: () => void;
  
  // Computed
  getTotal: () => number;
  getItemCount: () => number;
  getItem: (productId: string) => CartItem | undefined;
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
      isOpen: false,
      lastInteraction: Date.now(),
      viewCount: 0,

      addItem: (product: Product, quantity = 1) => {
        const currentItems = get().items;
        const existingItem = currentItems.find(item => item.product.id === product.id);
        const cartTotal = get().getTotal();
        const cartItemCount = get().getItemCount();

        if (existingItem) {
          set({
            items: currentItems.map(item =>
              item.product.id === product.id
                ? { ...item, quantity: item.quantity + quantity }
                : item
            ),
            lastInteraction: Date.now(),
          });
        } else {
          set({
            items: [...currentItems, { product, quantity, addedAt: Date.now() }],
            lastInteraction: Date.now(),
          });
        }

        // Emit OPE event
        emitCartAdd({
          productId: product.id,
          category: product.category,
          canonicalType: product.canonicalType,
          quantity: existingItem ? existingItem.quantity + quantity : quantity,
          price: product.price,
          cartTotal: cartTotal + (product.price * quantity),
          cartItemCount: cartItemCount + quantity,
          previousQuantity: existingItem?.quantity,
        });
      },

      removeItem: (productId: string) => {
        const currentItems = get().items;
        const item = currentItems.find(i => i.product.id === productId);
        
        if (item) {
          const cartTotal = get().getTotal();
          const cartItemCount = get().getItemCount();

          set({
            items: currentItems.filter(i => i.product.id !== productId),
            lastInteraction: Date.now(),
          });

          // Emit OPE event
          emitCartRemove({
            productId: item.product.id,
            category: item.product.category,
            canonicalType: item.product.canonicalType,
            quantity: 0,
            price: item.product.price,
            cartTotal: cartTotal - (item.product.price * item.quantity),
            cartItemCount: cartItemCount - item.quantity,
            previousQuantity: item.quantity,
          });
        }
      },

      updateQuantity: (productId: string, quantity: number) => {
        const currentItems = get().items;
        const item = currentItems.find(i => i.product.id === productId);
        
        if (item && quantity > 0) {
          const previousQuantity = item.quantity;
          const cartTotal = get().getTotal();
          const cartItemCount = get().getItemCount();
          const quantityDiff = quantity - previousQuantity;

          set({
            items: currentItems.map(i =>
              i.product.id === productId ? { ...i, quantity } : i
            ),
            lastInteraction: Date.now(),
          });

          // Emit OPE event
          emitCartQuantityChange({
            productId: item.product.id,
            category: item.product.category,
            canonicalType: item.product.canonicalType,
            quantity,
            price: item.product.price,
            cartTotal: cartTotal + (item.product.price * quantityDiff),
            cartItemCount: cartItemCount + quantityDiff,
            previousQuantity,
          });
        } else if (quantity <= 0) {
          get().removeItem(productId);
        }
      },

      clearCart: () => {
        set({ items: [], lastInteraction: Date.now() });
      },

      toggleCart: () => {
        const isOpen = !get().isOpen;
        set({ isOpen, lastInteraction: Date.now() });
        if (isOpen) get().recordView();
      },

      openCart: () => {
        set({ isOpen: true, lastInteraction: Date.now() });
        get().recordView();
      },

      closeCart: () => {
        set({ isOpen: false, lastInteraction: Date.now() });
      },

      recordView: () => {
        const currentViewCount = get().viewCount + 1;
        set({ viewCount: currentViewCount });

        // Emit hesitation event if multiple views
        if (currentViewCount > 1) {
          const timeSinceLastInteraction = Date.now() - get().lastInteraction;
          emitCartHesitation({
            cartTotal: get().getTotal(),
            cartItemCount: get().getItemCount(),
            hesitationDuration: timeSinceLastInteraction,
            viewCount: currentViewCount,
            mouseMovements: 0, // Would be tracked separately
          });
        }
      },

      getTotal: () => {
        return get().items.reduce(
          (total, item) => total + item.product.price * item.quantity,
          0
        );
      },

      getItemCount: () => {
        return get().items.reduce((count, item) => count + item.quantity, 0);
      },

      getItem: (productId: string) => {
        return get().items.find(item => item.product.id === productId);
      },
    }),
    {
      name: 'ope-cart-storage',
      partialize: (state) => ({
        items: state.items,
        viewCount: state.viewCount,
      }),
    }
  )
);

// Track cart hesitation behavior
let hesitationTimer: ReturnType<typeof setTimeout> | null = null;
let mouseMovementCount = 0;

if (typeof window !== 'undefined') {
  // Track mouse movements when cart is open
  document.addEventListener('mousemove', () => {
    const store = useCartStore.getState();
    if (store.isOpen) {
      mouseMovementCount++;
    }
  });

  // Subscribe to cart state changes
  useCartStore.subscribe((state, prevState) => {
    // Detect hesitation: cart open for > 5 seconds without interaction
    if (state.isOpen && state.items.length > 0) {
      if (hesitationTimer) clearTimeout(hesitationTimer);
      
      hesitationTimer = setTimeout(() => {
        emitCartHesitation({
          cartTotal: state.getTotal(),
          cartItemCount: state.getItemCount(),
          hesitationDuration: 5000,
          viewCount: state.viewCount,
          mouseMovements: mouseMovementCount,
        });
        mouseMovementCount = 0;
      }, 5000);
    } else {
      if (hesitationTimer) {
        clearTimeout(hesitationTimer);
        hesitationTimer = null;
      }
      mouseMovementCount = 0;
    }
  });
}
