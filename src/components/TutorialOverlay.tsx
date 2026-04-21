import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TutorialApi } from '../hooks/useTutorial';
import { TUTORIAL_STEPS, type TutorialStep } from '../tutorial/steps';

/**
 * Full-viewport coachmark overlay rendered into a portal at document.body.
 * Two layers:
 *   - Backdrop: dark rgba wash over the whole viewport, except where an
 *     ANCHORED step cuts out a rectangular window around the target
 *     element (box-shadow "hole punch" trick on a rect positioned to
 *     match the anchor's bounding box, with a small outset so the
 *     highlight doesn't touch the target's edge).
 *   - Callout: a card with title + body + step counter + Back/Skip/
 *     Next-or-Finish controls. Positioned near the anchor (preferring
 *     the step's `placement`, falling back if it won't fit) or
 *     centered for CENTERED steps.
 *
 * No dependency on floating-ui / radix-popover — the positioning logic
 * is small enough to own directly and keeps the bundle trim.
 */
interface TutorialOverlayProps {
  tutorial: TutorialApi;
}

const CUTOUT_OUTSET = 8; // px of breathing room around the anchor
const CALLOUT_GAP = 16;  // px between anchor and callout
const VIEWPORT_MARGIN = 16; // min distance from viewport edges

export function TutorialOverlay({ tutorial }: TutorialOverlayProps) {
  const step = TUTORIAL_STEPS[tutorial.currentStep];
  const isLast = tutorial.currentStep === tutorial.totalSteps - 1;
  const isFirst = tutorial.currentStep === 0;

  // Measure the anchor rect reactively. Re-measures on resize +
  // scroll so the highlight tracks the target even as layout shifts
  // (keyboard open on mobile, orientation change, etc.).
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!step?.anchor) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(step.anchor!);
      if (!el) {
        setAnchorRect(null);
        return;
      }
      // Scroll anchor into view on step entry so users on long pages
      // don't have to hunt for the highlighted element.
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      setAnchorRect(el.getBoundingClientRect());
    };
    measure();
    // Re-measure after scrollIntoView has time to settle.
    const raf = requestAnimationFrame(measure);
    const settle = window.setTimeout(measure, 350);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // Escape = skip. Registered while the overlay is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        tutorial.dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tutorial]);

  if (!step) return null;

  const content = (
    <div
      // fixed + full-viewport, above app chrome (header sits at z-40).
      className="fixed inset-0 z-50 pointer-events-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tutorial-title"
    >
      <Backdrop anchorRect={anchorRect} onDismiss={tutorial.dismiss} />

      <CalloutCard
        step={step}
        anchorRect={anchorRect}
        currentIndex={tutorial.currentStep}
        total={tutorial.totalSteps}
        isFirst={isFirst}
        isLast={isLast}
        onBack={tutorial.back}
        onSkip={tutorial.dismiss}
        onNext={isLast ? tutorial.dismiss : tutorial.next}
      />
    </div>
  );

  // Portal to body so the overlay escapes any transforms / stacking
  // contexts from parent components.
  return createPortal(content, document.body);
}

