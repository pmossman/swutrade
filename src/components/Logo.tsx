interface LogoProps {
  /** Tailwind size class for the mark (e.g. "w-8 h-8"). */
  className?: string;
}

// Inline SVG logomark — two cards leaning toward a gold balance point.
// Shares the emerald / blue side colors used throughout the app and
// should read at any size from favicon (16px) up to hero (128px).
export function Logo({ className = 'w-8 h-8' }: LogoProps) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <radialGradient id="logo-glow" cx="50%" cy="55%" r="50%">
          <stop offset="0%" stopColor="#FFD700" stopOpacity="1" />
          <stop offset="100%" stopColor="#F5A623" stopOpacity="0" />
        </radialGradient>
        <filter id="logo-shadow">
          <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.4" />
        </filter>
      </defs>

      {/* Artwork shifted up by 8 so the visual center lands at the SVG
          viewBox's vertical middle — otherwise flex items-center puts
          the wordmark slightly high next to this mark. */}
      <g transform="translate(0 -8)">
        <circle cx="50" cy="55" r="18" fill="url(#logo-glow)" opacity="0.55" />

        <g transform="translate(38 58) rotate(-18)" filter="url(#logo-shadow)">
          <rect x="-17" y="-25" width="34" height="50" rx="4" fill="#0f3f2f" stroke="#34d399" strokeWidth="3" />
          <rect x="-12" y="-20" width="24" height="26" rx="2" fill="#065f46" opacity="0.7" />
        </g>

        <g transform="translate(62 58) rotate(18)" filter="url(#logo-shadow)">
          <rect x="-17" y="-25" width="34" height="50" rx="4" fill="#0f2a52" stroke="#60a5fa" strokeWidth="3" />
          <rect x="-12" y="-20" width="24" height="26" rx="2" fill="#1e3a8a" opacity="0.7" />
        </g>

        <circle cx="50" cy="48" r="5" fill="#FFD700" />
        <circle cx="50" cy="48" r="7" fill="none" stroke="#FFA500" strokeWidth="1" opacity="0.7" />
      </g>
    </svg>
  );
}
