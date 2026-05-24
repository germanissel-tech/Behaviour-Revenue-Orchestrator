'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  ShoppingCart, 
  User, 
  MapPin, 
  ChevronDown,
  Menu,
  X,
  Utensils,
  ShoppingBasket,
  Pill,
  Home,
  Laptop,
  Shirt
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useCartStore } from '@/lib/store/cart-store';
import { categories } from '@/lib/store/products';
import { emitSearch, emitCategoryView, opeEvents } from '@/lib/store/ope-events';

const categoryIcons = {
  food: Utensils,
  grocery: ShoppingBasket,
  pharmacy: Pill,
  home: Home,
  electronics: Laptop,
  fashion: Shirt,
};

const categoryNames: Record<string, string> = {
  food: 'Comida',
  grocery: 'Supermercado',
  pharmacy: 'Farmacia',
  home: 'Hogar',
  electronics: 'Electrónica',
  fashion: 'Moda',
};

export function StoreHeader() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const { items, toggleCart, getItemCount } = useCartStore();
  const itemCount = getItemCount();
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track search queries for OPE
  useEffect(() => {
    if (searchQuery.length > 2) {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      searchTimeoutRef.current = setTimeout(() => {
        emitSearch({ query: searchQuery, resultCount: 0 });
      }, 500);
    }
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  const handleCategoryClick = (categoryId: string) => {
    emitCategoryView({ category: categoryId, productCount: 0 });
  };

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Top bar */}
      <div className="border-b bg-muted/50">
        <div className="container mx-auto px-4">
          <div className="flex h-8 items-center justify-between text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                <span>Entregar en: <strong className="text-foreground">Santiago, Chile</strong></span>
              </div>
            </div>
            <div className="hidden md:flex items-center gap-4">
              <span>Envío gratis en compras sobre $50.000</span>
              <span>|</span>
              <span>Devoluciones en 30 días</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main header */}
      <div className="container mx-auto px-4">
        <div className="flex h-16 items-center gap-4">
          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>

          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg">
              F
            </div>
            <span className="hidden sm:block text-xl font-semibold tracking-tight">FreshMart</span>
          </Link>

          {/* Search */}
          <div className="flex-1 max-w-xl mx-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Buscar productos..."
                className="pl-10 pr-4 h-10 w-full"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="hidden sm:flex">
              <User className="h-5 w-5" />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              className="relative"
              onClick={toggleCart}
            >
              <ShoppingCart className="h-5 w-5" />
              {itemCount > 0 && (
                <Badge 
                  className="absolute -top-1 -right-1 h-5 w-5 flex items-center justify-center p-0 text-xs"
                  variant="default"
                >
                  {itemCount > 99 ? '99+' : itemCount}
                </Badge>
              )}
            </Button>
          </div>
        </div>

        {/* Category navigation - Desktop */}
        <nav className="hidden md:flex items-center gap-1 pb-2 overflow-x-auto">
          {categories.map((category) => {
            const Icon = categoryIcons[category.id as keyof typeof categoryIcons];
            return (
              <Link
                key={category.id}
                href={`/category/${category.id}`}
                onClick={() => handleCategoryClick(category.id)}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors whitespace-nowrap"
              >
                <Icon className="h-4 w-4" />
                {categoryNames[category.id] || category.name}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Mobile menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-t bg-background">
          <nav className="container mx-auto px-4 py-4 space-y-1">
            {categories.map((category) => {
              const Icon = categoryIcons[category.id as keyof typeof categoryIcons];
              return (
                <Link
                  key={category.id}
                  href={`/category/${category.id}`}
                  onClick={() => {
                    handleCategoryClick(category.id);
                    setIsMobileMenuOpen(false);
                  }}
                  className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  <Icon className="h-5 w-5" />
                  {categoryNames[category.id] || category.name}
                  <span className="ml-auto text-xs text-muted-foreground">{category.count}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </header>
  );
}
