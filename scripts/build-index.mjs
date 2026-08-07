/**
 * Front Desk — index builder
 *
 * Reads every supported file in /knowledge, extracts text, splits it into
 * chunks, embeds each chunk with a local sentence-transformer model, and
 * writes site/index.json for the GitHub Pages front end.
 *
 * Runs automatically in GitHub Actions on every push. No API keys needed —
 * the embedding model (all-MiniLM-L6-v2, ~90 MB) runs entirely inside the
 * Action runner.
 */

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { env, pipeline } from "@xenova/transformers";

// Cache the downloaded model inside the repo workspace so GitHub Actions
// can restore it between runs (see .github/workflows/deploy.yml).
env.cacheDir = ".model-cache";

const KNOWLEDGE_DIR = "knowledge";
const OUTPUT_FILE = "site/index.json";
const MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_FILE_BYTES = 10 * 1024 * 1024; // skip anything over 10 MB
const CHUNK_CHARS = 1400;                // target chunk size
const CHUNK_OVERLAP = 200;               // overlap between chunks

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yml", ".yaml",
  ".html", ".htm", ".rst", ".org", ".log",
]);

/* ---------------------------------------------------------------- */
/* File discovery                                                    */
/* ---------------------------------------------------------------- */

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Text extraction                                                   */
/* ---------------------------------------------------------------- */

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractText(path) {
  const ext = extname(path).toLowerCase();

  if (ext === ".pdf") {
    const { extractText: extractPdf, getDocumentProxy } = await import("unpdf");
    const buffer = await readFile(path);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractPdf(pdf, { mergePages: true });
    return text;
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ path });
    return value;
  }

  if (ext === ".html" || ext === ".htm") {
    return stripHtml(await readFile(path, "utf8"));
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return readFile(path, "utf8");
  }

  return null; // unsupported type — skipped
}

/* ---------------------------------------------------------------- */
/* Chunking                                                          */
/* ---------------------------------------------------------------- */

/**
 * Markdown-aware chunking: split on headings first so chunks follow the
 * document's own structure, then window anything still too long.
 */
function chunkText(text, isMarkdown) {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  let sections;
  if (isMarkdown) {
    sections = cleaned.split(/\n(?=#{1,4}\s)/g);
  } else {
    sections = cleaned.split(/\n\s*\n/g);
  }

  // Merge small sections together, window large ones.
  const chunks = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 40) chunks.push(trimmed);
    current = "";
  };

  for (const section of sections) {
    if ((current + "\n\n" + section).length <= CHUNK_CHARS) {
      current = current ? current + "\n\n" + section : section;
      continue;
    }
    flush();
    if (section.length <= CHUNK_CHARS) {
      current = section;
    } else {
      // Sliding window over an oversized section.
      let start = 0;
      while (start < section.length) {
        const end = Math.min(start + CHUNK_CHARS, section.length);
        // Try to break on a sentence or line boundary.
        let cut = end;
        if (end < section.length) {
          const window = section.slice(start, end);
          const lastBreak = Math.max(
            window.lastIndexOf(". "),
            window.lastIndexOf("\n")
          );
          if (lastBreak > CHUNK_CHARS * 0.5) cut = start + lastBreak + 1;
        }
        const piece = section.slice(start, cut).trim();
        if (piece.length > 40) chunks.push(piece);
        if (cut >= section.length) break;
        start = Math.max(cut - CHUNK_OVERLAP, start + 1);
      }
    }
  }
  flush();
  return chunks;
}

function titleFor(path, text) {
  // First markdown heading if present, otherwise the filename.
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 120);
  return basename(path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

async function main() {
  const files = await walk(KNOWLEDGE_DIR);
  if (files.length === 0) {
    console.warn(`No files found in /${KNOWLEDGE_DIR} — writing empty index.`);
  }

  const documents = [];
  for (const file of files) {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) {
      console.warn(`Skipping ${file} (larger than 10 MB)`);
      continue;
    }
    let text;
    try {
      text = await extractText(file);
    } catch (err) {
      console.warn(`Skipping ${file}: ${err.message}`);
      continue;
    }
    if (!text || !text.trim()) {
      console.warn(`Skipping ${file} (no extractable text)`);
      continue;
    }
    const rel = relative(".", file).replace(/\\/g, "/");
    const isMarkdown = /\.(md|markdown)$/i.test(file);
    const pieces = chunkText(text, isMarkdown);
    const title = titleFor(file, text);
    for (let i = 0; i < pieces.length; i++) {
      documents.push({ source: rel, title, part: i, text: pieces[i] });
    }
    console.log(`Indexed ${rel} — ${pieces.length} chunk(s)`);
  }

  console.log(`\nEmbedding ${documents.length} chunks with ${MODEL}…`);
  const embed = await pipeline("feature-extraction", MODEL, {
    quantized: true,
  });

  const BATCH = 16;
  for (let i = 0; i < documents.length; i += BATCH) {
    const batch = documents.slice(i, i + BATCH);
    const output = await embed(
      batch.map((d) => d.text),
      { pooling: "mean", normalize: true }
    );
    const dims = output.dims[1];
    const flat = output.data;
    batch.forEach((doc, j) => {
      const vec = new Array(dims);
      for (let k = 0; k < dims; k++) {
        // Round to shrink the JSON file; costs ~nothing in accuracy.
        vec[k] = Math.round(flat[j * dims + k] * 1e5) / 1e5;
      }
      doc.embedding = vec;
    });
    console.log(`  ${Math.min(i + BATCH, documents.length)} / ${documents.length}`);
  }

  const repo = process.env.GITHUB_REPOSITORY || "";
  const branch = (process.env.GITHUB_REF_NAME || "main").replace(/\//g, "%2F");

  const index = {
    model: MODEL,
    generated: new Date().toISOString(),
    repo,
    branch,
    documentCount: new Set(documents.map((d) => d.source)).size,
    chunks: documents.map((d, i) => ({
      id: i,
      source: d.source,
      title: d.title,
      part: d.part,
      text: d.text,
      embedding: d.embedding,
    })),
  };

  await mkdir("site", { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(index));
  const size = (JSON.stringify(index).length / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${OUTPUT_FILE} (${size} MB, ${documents.length} chunks from ${index.documentCount} documents)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
