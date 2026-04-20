import * as Dialog from '@radix-ui/react-dialog';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
  /**
   * `half` snaps to ~60vh, `full` snaps to 100vh minus safe-area.
   * Defaults to `half`. Drag-to-dismiss via the top drag handle is
   * always available regardless of snap point.
   */
  snap?: 'half' | 'full';
}

export function Sheet({ open, onOpenChange, title, children, snap = 'half' }: SheetProps) {
  const prefersReducedMotion = useReducedMotion();
  const height = snap === 'full' ? '100dvh' : '60vh';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
                className="fixed inset-0 z-40 bg-black/40"
              />
            </Dialog.Overlay>
            <Dialog.Content
              asChild
              aria-describedby={undefined}
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={
                  prefersReducedMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 320, damping: 32 }
                }
                drag="y"
                dragConstraints={{ top: 0, bottom: 0 }}
                dragElastic={{ top: 0, bottom: 0.4 }}
                onDragEnd={(_e, info) => {
                  if (info.offset.y > 120) onOpenChange(false);
                }}
                className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl border border-border bg-surface text-fg shadow-2xl"
                style={{
                  height,
                  paddingBottom: 'env(safe-area-inset-bottom)',
                }}
              >
                <div className="grid place-items-center pt-2">
                  <span
                    aria-hidden="true"
                    className="h-1 w-9 rounded-full bg-border"
                  />
                </div>
                {title ? (
                  <Dialog.Title className="px-4 pt-3 pb-1 text-center text-[length:var(--text-body)] font-semibold">
                    {title}
                  </Dialog.Title>
                ) : (
                  <Dialog.Title className="sr-only">Sheet</Dialog.Title>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4">{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        ) : null}
      </AnimatePresence>
    </Dialog.Root>
  );
}
