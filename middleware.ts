import { next } from '@vercel/edge';

// Common crawler/bot user agents that fetch link previews
const CRAWLER_PATTERN = /bot|crawl|spider|slurp|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot|Slackbot|iMessage|Applebot|Google-InspectionTool|Googlebot|bingbot/i;

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') || '';

  // Only intercept requests to root path with trade params
  if (url.pathname !== '/' || (!url.searchParams.has('y') && !url.searchParams.has('t'))) {
    return next();
  }

  // Only intercept for crawlers/bots
  if (!CRAWLER_PATTERN.test(ua)) {
    return next();
  }

  // Build OG image URL with the same trade params
  const ogParams = new URLSearchParams();
  const y = url.searchParams.get('y');
  const t = url.searchParams.get('t');
  const pct = url.searchParams.get('pct');
  const pm = url.searchParams.get('pm');
  if (y) ogParams.set('y', y);
  if (t) ogParams.set('t', t);
  if (pct) ogParams.set('pct', pct);
  if (pm) ogParams.set('pm', pm);

  const ogImageUrl = `${url.origin}/api/og?${ogParams.toString()}`;
  const canonicalUrl = url.toString();

  // Count cards for the description
  const yourCount = y ? y.split(',').length : 0;
  const theirCount = t ? t.split(',').length : 0;
  const pctVal = pct || '80';
  const modeLabel = pm === 'l' ? 'Low' : 'Market';
  const description = `Trade: ${yourCount} card${yourCount !== 1 ? 's' : ''} ↔ ${theirCount} card${theirCount !== 1 ? 's' : ''} @ ${pctVal}% TCGPlayer ${modeLabel}`;

  // Return a minimal HTML page with OG tags for crawlers
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>SWU Trade — Star Wars Unlimited Trade Calculator</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="SWU Trade Summary">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SWU Trade">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="SWU Trade Summary">
  <meta name="twitter:description" content="${description}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <link rel="canonical" href="${canonicalUrl}">
</head>
<body>
  <p>Redirecting to <a href="${canonicalUrl}">SWU Trade</a>...</p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

export const config = {
  matcher: '/',
};
