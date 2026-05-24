import Link from 'next/link';
import { Facebook, Twitter, Instagram, Youtube } from 'lucide-react';

const footerLinks = {
  shop: [
    { name: 'Comida', href: '/category/food' },
    { name: 'Supermercado', href: '/category/grocery' },
    { name: 'Farmacia', href: '/category/pharmacy' },
    { name: 'Hogar', href: '/category/home' },
    { name: 'Electrónica', href: '/category/electronics' },
    { name: 'Moda', href: '/category/fashion' },
  ],
  help: [
    { name: 'Contáctanos', href: '#' },
    { name: 'Seguir pedido', href: '#' },
    { name: 'Devoluciones', href: '#' },
    { name: 'Información de envío', href: '#' },
    { name: 'Preguntas frecuentes', href: '#' },
  ],
  company: [
    { name: 'Sobre nosotros', href: '#' },
    { name: 'Trabaja con nosotros', href: '#' },
    { name: 'Prensa', href: '#' },
    { name: 'Sostenibilidad', href: '#' },
  ],
};

export function StoreFooter() {
  return (
    <footer className="bg-muted/50 border-t">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-lg">
                F
              </div>
              <span className="text-xl font-semibold tracking-tight">FreshMart</span>
            </Link>
            <p className="text-sm text-muted-foreground mb-4">
              Tu destino premium para comida fresca, supermercado y productos esenciales.
              Entrega rápida, mejores precios.
            </p>
            <div className="flex items-center gap-4">
              <Link href="#" className="text-muted-foreground hover:text-foreground transition-colors">
                <Facebook className="h-5 w-5" />
              </Link>
              <Link href="#" className="text-muted-foreground hover:text-foreground transition-colors">
                <Twitter className="h-5 w-5" />
              </Link>
              <Link href="#" className="text-muted-foreground hover:text-foreground transition-colors">
                <Instagram className="h-5 w-5" />
              </Link>
              <Link href="#" className="text-muted-foreground hover:text-foreground transition-colors">
                <Youtube className="h-5 w-5" />
              </Link>
            </div>
          </div>

          {/* Shop */}
          <div>
            <h3 className="font-semibold mb-4">Tienda</h3>
            <ul className="space-y-2">
              {footerLinks.shop.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Help */}
          <div>
            <h3 className="font-semibold mb-4">Ayuda</h3>
            <ul className="space-y-2">
              {footerLinks.help.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="font-semibold mb-4">Empresa</h3>
            <ul className="space-y-2">
              {footerLinks.company.map((link) => (
                <li key={link.name}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t mt-12 pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} FreshMart. Todos los derechos reservados.
          </p>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <Link href="#" className="hover:text-foreground transition-colors">Política de privacidad</Link>
            <Link href="#" className="hover:text-foreground transition-colors">Términos de servicio</Link>
            <Link href="#" className="hover:text-foreground transition-colors">Configuración de cookies</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
