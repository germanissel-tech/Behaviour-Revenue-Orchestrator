'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { X, Plus, Minus, Trash2, ShoppingBag, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useCartStore } from '@/lib/store/cart-store';
import { emitCartView } from '@/lib/store/ope-events';

export function CartSidebar() {
  const { 
    items, 
    isOpen, 
    closeCart, 
    removeItem, 
    updateQuantity, 
    getTotal, 
    getItemCount,
    clearCart 
  } = useCartStore();
  
  const total = getTotal();
  const itemCount = getItemCount();
  const overlayRef = useRef<HTMLDivElement>(null);

  // Emit cart view event when opened
  useEffect(() => {
    if (isOpen) {
      emitCartView({ cartTotal: total, cartItemCount: itemCount, viewCount: 1 });
    }
  }, [isOpen, total, itemCount]);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCart();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeCart]);

  // Prevent body scroll when cart is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div
        ref={overlayRef}
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={closeCart}
      />
      
      {/* Sidebar */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-background shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Tu Carrito</h2>
            <span className="text-sm text-muted-foreground">
              ({itemCount} {itemCount === 1 ? 'producto' : 'productos'})
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={closeCart}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Cart items */}
        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <ShoppingBag className="h-16 w-16 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-2">Tu carrito está vacío</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Agrega productos para comenzar
            </p>
            <Button onClick={closeCart}>
              Seguir comprando
            </Button>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-4">
                {items.map((item) => (
                  <div
                    key={item.product.id}
                    className="flex gap-3 p-3 rounded-lg bg-muted/50"
                  >
                    {/* Product image */}
                    <Link
                      href={`/product/${item.product.id}`}
                      className="relative h-20 w-20 shrink-0 rounded-md overflow-hidden bg-muted"
                      onClick={closeCart}
                    >
                      <Image
                        src={item.product.image}
                        alt={item.product.name}
                        fill
                        className="object-cover"
                        sizes="80px"
                      />
                    </Link>

                    {/* Product details */}
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/product/${item.product.id}`}
                        className="block"
                        onClick={closeCart}
                      >
                        <p className="text-xs text-muted-foreground">{item.product.brand}</p>
                        <h4 className="font-medium text-sm line-clamp-2 hover:text-primary transition-colors">
                          {item.product.name}
                        </h4>
                      </Link>
                      
                      <div className="flex items-center justify-between mt-2">
                        {/* Quantity controls */}
                        <div className="flex items-center gap-1 bg-background rounded-md border">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => updateQuantity(item.product.id, item.quantity - 1)}
                          >
                            <Minus className="h-3 w-3" />
                          </Button>
                          <span className="w-6 text-center text-sm font-medium">
                            {item.quantity}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => updateQuantity(item.product.id, item.quantity + 1)}
                          >
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>

                        {/* Price */}
                        <div className="text-right">
                          <p className="font-semibold">
                            ${(item.product.price * item.quantity).toLocaleString('es-CL')}
                          </p>
                          {item.quantity > 1 && (
                            <p className="text-xs text-muted-foreground">
                              ${item.product.price.toLocaleString('es-CL')} c/u
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Remove button */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeItem(item.product.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>

            {/* Footer */}
            <div className="border-t p-4 space-y-4">
              {/* Subtotal */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>${total.toLocaleString('es-CL')}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Envío</span>
                  <span className={total >= 50000 ? 'text-primary font-medium' : ''}>
                    {total >= 50000 ? 'GRATIS' : '$4.990'}
                  </span>
                </div>
                <Separator />
                <div className="flex items-center justify-between font-semibold">
                  <span>Total</span>
                  <span className="text-lg">
                    ${(total < 50000 ? total + 4990 : total).toLocaleString('es-CL')}
                  </span>
                </div>
                {total < 50000 && (
                  <p className="text-xs text-muted-foreground text-center">
                    Agrega ${(50000 - total).toLocaleString('es-CL')} más para envío gratis
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="grid gap-2">
                <Button asChild size="lg" className="w-full">
                  <Link href="/checkout" onClick={closeCart}>
                    Finalizar compra
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="outline" size="lg" className="w-full" onClick={closeCart}>
                  Seguir comprando
                </Button>
              </div>

              {/* Clear cart */}
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-destructive"
                onClick={clearCart}
              >
                Vaciar carrito
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
