import test from "node:test";
import assert from "node:assert/strict";
import { canonicalUrl, extractLinks, extractSitemapUrls } from "../scripts/crawl-utils.mjs";

test("canonicalizes content links and removes fragments and tracking queries", () => {
  assert.equal(
    canonicalUrl("../guide/?utm_source=test#intro", "https://docs.example.org/en/stable/page.html"),
    "https://docs.example.org/en/guide/",
  );
  assert.equal(canonicalUrl("/image.png", "https://example.org/"), null);
});

test("extracts unique HTML and Markdown links", () => {
  const content = '<a href="/guide?a=1#top">Guide</a> [Guide](/guide)';
  assert.deepEqual(extractLinks(content, "https://example.org/start"), ["https://example.org/guide"]);
});

test("extracts and decodes URLs from sitemaps", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.org/a?x=1&amp;y=2</loc></url>
    <url><loc>/b#part</loc></url>
  </urlset>`;
  assert.deepEqual(extractSitemapUrls(xml, "https://example.org/sitemap.xml"), [
    "https://example.org/a",
    "https://example.org/b",
  ]);
});

