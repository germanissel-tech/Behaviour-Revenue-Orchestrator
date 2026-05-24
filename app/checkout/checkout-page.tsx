'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CreditCard, Truck, MapPin, CheckCircle2, ShieldCheck, Clock } from 'lucide-react';
import { useCartStore } from '@/lib/store/cart-store';
import {
  emitCheckoutStart,
  emitCheckoutStep,
  emitCheckoutComplete,
} from '@/lib/store/ope-events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function CheckoutPage() {
  const router = useRouter();
  const { items, getTotal, getItemCount, clearCart } = useCartStore();
  const [step, setStep] = useState<'shipping' | 'payment' | 'confirmation'>('shipping');
  const [isProcessing, setIsProcessing] = useState(false);
  const [orderComplete, setOrderComplete] = useState(false);

  const [shippingInfo, setShippingInfo] = useState({
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    postalCode: '',
    instructions: '',
  });

  const [paymentInfo, setPaymentInfo] = useState({
    cardNumber: '',
    cardName: '',
    expiry: '',
    cvv: '',
  });

  const subtotal = getTotal();
  const shipping = subtotal > 50000 ? 0 : 4990;
  const total = subtotal + shipping;

  const handleShippingSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    emitCheckoutStep({
      step: 'shipping',
      cartTotal: total,
      itemCount: getItemCount(),
    });
    setStep('payment');
  };

  const handlePaymentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);

    emitCheckoutStep({
      step: 'payment',
      cartTotal: total,
      itemCount: getItemCount(),
    });

    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    emitCheckoutComplete({
      step: 'complete',
      cartTotal: total,
      itemCount: getItemCount(),
    });

    clearCart();
    setOrderComplete(true);
    setStep('confirmation');
    setIsProcessing(false);
  };

  // Emit checkout:start on first render of checkout page
  // (only once, not on re-renders)
  const [startEmitted, setStartEmitted] = useState(false);
  if (!startEmitted && items.length > 0) {
    setStartEmitted(true);
    emitCheckoutStart({
      step: 'cart',
      cartTotal: total,
      itemCount: getItemCount(),
    });
  }

  if (items.length === 0 && !orderComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-semibold mb-4">Tu carrito está vacío</h2>
          <Link href="/">
            <Button>Volver a la tienda</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (step === 'confirmation' || orderComplete) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-6">
          <CheckCircle2 className="w-20 h-20 text-green-500 mx-auto" />
          <h1 className="text-3xl font-bold">¡Pedido Confirmado!</h1>
          <p className="text-muted-foreground">
            Tu pedido ha sido procesado exitosamente. Recibirás un correo de confirmación pronto.
          </p>
          <Link href="/">
            <Button className="w-full">Seguir Comprando</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30 p-4">
      <div className="max-w-4xl mx-auto">
        <Link href="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="w-4 h-4" />
          Volver
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Form */}
          <div className="lg:col-span-2 space-y-6">
            {step === 'shipping' && (
              <form onSubmit={handleShippingSubmit} className="bg-background rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <MapPin className="w-5 h-5 text-primary" />
                  <h2 className="text-lg font-semibold">Información de Envío</h2>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <Input
                      placeholder="Nombre completo"
                      value={shippingInfo.fullName}
                      onChange={e => setShippingInfo({ ...shippingInfo, fullName: e.target.value })}
                      required
                    />
                  </div>
                  <Input
                    type="email"
                    placeholder="Correo electrónico"
                    value={shippingInfo.email}
                    onChange={e => setShippingInfo({ ...shippingInfo, email: e.target.value })}
                    required
                  />
                  <Input
                    placeholder="Teléfono"
                    value={shippingInfo.phone}
                    onChange={e => setShippingInfo({ ...shippingInfo, phone: e.target.value })}
                    required
                  />
                  <div className="col-span-2">
                    <Input
                      placeholder="Dirección"
                      value={shippingInfo.address}
                      onChange={e => setShippingInfo({ ...shippingInfo, address: e.target.value })}
                      required
                    />
                  </div>
                  <Input
                    placeholder="Ciudad"
                    value={shippingInfo.city}
                    onChange={e => setShippingInfo({ ...shippingInfo, city: e.target.value })}
                    required
                  />
                  <Input
                    placeholder="Código postal"
                    value={shippingInfo.postalCode}
                    onChange={e => setShippingInfo({ ...shippingInfo, postalCode: e.target.value })}
                  />
                </div>

                <Button type="submit" className="w-full">
                  Continuar al Pago
                </Button>
              </form>
            )}

            {step === 'payment' && (
              <form onSubmit={handlePaymentSubmit} className="bg-background rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-2 mb-4">
                  <CreditCard className="w-5 h-5 text-primary" />
                  <h2 className="text-lg font-semibold">Información de Pago</h2>
                </div>

                <Input
                  placeholder="Número de tarjeta"
                  value={paymentInfo.cardNumber}
                  onChange={e => setPaymentInfo({ ...paymentInfo, cardNumber: e.target.value })}
                  required
                  maxLength={19}
                />
                <Input
                  placeholder="Nombre en la tarjeta"
                  value={paymentInfo.cardName}
                  onChange={e => setPaymentInfo({ ...paymentInfo, cardName: e.target.value })}
                  required
                />
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    placeholder="MM/AA"
                    value={paymentInfo.expiry}
                    onChange={e => setPaymentInfo({ ...paymentInfo, expiry: e.target.value })}
                    required
                    maxLength={5}
                  />
                  <Input
                    placeholder="CVV"
                    value={paymentInfo.cvv}
                    onChange={e => setPaymentInfo({ ...paymentInfo, cvv: e.target.value })}
                    required
                    maxLength={4}
                    type="password"
                  />
                </div>

                <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 bg-muted/50 rounded-lg">
                  <ShieldCheck className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <span>Pago seguro con encriptación SSL</span>
                </div>

                <Button type="submit" className="w-full" disabled={isProcessing}>
                  {isProcessing ? (
                    <span className="flex items-center gap-2">
                      <Clock className="w-4 h-4 animate-spin" />
                      Procesando...
                    </span>
                  ) : (
                    `Pagar $${total.toLocaleString('es-CL')}`
                  )}
                </Button>
              </form>
            )}
          </div>

          {/* Order summary */}
          <div className="bg-background rounded-xl p-6 h-fit space-y-4">
            <h3 className="font-semibold">Resumen del Pedido</h3>
            <div className="space-y-3">
              {items.map(item => (
                <div key={item.product.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground truncate flex-1 mr-2">
                    {item.product.name} × {item.quantity}
                  </span>
                  <span className="font-medium whitespace-nowrap">
                    ${(item.product.price * item.quantity).toLocaleString('es-CL')}
                  </span>
                </div>
              ))}
            </div>
            <div className="border-t pt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>${subtotal.toLocaleString('es-CL')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Truck className="w-3 h-3" />
                  Envío
                </span>
                <span>{shipping === 0 ? 'Gratis' : `$${shipping.toLocaleString('es-CL')}`}</span>
              </div>
              <div className="flex justify-between font-semibold text-base border-t pt-2">
                <span>Total</span>
                <span>${total.toLocaleString('es-CL')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
