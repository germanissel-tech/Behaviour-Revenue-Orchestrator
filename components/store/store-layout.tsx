'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { StoreHeader } from './header';
import { StoreFooter } from './footer';
import { CartSidebar } from './cart-sidebar';
import { OPEDebugPanel } from '@/components/debug/ope-debug-panel';
import { opeEvents, emitScrollVelocity } from '@/lib/store/ope-events';
import { initOPEBridge } from '@/lib/store/ope-debug-bridge';

interface StoreLayoutProps {
  children: ReactNode;
}

export function StoreLayout({ children }: StoreLayoutProps) {
  // Scroll velocity tracker refs (no state — avoids re-renders)
  const lastScrollY    = useRef(0);
  const lastScrollTime = useRef(Date.now());
  const scrollRafId    = useRef<number | null>(null);

  useEffect(() => {
    // ── 1. Connect the bridge ────────────────────────────────────────────────
    // READ-ONLY: initOPEBridge only observes events, never modifies engine state.
    // Returns cleanup that removes all subscriptions.
    const cleanupBridge = initOPEBridge();

    // ── 2. Revisit detection ─────────────────────────────────────────────────
    const lastVisit = localStorage.getItem('ope_last_visit');
    const now = Date.now();

    if (lastVisit) {
      const lastTimestamp = parseInt(lastVisit, 10);
      const minutesSince = (now - lastTimestamp) / (1000 * 60);
      if (minutesSince > 30) {
        // Emits session:revisit — bridge picks it up automatically
        opeEvents.markRevisit(lastTimestamp);
      }
    }
    localStorage.setItem('ope_last_visit', now.toString());

    // ── 3. Session duration ticker ───────────────────────────────────────────
    const durationInterval = setInterval(() => {
      const duration = opeEvents.getSessionDuration();
      opeEvents.emit('session:duration_update', { duration });
      // Bridge subscription handles the debug store update automatically.
    }, 5_000);

    // ── 4. Scroll velocity tracking ──────────────────────────────────────────
    // Emits scroll:velocity events — bridge derives scrollVelocity signal from them.
    const handleScroll = () => {
      if (scrollRafId.current !== null) return; // already scheduled

      scrollRafId.current = requestAnimationFrame(() => {
        scrollRafId.current = null;

        const currentY    = window.scrollY;
        const currentTime = Date.now();
        const deltaY      = Math.abs(currentY - lastScrollY.current);
        const deltaTime   = currentTime - lastScrollTime.current;

        if (deltaTime > 0) {
          const velocity  = Math.round((deltaY / deltaTime) * 1000) / 1000; // px/ms → px/s
          const direction = currentY > lastScrollY.current ? 'down' : 'up';
          const maxPos    = document.documentElement.scrollHeight - window.innerHeight;

          emitScrollVelocity({
            velocity,
            direction,
            position:    currentY,
            maxPosition: Math.max(1, maxPos),
          });

          // Emit pause if velocity is near zero
          if (velocity < 5 && deltaTime > 300) {
            opeEvents.emit('scroll:pause', {
              velocity,
              direction,
              position:     currentY,
              maxPosition:  Math.max(1, maxPos),
              pauseDuration: deltaTime,
            });
          }
        }

        lastScrollY.current    = currentY;
        lastScrollTime.current = currentTime;
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      clearInterval(durationInterval);
      window.removeEventListener('scroll', handleScroll);
      if (scrollRafId.current !== null) cancelAnimationFrame(scrollRafId.current);
      cleanupBridge();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <OPEDebugPanel />
      <StoreHeader />
      <main className="flex-1">
        {children}
      </main>
      <StoreFooter />
      <CartSidebar />
    </div>
  );
}
