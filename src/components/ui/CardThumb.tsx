import { useState } from 'react';
import { cardImageUrl } from '../../services/priceService';

/**
 * Adaptive card image — leaders are landscape, units are portrait.
 * Detected on image load (naturalWidth > naturalHeight) so the box
 * can flip its aspect to show the full card instead of crop-covering
 * to portrait. Originally lived inline in TradeRow; six other surfaces
 * inlined a portrait-only `<img>` and cropped leaders weirdly. Audit
 * 10-ux-primitives.md #6 + 14-domain-rendering.md.
 *
 * Sizes are predefined (xs / sm / md / lg) to keep call sites short
 * and the visual rhythm consistent across the app. Fallback `?` glyph
 * when productId is missing or the image errors.
 */
export type ThumbSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE_PORTRAIT: Record<ThumbSize, string> = {
  xs: 'w-5 h-7 rounded-sm text-[8px]',
  sm: 'w-7 h-10 rounded text-[9px]',
  md: 'w-10 h-14 rounded-md text-[10px]',
  lg: 'w-20 h-28 rounded-lg text-sm',
};

const SIZE_LANDSCAPE: Record<ThumbSize, string> = {
  xs: 'w-7 h-5 rounded-sm text-[8px]',
  sm: 'w-10 h-7 rounded text-[9px]',
  md: 'w-14 h-10 rounded-md text-[10px]',
  lg: 'w-28 h-20 rounded-lg text-sm',
};

interface CardThumbProps {
  productId?: string;
  name: string;
  size: ThumbSize;
  /** Override class — when callers need different rounding, sizing,
   *  or full-bleed fitting (RowShell uses `w-full h-full`). When set,
   *  the size+orientation tokens above are ignored. */
  className?: string;
  /** Defaults to `'lg'` for `size === 'lg'`, `'md'` otherwise — chosen
   *  so the served image isn't oversized for a 20px thumb. Pass to
   *  override (e.g. always-large for hero shots). */
  imgSize?: 'sm' | 'md' | 'lg';
}

export function CardThumb({ productId, name, size, className, imgSize }: CardThumbProps) {
  const [errored, setErrored] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const resolvedImgSize = imgSize ?? (size === 'lg' ? 'lg' : 'md');
  const src = cardImageUrl(productId, resolvedImgSize);

  const sizeClass = className
    ?? (isLandscape ? SIZE_LANDSCAPE : SIZE_PORTRAIT)[size];

  if (!src || errored) {
    return (
      <div className={`${sizeClass} bg-space-600 shrink-0 flex items-center justify-center text-gray-600`}>
        ?
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setErrored(true)}
      onLoad={e => {
        const img = e.currentTarget;
        if (img.naturalWidth > img.naturalHeight) setIsLandscape(true);
      }}
      className={`${sizeClass} object-cover shrink-0 bg-space-600`}
    />
  );
}
