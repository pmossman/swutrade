import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';

interface ListsDrawerProps {
  wantsCount?: number;
  availableCount?: number;
}

type ListTab = 'wants' | 'available';

/**
 * Mobile: bottom sheet sliding up from viewport bottom.
 * Desktop: centered modal.
 * Empty tabs for now — real content lands in follow-up commits.
 */
export function ListsDrawer({ wantsCount = 0, availableCount = 0 }: ListsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ListTab>('wants');
  const totalCount = wantsCount + availableCount;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open my lists"
          className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 hover:bg-space-800 transition-colors text-xs font-medium text-gray-300 hover:text-gold-bright"
        >
          <ListsIcon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline tracking-wide uppercase">My Lists</span>
          {totalCount > 0 && (
            <span className="ml-0.5 px-1.5 py-px rounded-full bg-gold/20 text-gold-bright text-[10px] font-bold leading-none">
              {totalCount}
            </span>
          )}
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className={[
            // Positioning/transform live in index.css under .drawer-content
            // to avoid a Tailwind-transform vs keyframe race on first paint.
            'drawer-content z-50 bg-space-900 border border-space-700 text-gray-100 shadow-2xl',
            'flex flex-col',
            // Mobile: bottom sheet shape
            'max-h-[85dvh] rounded-t-2xl border-b-0',
            // Desktop: centered modal size/shape
            'md:w-[min(640px,calc(100vw-2rem))] md:max-h-[85dvh] md:rounded-2xl md:border',
          ].join(' ')}
        >
          {/* Drag-handle affordance (mobile only) */}
          <div className="flex justify-center pt-2 md:hidden">
            <span className="w-10 h-1 rounded-full bg-space-700" aria-hidden />
          </div>

          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-space-800">
            <Dialog.Title className="text-sm font-bold tracking-[0.1em] uppercase text-gold-bright">
              My Lists
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="text-gray-500 hover:text-gray-200 transition-colors"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          <Tabs.Root
            value={tab}
            onValueChange={v => setTab(v as ListTab)}
            className="flex flex-col flex-1 min-h-0"
          >
            <Tabs.List
              className="flex gap-1 px-3 pt-2 border-b border-space-800"
              aria-label="Wants and Available lists"
            >
              <TabTrigger value="wants" count={wantsCount}>
                Wants
              </TabTrigger>
              <TabTrigger value="available" count={availableCount}>
                Available
              </TabTrigger>
            </Tabs.List>

            <Tabs.Content
              value="wants"
              className="flex-1 min-h-0 overflow-y-auto p-5 data-[state=inactive]:hidden"
            >
              <EmptyState
                title="No wants yet"
                body="Save cards you're looking for. You'll be able to add them to trades in one tap."
              />
            </Tabs.Content>

            <Tabs.Content
              value="available"
              className="flex-1 min-h-0 overflow-y-auto p-5 data-[state=inactive]:hidden"
            >
              <EmptyState
                title="No available cards yet"
                body="Save exact cards you have to trade. Matchmaking against other users comes later."
              />
            </Tabs.Content>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function TabTrigger({
  value,
  count,
  children,
}: {
  value: ListTab;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className={[
        'relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold tracking-[0.08em] uppercase rounded-t-md',
        'text-gray-500 hover:text-gray-300 transition-colors',
        'data-[state=active]:text-gold-bright',
        'after:content-[""] after:absolute after:bottom-0 after:inset-x-2 after:h-px after:bg-transparent',
        'data-[state=active]:after:bg-gold',
      ].join(' ')}
    >
      {children}
      {count > 0 && (
        <span className="px-1.5 py-px rounded-full bg-space-700 text-gray-300 text-[10px] font-bold leading-none">
          {count}
        </span>
      )}
    </Tabs.Trigger>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 gap-2">
      <div className="text-sm font-semibold text-gray-300">{title}</div>
      <div className="text-xs text-gray-500 max-w-sm">{body}</div>
    </div>
  );
}

function ListsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="3" width="11" height="2.25" rx="0.5" />
      <rect x="2.5" y="7" width="11" height="2.25" rx="0.5" />
      <rect x="2.5" y="11" width="11" height="2.25" rx="0.5" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M4 4L12 12M4 12L12 4" />
    </svg>
  );
}
