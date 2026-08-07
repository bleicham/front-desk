const ASSET_EXTENSION = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|zip|gz|tar|mp4|mp3)$/i;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function canonicalUrl(value, base) {
  try {
    const url = new URL(decodeEntities(value), base);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (ASSET_EXTENSION.test(url.pathname)) return null;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractLinks(content, pageUrl) {
  const links = [];
  const patterns = [
    /\bhref\s*=\s*["']([^"']+)["']/gi,
    /\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(content || "").matchAll(pattern)) {
      const url = canonicalUrl(match[1], pageUrl);
      if (url) links.push(url);
    }
  }
  return [...new Set(links)];
}

/** Extract canonical <loc> values from either a sitemap or sitemap index. */
export function extractSitemapUrls(xml, sitemapUrl) {
  const urls = [];
  for (const match of String(xml || "").matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const url = canonicalUrl(match[1].trim(), sitemapUrl);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

