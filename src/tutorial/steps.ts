/**
 * First-run tutorial step definitions.
 *
 * Each step is either CENTERED (no anchor — renders as a modal card
 * in the middle of the viewport) or ANCHORED to a DOM element via a
 * `data-tour` attribute. The overlay component measures the anchor's
 * bounding rect at render time and positions the callout plus a
 * cutout highlight around it.
 *
 * Anchor contract: whichever component owns the target element is
 * responsible for rendering `data-tour="<id>"` on a stable DOM node.
 * The tour doesn't care about the DOM structure beyond "find one
 * element by this attribute."
 */

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  /** When set, the overlay highlights the matching DOM node and
   *  positions the callout near it. Omit for centered steps. */
  anchor?: string;
  /** Preferred placement when anchored. The overlay falls back if
   *  the preferred spot won't fit the viewport. */
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Balance every trade',
    body: 'SWUTrade helps you build fair trades between two sides. Add cards to each side and the balance bar shows who\'s giving up more value.',
  },
  {
    id: 'add-cards',
    title: 'Stage cards on each side',
    body: 'Tap "Add cards" on both sides to build your trade. Prices come from TCGPlayer and update live as you adjust quantities or variants.',
    anchor: '[data-tour="add-cards"]',
    placement: 'top',
  },
  {
    id: 'sign-in',
    title: 'Sign in to unlock more',
    body: 'Sign in with Discord to save your wishlist and binder, send proposals to other players, and find matches inside your trading communities.',
    anchor: '[data-tour="account-menu"]',
    placement: 'bottom',
  },
];
