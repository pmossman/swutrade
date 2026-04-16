// Common crawler/bot user agents that fetch link previews
const CRAWLER_PATTERN = /bot|crawl|spider|slurp|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot|Slackbot|Applebot|Google-InspectionTool|Googlebot|bingbot/i;

export default function middleware(request: Request) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') || '';

  // Profile URLs: /u/<handle> → simple OG tags with the user's name.
  // No OG image for now — just text metadata for Discord/Twitter unfurls.
  const profileMatch = url.pathname.match(/^\/u\/([^/]+)/);
  if (profileMatch && CRAWLER_PATTERN.test(ua)) {
    const handle = decodeURIComponent(profileMatch[1]);
    const title = `@${handle} on SWU Trade`;
    const description = `View ${handle}'s Star Wars Unlimited trade lists`;
    const canonicalUrl = url.toString();
    return new Response(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><title>${title}</title>
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="profile">
  <meta property="og:site_name" content="SWU Trade">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${description}">
</head><body><p>Redirecting…</p></body></html>`, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 's-maxage=3600, stale-while-revalidate=86400',
      },
    });
  }

  // Only intercept requests to root path that carry shareable params
  // (trade or list).
  const hasTrade = url.searchParams.has('y') || url.searchParams.has('t');
  const hasList = url.searchParams.has('w') || url.searchParams.has('a');
  if (url.pathname !== '/' || (!hasTrade && !hasList)) {
    return;
  }

  // Only intercept for crawlers/bots
  if (!CRAWLER_PATTERN.test(ua)) {
    return;
  }

  // Build OG image URL with whichever params are relevant. List mode
  // takes precedence when no trade is present (matches /api/og's own
  // routing).
  const ogParams = new URLSearchParams();
  const y = url.searchParams.get('y');
  const t = url.searchParams.get('t');
  const w = url.searchParams.get('w');
  const a = url.searchParams.get('a');
  const pct = url.searchParams.get('pct');
  const pm = url.searchParams.get('pm');
  if (y) ogParams.set('y', y);
  if (t) ogParams.set('t', t);
  if (!y && !t) {
    // List mode — include only the list params so /api/og routes correctly.
    if (w) ogParams.set('w', w);
    if (a) ogParams.set('a', a);
  }
  if (pct) ogParams.set('pct', pct);
  if (pm) ogParams.set('pm', pm);

  const ogImageUrl = `${url.origin}/api/og?${ogParams.toString()}`;
  const canonicalUrl = url.toString();

  let title: string;
  let description: string;
  if (hasTrade) {
    const yourCount = y ? y.split(',').length : 0;
    const theirCount = t ? t.split(',').length : 0;
    const pctVal = pct || '80';
    const modeLabel = pm === 'l' ? 'Low' : 'Market';
    title = 'SWU Trade Summary';
    description = `Trade: ${yourCount} card${yourCount !== 1 ? 's' : ''} ↔ ${theirCount} card${theirCount !== 1 ? 's' : ''} @ ${pctVal}% TCGPlayer ${modeLabel}`;
  } else {
    const wantsCount = w ? w.split(',').length : 0;
    const availCount = a ? a.split(',').length : 0;
    const parts: string[] = [];
    if (wantsCount > 0) parts.push(`${wantsCount} want${wantsCount !== 1 ? 's' : ''}`);
    if (availCount > 0) parts.push(`${availCount} available`);
    title = 'SWU Shared List';
    description = parts.length > 0 ? `Shared list: ${parts.join(' · ')}` : 'A shared SWU list';
  }

  // Return a minimal HTML page with OG tags for crawlers
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SWU Trade">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${title}">
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
  matcher: ['/', '/u/:path*'],
};
