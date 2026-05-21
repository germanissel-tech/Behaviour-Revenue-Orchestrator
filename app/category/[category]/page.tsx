import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { StoreLayout } from '@/components/store/store-layout';
import { ProductCard } from '@/components/store/product-card';
import { productsByCategory, categories } from '@/lib/store/products';

interface CategoryPageProps {
  params: Promise<{ category: string }>;
}

const categoryNames: Record<string, string> = {
  food: 'Comida',
  grocery: 'Supermercado',
  pharmacy: 'Farmacia',
  home: 'Hogar',
  electronics: 'Electrónica',
  fashion: 'Moda',
};

const subcategoryNames: Record<string, string> = {
  'prepared-meals': 'Comidas preparadas',
  'fresh-produce': 'Productos frescos',
  'bakery': 'Panadería',
  'dairy': 'Lácteos',
  'meat-seafood': 'Carnes y mariscos',
  'beverages': 'Bebidas',
  'snacks': 'Snacks',
  'pantry': 'Despensa',
  'frozen': 'Congelados',
  'organic': 'Orgánicos',
  'pain-relief': 'Alivio del dolor',
  'vitamins': 'Vitaminas',
  'first-aid': 'Primeros auxilios',
  'personal-care': 'Cuidado personal',
  'baby-care': 'Cuidado del bebé',
  'kitchen': 'Cocina',
  'cleaning': 'Limpieza',
  'organization': 'Organización',
  'bedding': 'Ropa de cama',
  'decor': 'Decoración',
  'smartphones': 'Smartphones',
  'laptops': 'Laptops',
  'audio': 'Audio',
  'accessories': 'Accesorios',
  'gaming': 'Gaming',
  'mens-clothing': 'Ropa de hombre',
  'womens-clothing': 'Ropa de mujer',
  'shoes': 'Zapatos',
  'bags': 'Bolsos',
};

export async function generateStaticParams() {
  return categories.map((cat) => ({
    category: cat.id,
  }));
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { category } = await params;
  const products = productsByCategory[category as keyof typeof productsByCategory];
  const categoryInfo = categories.find(c => c.id === category);
  
  if (!products || !categoryInfo) {
    notFound();
  }

  const categoryName = categoryNames[category] || categoryInfo.name;

  // Group products by subcategory
  const subcategories = products.reduce((acc, product) => {
    if (!acc[product.subcategory]) {
      acc[product.subcategory] = [];
    }
    acc[product.subcategory].push(product);
    return acc;
  }, {} as Record<string, typeof products>);

  return (
    <StoreLayout>
      <div className="page-transition">
        {/* Breadcrumb */}
        <div className="bg-muted/30 border-b">
          <div className="container mx-auto px-4 py-3">
            <nav className="flex items-center gap-2 text-sm">
              <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors">
                Inicio
              </Link>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{categoryName}</span>
            </nav>
          </div>
        </div>

        {/* Header */}
        <div className="container mx-auto px-4 py-8">
          <h1 className="text-3xl md:text-4xl font-bold mb-2">{categoryName}</h1>
          <p className="text-muted-foreground">
            {products.length} productos disponibles
          </p>
        </div>

        {/* Products by Subcategory */}
        <div className="container mx-auto px-4 pb-12">
          {Object.entries(subcategories).map(([subcategory, subProducts]) => (
            <section key={subcategory} className="mb-12">
              <h2 className="text-xl font-semibold mb-6">
                {subcategoryNames[subcategory] || subcategory.replace(/-/g, ' ')}
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 md:gap-6">
                {subProducts.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </StoreLayout>
  );
}
