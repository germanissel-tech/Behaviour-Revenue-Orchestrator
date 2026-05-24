'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRef, useEffect, useState, useCallback } from 'react';
import { Star, Plus, Minus, ShoppingCart, Heart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Product } from '@/lib/store/products';
import { useCartStore } from '@/lib/store/cart-store';
import {
  emitProductVisible,
  emitProductHidden,
  emitProductHover,
  emitProductHoverEnd,
  emitProductClick,
  emitProductDwell,
  opeEvents,
} from '@/lib/store/ope-events';

interface ProductCardProps {
  product: Product;
  priority?: boolean;
}

export function ProductCard({ product, priority = false }: ProductCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { addItem, getItem, updateQuantity } = useCartStore();
  const cartItem = getItem(product.id);
  
  // OPE tracking state
  const [isVisible, setIsVisible] = useState(false);
  const [hoverStartTime, setHoverStartTime] = useState<number | null>(null);
  const [dwellTime, setDwellTime] = useState(0);
  const [returnVisits, setReturnVisits] = useState(0);
  const dwellIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track visibility with IntersectionObserver
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isVisible) {
            setIsVisible(true);
            setReturnVisits(prev => prev + 1);
            
            const rect = entry.boundingClientRect;
            const viewportHeight = window.innerHeight;
            let position: 'top' | 'center' | 'bottom' = 'center';
            if (rect.top < viewportHeight / 3) position = 'top';
            else if (rect.top > (viewportHeight * 2) / 3) position = 'bottom';

            emitProductVisible({
              productId: product.id,
              category: product.category,
              canonicalType: product.canonicalType,
              visibilityRatio: entry.intersectionRatio,
              viewportPosition: position,
            });

            // Start dwell timer
            dwellIntervalRef.current = setInterval(() => {
              setDwellTime(prev => prev + 100);
            }, 100);
          } else if (!entry.isIntersecting && isVisible) {
            setIsVisible(false);
            
            emitProductHidden({
              productId: product.id,
              category: product.category,
              canonicalType: product.canonicalType,
            });

            // Emit dwell event and reset timer
            if (dwellTime > 500) {
              emitProductDwell({
                productId: product.id,
                category: product.category,
                canonicalType: product.canonicalType,
                dwellTime,
                scrollPauses: 0,
                returnVisits,
              });
            }
            
            if (dwellIntervalRef.current) {
              clearInterval(dwellIntervalRef.current);
            }
            setDwellTime(0);
          }
        });
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    );

    observer.observe(card);

    return () => {
      observer.disconnect();
      if (dwellIntervalRef.current) {
        clearInterval(dwellIntervalRef.current);
      }
    };
  }, [product, isVisible, dwellTime, returnVisits]);

  // Hover tracking
  const handleMouseEnter = useCallback(() => {
    setHoverStartTime(Date.now());
    emitProductHover({
      productId: product.id,
      category: product.category,
      canonicalType: product.canonicalType,
    });
  }, [product]);

  const handleMouseLeave = useCallback(() => {
    if (hoverStartTime) {
      const duration = Date.now() - hoverStartTime;
      emitProductHoverEnd({
        productId: product.id,
        category: product.category,
        canonicalType: product.canonicalType,
        duration,
      });
    }
    setHoverStartTime(null);
  }, [product, hoverStartTime]);

  const handleClick = useCallback(() => {
    emitProductClick({
      productId: product.id,
      category: product.category,
      canonicalType: product.canonicalType,
    });
  }, [product]);

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    addItem(product);
  };

  const handleQuantityChange = (e: React.MouseEvent, delta: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (cartItem) {
      updateQuantity(product.id, cartItem.quantity + delta);
    }
  };

  return (
    <Card
      ref={cardRef}
      className="product-card group overflow-hidden border-0 shadow-sm hover:shadow-lg transition-all duration-200"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <Link href={`/product/${product.id}`} onClick={handleClick}>
        <div className="relative aspect-square overflow-hidden bg-muted">
          <Image
            src={product.image}
            alt={product.name}
            fill
            className="object-cover transition-transform duration-300 group-hover:scale-105"
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            priority={priority}
          />
          
          {/* Discount badge */}
          {product.discount && (
            <Badge className="discount-badge absolute top-2 left-2 text-xs font-semibold">
              -{product.discount}%
            </Badge>
          )}
          
          {/* Low stock indicator */}
          {product.inventory < 10 && product.inventory > 0 && (
            <Badge variant="secondary" className="absolute top-2 right-2 text-xs stock-low">
              Solo quedan {product.inventory}
            </Badge>
          )}
          
          {/* Quick add button overlay */}
          <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            {cartItem ? (
              <div className="flex items-center justify-center gap-2 bg-background rounded-lg p-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={(e) => handleQuantityChange(e, -1)}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-8 text-center font-medium">{cartItem.quantity}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={(e) => handleQuantityChange(e, 1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <Button
                className="w-full h-9"
                onClick={handleAddToCart}
              >
                <ShoppingCart className="h-4 w-4 mr-2" />
                Agregar
              </Button>
            )}
          </div>
        </div>
        
        <CardContent className="p-3">
          {/* Brand */}
          <p className="text-xs text-muted-foreground mb-1">{product.brand}</p>
          
          {/* Name */}
          <h3 className="font-medium text-sm leading-tight line-clamp-2 mb-2 group-hover:text-primary transition-colors">
            {product.name}
          </h3>
          
          {/* Rating */}
          <div className="flex items-center gap-1 mb-2">
            <div className="flex items-center">
              {[...Array(5)].map((_, i) => (
                <Star
                  key={i}
                  className={`h-3 w-3 ${
                    i < Math.floor(product.rating)
                      ? 'star-filled fill-current'
                      : 'text-muted-foreground/30'
                  }`}
                />
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              ({product.reviewCount.toLocaleString('es-CL')})
            </span>
          </div>
          
          {/* Price */}
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold">${product.price.toLocaleString('es-CL')}</span>
            {product.originalPrice && (
              <span className="text-sm text-muted-foreground line-through">
                ${product.originalPrice.toLocaleString('es-CL')}
              </span>
            )}
          </div>
          
          {/* Unit */}
          {product.unit && (
            <p className="text-xs text-muted-foreground mt-1">{product.unit}</p>
          )}
        </CardContent>
      </Link>
    </Card>
  );
}

export function ProductCardSkeleton() {
  return (
    <Card className="overflow-hidden border-0 shadow-sm">
      <div className="aspect-square image-skeleton" />
      <CardContent className="p-3 space-y-2">
        <div className="h-3 w-16 bg-muted rounded image-skeleton" />
        <div className="h-4 w-full bg-muted rounded image-skeleton" />
        <div className="h-4 w-2/3 bg-muted rounded image-skeleton" />
        <div className="h-3 w-20 bg-muted rounded image-skeleton" />
        <div className="h-5 w-16 bg-muted rounded image-skeleton" />
      </CardContent>
    </Card>
  );
}
