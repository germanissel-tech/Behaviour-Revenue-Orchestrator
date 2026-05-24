import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, Truck, Shield, Clock, CreditCard } from 'lucide-react';
import { StoreLayout } from '@/components/store/store-layout';
import { ProductCard } from '@/components/store/product-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { allProducts, categories, productsByCategory } from '@/lib/store/products';

// Get featured products (products with discounts)
const featuredProducts = allProducts.filter(p => p.discount).slice(0, 8);

// Get best sellers (highest rated)
const bestSellers = [...allProducts].sort((a, b) => b.rating - a.rating).slice(0, 8);

// Category hero images
const categoryImages = {
  food: 'https://images.unsplash.com/photo-1606787366850-de6330128bfc?w=800&h=400&fit=crop',
  grocery: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=800&h=400&fit=crop',
  pharmacy: 'https://images.unsplash.com/photo-1631549916768-4119b2e5f926?w=800&h=400&fit=crop',
  home: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&h=400&fit=crop',
  electronics: 'https://images.unsplash.com/photo-1468495244123-6c6c332eeece?w=800&h=400&fit=crop',
  fashion: 'https://images.unsplash.com/photo-1445205170230-053b83016050?w=800&h=400&fit=crop',
};

const categoryNames: Record<string, string> = {
  food: 'Comida',
  grocery: 'Supermercado',
  pharmacy: 'Farmacia',
  home: 'Hogar',
  electronics: 'Electrónica',
  fashion: 'Moda',
};

export default function HomePage() {
  return (
    <StoreLayout>
      <div className="page-transition">
        {/* Hero Section */}
        <section className="relative bg-gradient-to-br from-primary/10 via-background to-accent/20 overflow-hidden">
          <div className="container mx-auto px-4 py-12 md:py-20">
            <div className="grid md:grid-cols-2 gap-8 items-center">
              <div className="space-y-6">
                <Badge variant="secondary" className="text-sm">
                  Envío gratis en compras sobre $50.000
                </Badge>
                <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-balance">
                  Productos frescos,{' '}
                  <span className="text-primary">entrega rápida</span>
                </h1>
                <p className="text-lg text-muted-foreground max-w-md text-pretty">
                  Compra más de 10.000 productos de tus marcas favoritas. 
                  Calidad garantizada, entrega el mismo día disponible.
                </p>
                <div className="flex flex-wrap gap-4">
                  <Button size="lg" asChild>
                    <Link href="/category/food">
                      Comprar ahora
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                  <Button size="lg" variant="outline" asChild>
                    <Link href="/category/grocery">
                      Ver categorías
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="relative aspect-[4/3] rounded-2xl overflow-hidden shadow-2xl">
                <Image
                  src="https://images.unsplash.com/photo-1543168256-418811576931?w=800&h=600&fit=crop"
                  alt="Productos frescos"
                  fill
                  className="object-cover"
                  priority
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Trust badges */}
        <section className="border-y bg-muted/30">
          <div className="container mx-auto px-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-6">
              {[
                { icon: Truck, title: 'Envío gratis', desc: 'En compras sobre $50.000' },
                { icon: Shield, title: 'Garantía de calidad', desc: '100% satisfacción' },
                { icon: Clock, title: 'Entrega el mismo día', desc: 'Pedidos antes de las 14h' },
                { icon: CreditCard, title: 'Pago seguro', desc: 'Múltiples opciones' },
              ].map((item) => (
                <div key={item.title} className="flex items-center gap-3 p-2">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Categories Grid */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold">Comprar por categoría</h2>
                <p className="text-muted-foreground mt-1">Explora nuestra amplia selección</p>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {categories.map((category) => (
                <Link
                  key={category.id}
                  href={`/category/${category.id}`}
                  className="group"
                >
                  <Card className="overflow-hidden border-0 shadow-sm hover:shadow-lg transition-all duration-200">
                    <div className="relative aspect-[4/3] overflow-hidden">
                      <Image
                        src={categoryImages[category.id as keyof typeof categoryImages]}
                        alt={categoryNames[category.id] || category.name}
                        fill
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                      <div className="absolute bottom-0 left-0 right-0 p-3">
                        <h3 className="font-semibold text-white">{categoryNames[category.id] || category.name}</h3>
                        <p className="text-xs text-white/80">{category.count} productos</p>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Featured Deals */}
        <section className="py-12 bg-muted/30">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold">Ofertas destacadas</h2>
                <p className="text-muted-foreground mt-1">Ahorra en productos populares</p>
              </div>
              <Button variant="ghost" asChild>
                <Link href="/deals">
                  Ver todas las ofertas
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {featuredProducts.map((product, index) => (
                <ProductCard key={product.id} product={product} priority={index < 4} />
              ))}
            </div>
          </div>
        </section>

        {/* Best Sellers */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold">Más vendidos</h2>
                <p className="text-muted-foreground mt-1">Los favoritos de nuestros clientes</p>
              </div>
              <Button variant="ghost" asChild>
                <Link href="/best-sellers">
                  Ver todos
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {bestSellers.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          </div>
        </section>

        {/* CTA Banner */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            <Card className="overflow-hidden border-0 bg-primary text-primary-foreground">
              <CardContent className="p-8 md:p-12">
                <div className="grid md:grid-cols-2 gap-8 items-center">
                  <div className="space-y-4">
                    <Badge variant="secondary" className="bg-white/20 text-white hover:bg-white/30">
                      Oferta por tiempo limitado
                    </Badge>
                    <h2 className="text-3xl md:text-4xl font-bold text-balance">
                      Obtén 20% de descuento en tu primer pedido
                    </h2>
                    <p className="text-primary-foreground/80 text-pretty">
                      Suscríbete a nuestro boletín y recibe un código de descuento exclusivo 
                      para tu primera compra. Además, recibe actualizaciones sobre novedades y ofertas especiales.
                    </p>
                    <div className="flex flex-wrap gap-4">
                      <Button variant="secondary" size="lg">
                        Suscribirse ahora
                      </Button>
                      <Button variant="outline" size="lg" className="bg-transparent border-white/30 hover:bg-white/10">
                        Saber más
                      </Button>
                    </div>
                  </div>
                  <div className="relative aspect-[4/3] rounded-xl overflow-hidden">
                    <Image
                      src="https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=600&h=450&fit=crop"
                      alt="Oferta especial"
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, 50vw"
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Fresh Food Section */}
        <section className="py-12 bg-muted/30">
          <div className="container mx-auto px-4">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold">Comida fresca</h2>
                <p className="text-muted-foreground mt-1">Ingredientes de calidad para tu cocina</p>
              </div>
              <Button variant="ghost" asChild>
                <Link href="/category/food">
                  Ver toda la comida
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {productsByCategory.food.slice(0, 8).map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </StoreLayout>
  );
}
