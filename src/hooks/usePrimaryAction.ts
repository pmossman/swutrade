import { useEffect } from 'react';
import { usePrimaryActionContext, type PrimaryActionSpec } from '../contexts/PrimaryActionContext';

/**
 * Register a composer bar's primary action with the shared
 * `PrimaryActionBar`. Call this from ProposeBar / CounterBar /
 * EditBar / AutoBalanceBanner to move their Send/Save/Apply button
 * into the bottom-pinned bar that every mode shares.
 *
 * Pass `null` to deregister — used when the bar enters a state where
 * it has no primary action (e.g., EditBar in `loading` or
 * `already-resolved` state). On unmount the hook auto-clears so
 * switching between bars (propose → counter, etc.) doesn't leave a
 * stale registration.
 *
 * Two registration effects keep the semantics clean:
 *
 *  1. Update effect — runs on every spec change, pushes the latest
 *     spec. The context shallow-compares and skips redundant updates,
 *     so passing a fresh object per render is cheap in practice.
 *  2. Unmount effect — runs exactly once on unmount, clears the
 *     registration. Because the composer bars are a mutex and React
 *     runs old cleanups before new-tree effects, the incoming bar's
 *     register always wins over the outgoing bar's clear.
 */
export function usePrimaryAction(spec: PrimaryActionSpec | null): void {
  const { setPrimaryAction } = usePrimaryActionContext();

  // Update on spec change — no cleanup here, to avoid a pointless
  // null-then-new round-trip on every render.
  useEffect(() => {
    setPrimaryAction(spec);
  }, [spec, setPrimaryAction]);

  // Unmount cleanup — fires once at unmount, clears the registration
  // so the next mode renders its own or the bar vanishes cleanly.
  useEffect(() => {
    return () => setPrimaryAction(null);
  }, [setPrimaryAction]);
}
