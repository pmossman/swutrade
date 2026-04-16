/**
 * Default handler for Radix `Dialog.Content`'s `onOpenAutoFocus`.
 *
 * Radix auto-focuses the first focusable element when a dialog opens.
 * Chromium treats that programmatic focus as `:focus-visible`, so the
 * user sees a keyboard-style focus ring lit up on whichever button
 * happens to be first in the DOM (Share pill, dialog close X, etc.).
 * On a mouse/touch-driven open it reads as an unintended
 * "pre-selected" highlight.
 *
 * `preventDefault` here skips the auto-focus without disturbing
 * Radix's focus trap — keyboard users still Tab into the dialog,
 * they just don't land on an arbitrary CTA on mount.
 *
 * Apply to every `Dialog.Content`:
 *   <Dialog.Content onOpenAutoFocus={preventAutoFocus}>
 */
export const preventAutoFocus = (event: Event): void => {
  event.preventDefault();
};