function Backdrop({
  anchorRect,
  onDismiss,
}: {
  anchorRect: DOMRect | null;
  onDismiss: () => void;
}) {
  // No anchor → full-screen tinted wash. Tapping dismisses.
  if (!anchorRect) {
    return (
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Skip tutorial"
        className="absolute inset-0 bg-space-900/80 backdrop-blur-[2px] pointer-events-auto cursor-default"
      />
    );
  }

  // Anchor → box-shadow "hole punch" over the anchor's rect. The
  // inner rect is transparent + visually punched out; the outer
  // shadow paints the tint across the rest of the viewport.
  const top = Math.max(0, anchorRect.top - CUTOUT_OUTSET);
  const left = Math.max(0, anchorRect.left - CUTOUT_OUTSET);
  const width = anchorRect.width + CUTOUT_OUTSET * 2;
  const height = anchorRect.height + CUTOUT_OUTSET * 2;
  return (
    <>
      {/* Fullscreen click-catcher behind the cutout so taps outside
          the highlight dismiss, but taps INSIDE the highlight don't. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Skip tutorial"
        className="absolute inset-0 pointer-events-auto cursor-default"
      />
      <div
        aria-hidden
        className="absolute rounded-lg border border-gold/50 ring-4 ring-gold/20 pointer-events-none transition-all duration-300"
        style={{
          top,
          left,
          width,
          height,
          boxShadow: '0 0 0 9999px rgba(10, 13, 22, 0.78)',
        }}
      />
    </>
  );
}

function CalloutCard({
  step,
  anchorRect,
  currentIndex,
  total,
  isFirst,
  isLast,
  onBack,
  onSkip,
  onNext,
}: {
  step: TutorialStep;
  anchorRect: DOMRect | null;
  currentIndex: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxWidth: number } | null>(null);

  // Position the callout after mount so we can measure its own size.
  // Falls back to centered if the anchor isn't available.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxWidth = Math.min(360, vw - VIEWPORT_MARGIN * 2);

    // Centered step (no anchor).
    if (!anchorRect) {
      setPosition({
        top: Math.max(VIEWPORT_MARGIN, (vh - cardRect.height) / 2),
        left: Math.max(VIEWPORT_MARGIN, (vw - maxWidth) / 2),
        maxWidth,
      });
      return;
    }

    // Anchored step: prefer the step's `placement`, otherwise pick the
    // side with the most room. On narrow screens (< 600px) force
    // top/bottom placement because side-by-side rarely fits.
    const narrow = vw < 600;
    const pref: 'top' | 'bottom' | 'left' | 'right' =
      narrow ? (anchorRect.top > vh / 2 ? 'top' : 'bottom')
             : (step.placement ?? 'bottom');

    let top = 0;
    let left = 0;

    if (pref === 'top') {
      top = anchorRect.top - cardRect.height - CALLOUT_GAP;
    } else if (pref === 'bottom') {
      top = anchorRect.bottom + CALLOUT_GAP;
    } else if (pref === 'left') {
      top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
      left = anchorRect.left - maxWidth - CALLOUT_GAP;
    } else { // right
      top = anchorRect.top + (anchorRect.height - cardRect.height) / 2;
      left = anchorRect.right + CALLOUT_GAP;
    }

    if (pref === 'top' || pref === 'bottom') {
      // Horizontally align to the anchor's center, clamped to viewport.
      left = anchorRect.left + anchorRect.width / 2 - maxWidth / 2;
    }

    // Clamp both axes so the card always sits inside the viewport
    // with at least VIEWPORT_MARGIN padding.
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - maxWidth - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - cardRect.height - VIEWPORT_MARGIN));

    setPosition({ top, left, maxWidth });
  }, [anchorRect, step]);

  return (
    <div
      ref={cardRef}
      className="absolute pointer-events-auto rounded-xl border border-gold/40 bg-space-800 shadow-2xl shadow-space-950/60"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        width: position?.maxWidth ?? 360,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <h2 id="tutorial-title" className="text-sm font-bold text-gold">
            {step.title}
          </h2>
          <span className="shrink-0 text-[10px] tracking-[0.18em] uppercase text-gray-500 font-bold">
            {currentIndex + 1} / {total}
          </span>
        </div>

        <p className="text-[13px] text-gray-300 leading-relaxed">
          {step.body}
        </p>

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={onSkip}
            className="text-[11px] text-gray-500 hover:text-gray-300 underline transition-colors"
          >
            {isLast ? 'Close' : 'Skip tour'}
          </button>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={onBack}
                className="px-3 h-8 rounded-md bg-space-700/60 border border-space-600 hover:border-gold/40 text-[12px] font-semibold text-gray-300 hover:text-gold transition-colors"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={onNext}
              className="px-4 h-8 rounded-md bg-gold text-space-900 font-bold text-[12px] hover:bg-gold-bright transition-colors"
            >
              {isLast ? 'Got it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
