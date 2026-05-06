import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';

// Fallback that runs when `useConfirm()` is called outside a
// <ConfirmProvider>. Module-scoped so it isn't re-derived per call,
// and so we don't violate rules-of-hooks by conditionally calling
// useMemo. The provider is mounted at App root in production; this
// fallback exists for isolated dev/test renders.
const fallbackConfirm: ConfirmFn = async (opts) => {
  const text = opts.message
    ? `${opts.title}\n\n${typeof opts.message === 'string' ? opts.message : ''}`
    : opts.title;
  return window.confirm(text);
};

/**
 * App-wide replacement for `window.confirm` — a promise-based
 * imperative API that renders a Radix Dialog.
 *
 * Why not declarative state per call site? Two reasons. (1) The
 * call sites are imperative ("user clicked Cancel; before I run
 * onCancel, ask first") and forcing each one to thread `pendingX`
 * state ruins the linear narrative. (2) Centralising the chrome
 * here keeps the destructive-confirmation visual coherent — title
 * + message + Cancel/Confirm with consistent positioning, focus
 * trap, ESC dismissal, restore focus. `window.confirm` is OS-
 * dependent; this is not. (Audit MP-5)
 *
 * Usage:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({
 *     title: 'Cancel this shared trade?',
 *     message: 'Both sides will lose the in-progress state.',
 *     confirmLabel: 'Cancel trade',
 *     destructive: true,
 *   }))) return;
 *   // …proceed
 *
 * The provider lives once at the App root. ESC and overlay-click
 * resolve the promise as `false` (declined). Confirm-button click
 * resolves as `true`.
 */
export interface ConfirmOptions {
  title: string;
  /** Body paragraph below the title. Optional — title-only confirms
   *  are fine for short ask-twice prompts. */
  message?: ReactNode;
  /** Default 'Confirm'. */
  confirmLabel?: string;
  /** Default 'Cancel'. */
  cancelLabel?: string;
  /** When true the confirm button reads as crimson (destructive
   *  action — losing data, breaking a thread). Default false. */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingState {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  // Stable ref for the resolver so the close handlers don't re-render
  // when `pending` flips.
  const pendingRef = useRef<PendingState | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setPending({ opts, resolve });
      }),
    [],
  );

  const settle = useCallback((value: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    current.resolve(value);
    setPending(null);
  }, []);

  const handleOpenChange = useCallback((next: boolean) => {
    // Closing via ESC or overlay click resolves as cancelled.
    if (!next) settle(false);
  }, [settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog.Root open={pending !== null} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
          <Dialog.Content
            aria-describedby={pending?.opts.message ? 'confirm-dialog-body' : undefined}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm rounded-xl bg-space-900 border border-space-700 p-5 shadow-xl"
          >
            <Dialog.Title className="text-sm font-bold text-gray-100 mb-1">
              {pending?.opts.title ?? ''}
            </Dialog.Title>
            {pending?.opts.message && (
              <Dialog.Description
                id="confirm-dialog-body"
                className="text-xs text-gray-400 leading-relaxed mb-4"
              >
                {pending.opts.message}
              </Dialog.Description>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => settle(false)}
                className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 text-xs font-medium text-gray-300 hover:text-gold transition-colors"
              >
                {pending?.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                className={
                  pending?.opts.destructive
                    ? 'px-3 h-9 rounded-lg bg-crimson/20 border border-crimson/60 text-crimson-light text-xs font-bold uppercase tracking-wide hover:bg-crimson/30 transition-colors'
                    : 'px-3 h-9 rounded-lg bg-gold/20 border border-gold/60 text-gold-bright text-xs font-bold uppercase tracking-wide hover:bg-gold/30 transition-colors'
                }
              >
                {pending?.opts.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? fallbackConfirm;
}
