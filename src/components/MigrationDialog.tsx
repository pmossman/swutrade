import * as Dialog from '@radix-ui/react-dialog';
import type { MigrationPrompt } from '../hooks/useServerSync';
import { preventAutoFocus } from '../utils/dialogFocus';

interface MigrationDialogProps {
  prompt: MigrationPrompt;
}

export function MigrationDialog({ prompt }: MigrationDialogProps) {
  const { wantsCount, availableCount, onImport, onSkip } = prompt;
  const total = wantsCount + availableCount;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={preventAutoFocus}
          className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100vw-2rem))] bg-space-900 border border-space-700 rounded-2xl shadow-2xl p-6 text-gray-100"
        >
          <Dialog.Title className="text-sm font-bold tracking-[0.1em] uppercase text-gold">
            Import your lists?
          </Dialog.Title>

          <p className="mt-3 text-sm text-gray-300 leading-relaxed">
            You have{' '}
            <strong className="text-gray-100">
              {total} card{total === 1 ? '' : 's'}
            </strong>{' '}
            saved on this device
            {wantsCount > 0 && availableCount > 0
              ? ` (${wantsCount} want${wantsCount === 1 ? '' : 's'}, ${availableCount} available)`
              : wantsCount > 0
                ? ` (${wantsCount} want${wantsCount === 1 ? '' : 's'})`
                : ` (${availableCount} available)`}
            . Would you like to import them to your new account?
          </p>

          <div className="mt-5 flex flex-col gap-2">
            <button
              type="button"
              onClick={onImport}
              className="w-full py-2.5 rounded-lg font-semibold text-sm bg-gold/15 border border-gold/40 text-gold hover:bg-gold/25 hover:border-gold/60 transition-colors"
            >
              Import {total} card{total === 1 ? '' : 's'}
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="w-full py-2.5 rounded-lg font-semibold text-sm text-gray-400 hover:text-gray-200 hover:bg-space-800 transition-colors"
            >
              Start fresh
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
