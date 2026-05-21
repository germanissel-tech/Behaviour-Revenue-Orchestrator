'use client';

import { useEffect, useState, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { use } from 'react';
import { 
  ChevronRight, 
  Star, 
  Minus, 
  Plus, 
  ShoppingCart, 
  Heart,
  Truck,
  RotateCcw,
  Shield,
  Check
} from 'lucide-react';
import { StoreLayout } from '@/components/store/store-layout';
import { ProductCard } from '@/components/store/product-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  getProductById, 
  getRelatedProducts, 
  allProducts,
  categories 
} from '@/lib/store/products';
import { useCartStore } from '@/lib/store/cart-store';
import {
  emitPDPOpen,
  emitPDPClose,
  emitPDPScroll,
  opeEvents,
} from '@/lib/store/ope-events';

const categoryNames: Record<string, string> = {
  food: 'Comida',
  grocery: 'Supermercado',
  pharmacy: 'Farmacia',
  home: 'Hogar',
  electronics: 'Electrónica',
  fashion: 'Moda',
};

interface ProductPageProps {
  params: Promise<{ productId: string }>;
}

export default function ProductPage({ params }: ProductPageProps) {
  const { productId } = use(params);
  const product = getProductById(productId);
  
  if (!product) {
    notFound();
  }

  const relatedProducts = getRelatedProducts(product.canonicalType);
  const categoryProducts = allProducts
    .filter(p => p.category === product.category && p.id !== product.id)
    .slice(0, 4);

  const { addItem, getItem, updateQuantity } = useCartStore();
  const cartItem = getItem(product.id);
  const [quantity, setQuantity] = useState(1);
  const [scrollDepth, setScrollDepth] = useState(0);
  const pageOpenTime = useRef(Date.now());

  // Track PDP open
  useEffect(() => {
    emitPDPOpen({
      productId: product.id,
      category: product.category,
      canonicalType: product.canonicalType,
      price: product.price,
    });

    return () => {
      emitPDPClose({
        productId: product.id,
        category: product.category,
        canonicalType: product.canonicalType,
        price: product.price,
        timeOnPage: Date.now() - pageOpenTime.current,
        scrollDepth,
      });
    };
  }, [product, scrollDepth]);

  // Track scroll depth
  useEffect(() => {
    const handleScroll = () => {
      const scrolled = window.scrollY;
      const height = document.documentElement.scrollHeight - window.innerHeight;
      const depth = Math.round((scrolled / height) * 100);
      
      if (depth > scrollDepth) {
        setScrollDepth(depth);
        
        if (depth % 25 === 0) {
          emitPDPScroll({
            productId: product.id,
            category: product.category,
            canonicalType: product.canonicalType,
            price: product.price,
            scrollDepth: depth,
          });
        }
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [product, scrollDepth]);

  const handleAddToCart = () => {
    addItem(product, quantity);
    setQuantity(1);
  };

  const categoryInfo = categories.find(c => c.id === product.category);
  const categoryName = categoryNames[product.category] || categoryInfo?.name;

  return (
    <StoreLayout>
      <div className="page-transition">
        {/* Breadcrumb */}
        <div className="bg-muted/30 border-b">
          <div className="container mx-auto px-4 py-3">
            <nav className="flex items-center gap-2 text-sm flex-wrap">
              <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
                Inicio
              </Link>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <Link 
                href={`/category/${product.category}`} 
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {categoryName}
              </Link>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium truncate max-w-[200px]">{product.name}</span>
            </nav>
          </div>
        </div>

        {/* Product Details */}
        <div className="container mx-auto px-4 py-8">
          <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
            {/* Image */}
            <div className="relative">
              <div className="aspect-square rounded-2xl overflow-hidden bg-muted sticky top-24">
                <Image
                  src={product.image}
                  alt={product.name}
                  fill
                  className="object-cover"
                  priority
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
                {product.discount && (
                  <Badge className="discount-badge absolute top-4 left-4 text-sm font-semibold">
                    -{product.discount}% DCTO
                  </Badge>
                )}
              </div>
            </div>

            {/* Details */}
            <div className="space-y-6">
              {/* Brand */}
              <div>
                <p className="text-sm text-muted-foreground mb-2">{product.brand}</p>
                <h1 className="text-2xl md:text-3xl font-bold">{product.name}</h1>
              </div>

              {/* Rating */}
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`h-5 w-5 ${
                        i < Math.floor(product.rating)
                          ? 'star-filled fill-current'
                          : 'text-muted-foreground/30'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-sm text-muted-foreground">
                  {product.rating.toFixed(1)} ({product.reviewCount.toLocaleString('es-CL')} reseñas)
                </span>
              </div>

              {/* Price */}
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold">${product.price.toLocaleString('es-CL')}</span>
                {product.originalPrice && (
                  <>
                    <span className="text-xl text-muted-foreground line-through">
                      ${product.originalPrice.toLocaleString('es-CL')}
                    </span>
                    <Badge variant="secondary" className="text-store-discount">
                      Ahorra ${(product.originalPrice - product.price).toLocaleString('es-CL')}
                    </Badge>
                  </>
                )}
              </div>

              {/* Unit */}
              {product.unit && (
                <p className="text-sm text-muted-foreground">{product.unit}</p>
              )}

              <Separator />

              {/* Stock */}
              <div className="flex items-center gap-2">
                {product.inventory > 10 ? (
                  <>
                    <Check className="h-4 w-4 text-store-success" />
                    <span className="text-sm text-store-success font-medium">En stock</span>
                  </>
                ) : product.inventory > 0 ? (
                  <>
                    <span className="text-sm stock-low font-medium">
                      Solo quedan {product.inventory} unidades
                    </span>
                  </>
                ) : (
                  <span className="text-sm stock-out font-medium">Sin stock</span>
                )}
              </div>

              {/* Quantity & Add to Cart */}
              <div className="flex items-center gap-4">
                <div className="flex items-center border rounded-lg">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setQuantity(Math.max(1, quantity - 1))}
                    disabled={quantity <= 1}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                  <span className="w-12 text-center font-medium">{quantity}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    onClick={() => setQuantity(Math.min(product.inventory, quantity + 1))}
                    disabled={quantity >= product.inventory}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>

                <Button 
                  size="lg" 
                  className="flex-1"
                  onClick={handleAddToCart}
                  disabled={product.inventory === 0}
                >
                  <ShoppingCart className="h-4 w-4 mr-2" />
                  {cartItem ? 'Agregar más' : 'Agregar al carrito'}
                </Button>

                <Button variant="outline" size="icon" className="h-11 w-11">
                  <Heart className="h-5 w-5" />
                </Button>
              </div>

              {cartItem && (
                <p className="text-sm text-muted-foreground">
                  {cartItem.quantity} ya en tu carrito
                </p>
              )}

              <Separator />

              {/* Delivery info */}
              <div className="grid grid-cols-3 gap-4">
                <div className="flex flex-col items-center text-center p-3 rounded-lg bg-muted/50">
                  <Truck className="h-5 w-5 mb-2 text-muted-foreground" />
                  <span className="text-xs font-medium">Envío gratis</span>
                  <span className="text-xs text-muted-foreground">Sobre $50.000</span>
                </div>
                <div className="flex flex-col items-center text-center p-3 rounded-lg bg-muted/50">
                  <RotateCcw className="h-5 w-5 mb-2 text-muted-foreground" />
                  <span className="text-xs font-medium">Devoluciones</span>
                  <span className="text-xs text-muted-foreground">30 días</span>
                </div>
                <div className="flex flex-col items-center text-center p-3 rounded-lg bg-muted/50">
                  <Shield className="h-5 w-5 mb-2 text-muted-foreground" />
                  <span className="text-xs font-medium">Calidad</span>
                  <span className="text-xs text-muted-foreground">Garantizada</span>
                </div>
              </div>

              {/* Description Tabs */}
              <Tabs defaultValue="description" className="mt-8">
                <TabsList className="w-full">
                  <TabsTrigger value="description" className="flex-1">Descripción</TabsTrigger>
                  <TabsTrigger value="details" className="flex-1">Detalles</TabsTrigger>
                  <TabsTrigger value="reviews" className="flex-1">Reseñas</TabsTrigger>
                </TabsList>
                <TabsContent value="description" className="mt-4">
                  <p className="text-muted-foreground leading-relaxed">
                    {product.description}
                  </p>
                  {product.warnings && (
                    <p className="mt-4 text-sm text-store-warning">
                      <strong>Advertencia:</strong> {product.warnings}
                    </p>
                  )}
                </TabsContent>
                <TabsContent value="details" className="mt-4">
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between py-2 border-b">
                      <dt className="text-muted-foreground">Marca</dt>
                      <dd className="font-medium">{product.brand}</dd>
                    </div>
                    <div className="flex justify-between py-2 border-b">
                      <dt className="text-muted-foreground">Categoría</dt>
                      <dd className="font-medium capitalize">{categoryName}</dd>
                    </div>
                    <div className="flex justify-between py-2 border-b">
                      <dt className="text-muted-foreground">Subcategoría</dt>
                      <dd className="font-medium capitalize">{product.subcategory.replace(/-/g, ' ')}</dd>
                    </div>
                    {product.unit && (
                      <div className="flex justify-between py-2 border-b">
                        <dt className="text-muted-foreground">Tamaño/Unidad</dt>
                        <dd className="font-medium">{product.unit}</dd>
                      </div>
                    )}
                    <div className="flex justify-between py-2">
                      <dt className="text-muted-foreground">ID Producto</dt>
                      <dd className="font-mono text-xs">{product.id}</dd>
                    </div>
                  </dl>
                </TabsContent>
                <TabsContent value="reviews" className="mt-4">
                  <div className="text-center py-8 text-muted-foreground">
                    <Star className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
                    <p className="font-medium mb-2">{product.reviewCount.toLocaleString('es-CL')} reseñas</p>
                    <p className="text-sm">Las reseñas son gestionadas por nuestro sistema inteligente.</p>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>

        {/* Related Products */}
        {relatedProducts.length > 0 && (
          <section className="py-12 bg-muted/30">
            <div className="container mx-auto px-4">
              <h2 className="text-2xl font-bold mb-6">Frecuentemente comprados juntos</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
                {relatedProducts.slice(0, 4).map((relatedProduct) => (
                  <ProductCard key={relatedProduct.id} product={relatedProduct} />
                ))}
              </div>
            </div>
          </section>
        )}

        {/* More from Category */}
        {categoryProducts.length > 0 && (
          <section className="py-12">
            <div className="container mx-auto px-4">
              <h2 className="text-2xl font-bold mb-6">Más de {categoryName}</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
                {categoryProducts.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            </div>
          </section>
        )}
      </div>
    </StoreLayout>
  );
}
