/**
 * Front Desk — client
 *
 * 1. Loads index.json (built by GitHub Actions from /knowledge).
 * 2. Embeds the visitor's question in the browser with transformers.js —
 *    same model used at build time, so vectors are comparable. Free.
 * 3. Ranks chunks by cosine similarity and shows the best passages,
 *    each linking back to its source file on GitHub.
 * 4. Optionally (if the visitor saves an Anthropic API key in settings),
 *    asks Claude to compose an answer from the retrieved passages.
 */

const CONFIG = window.FRONT_DESK || {};
const TOP_K = 6;
const MIN_SCORE = 0.25;

const els = {
  orgName: document.getElementById("org-name"),
  tagline: document.getElementById("tagline"),
  subtitle: document.getElementById("subtitle"),
  form: document.getElementById("ask-form"),
  question: document.getElementById("question"),
  askButton: document.getElementById("ask-button"),
  chips: document.getElementById("chips"),
  status: document.getElementById("status"),
  ledger: document.getElementById("ledger"),
  bell: null, // created by setupBell() below
  indexMeta: document.getElementById("index-meta"),
  settingsToggle: document.getElementById("settings-toggle"),
  settings: document.getElementById("settings"),
  apiKey: document.getElementById("api-key"),
  apiModel: document.getElementById("api-model"),
  saveSettings: document.getElementById("save-settings"),
  clearSettings: document.getElementById("clear-settings"),
};

/* ── The bell ─────────────────────────────────────────────── */
/* Fully self-contained: builds its own button and graphic, so it
   works with any version of index.html. The sound is a synthesized
   brass counter bell — metallic strike + shimmering ring — via the
   Web Audio API. No sound files. */

let audioCtx = null;

function ensureAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

// Browsers block sound until the page gets a user gesture; unlock on the
// very first tap/click/keypress anywhere so later dings always play.
for (const evt of ["pointerdown", "keydown", "touchstart"]) {
  window.addEventListener(evt, ensureAudio, { once: true, passive: true });
}

function ringBell({ soft = false } = {}) {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = soft ? 0.16 : 0.4;
    master.connect(ctx.destination);

    // 1) The strike — a sharp metallic "tick" (filtered noise burst).
    const noiseLen = 0.03;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const strikeGain = ctx.createGain();
    strikeGain.gain.setValueAtTime(0.7, now);
    strikeGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
    noise.connect(hp).connect(strikeGain).connect(master);
    noise.start(now);

    // 2) The ring — inharmonic brass partials. Each partial is a detuned
    //    pair, which beats slightly and gives the real-bell shimmer.
    const partials = [
      { freq: 1479, gain: 1.0,  decay: 2.4 },
      { freq: 2093, gain: 0.5,  decay: 1.7 },
      { freq: 2794, gain: 0.32, decay: 1.1 },
      { freq: 3729, gain: 0.18, decay: 0.6 },
      { freq: 4699, gain: 0.08, decay: 0.35 },
    ];

    for (const p of partials) {
      for (const cents of [-5, 5]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = p.freq;
        osc.detune.value = cents;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(p.gain / 2, now + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
        osc.connect(gain).connect(master);
        osc.start(now);
        osc.stop(now + p.decay + 0.05);
      }
    }
  } catch {
    /* audio unavailable — the bell stays decorative */
  }
}

// A proper counter bell: domed top, plunger button, round base.
const BELL_SVG = `
  <svg class="bell" viewBox="0 0 40 34" width="30" height="26" aria-hidden="true">
    <g class="bell-plunger">
      <rect x="18" y="3" width="4" height="6" rx="1.4" fill="var(--brass)"/>
      <rect x="15.5" y="1" width="9" height="3.4" rx="1.7" fill="var(--brass)"/>
    </g>
    <g class="bell-dome">
      <path d="M20 7 C10.5 7 4.5 14 3.5 23 L36.5 23 C35.5 14 29.5 7 20 7 Z" fill="var(--brass)"/>
      <path d="M20 7 C13.5 7 8.8 11.5 6.8 17 C11 12.5 15.5 10.4 20.5 10.2 C17 9.2 16 8 20 7 Z" fill="#c7a45c" opacity="0.85"/>
    </g>
    <rect x="1" y="24.5" width="38" height="4.5" rx="2.2" fill="var(--spruce)"/>
    <rect x="6" y="29" width="28" height="3" rx="1.5" fill="var(--spruce)" opacity="0.55"/>
  </svg>`;

function setupBell() {
  // Find whatever bell markup this page has and rebuild it in place.
  const old = document.getElementById("bell") || document.querySelector(".bell");
  if (!old) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "bell-button";
  button.id = "bell-button";
  button.title = "Ring for service";
  button.setAttribute("aria-label", "Ring the bell and ask a question");
  button.innerHTML = BELL_SVG;

  // If the old bell was already wrapped in a button, replace the wrapper;
  // otherwise replace the bare SVG.
  const target = old.closest("#bell-button, .bell-button") || old;
  target.replaceWith(button);

  button.addEventListener("click", () => {
    ringBell();
    shakeBell();
    if (els.question) {
      els.question.focus();
      els.question.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  return button.querySelector(".bell");
}

function shakeBell() {
  if (!els.bell) return;
  els.bell?.classList.add("ringing");
  setTimeout(() => {
    if (!busy) els.bell?.classList.remove("ringing");
  }, 900);
}

els.bell = setupBell();

/* ── Branding ─────────────────────────────────────────────── */

els.orgName.textContent = CONFIG.orgName || "";
els.tagline.textContent = CONFIG.tagline || "How can we help?";
els.subtitle.textContent = CONFIG.subtitle || "";
document.title = `Front Desk — ${CONFIG.orgName || "Ask us anything"}`;

for (const suggestion of CONFIG.suggestions || []) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = suggestion;
  chip.addEventListener("click", () => {
    els.question.value = suggestion;
    els.form.requestSubmit();
  });
  els.chips.appendChild(chip);
}

/* ── Settings (optional Claude synthesis) ─────────────────── */

const stored = {
  get key() { return localStorage.getItem("frontdesk.apiKey") || ""; },
  set key(v) { v ? localStorage.setItem("frontdesk.apiKey", v) : localStorage.removeItem("frontdesk.apiKey"); },
  get model() { return localStorage.getItem("frontdesk.model") || "claude-haiku-4-5"; },
  set model(v) { localStorage.setItem("frontdesk.model", v); },
};

els.apiKey.value = stored.key;
els.apiModel.value = stored.model;

els.settingsToggle.addEventListener("click", () => {
  els.settings.hidden = !els.settings.hidden;
});
els.saveSettings.addEventListener("click", () => {
  stored.key = els.apiKey.value.trim();
  stored.model = els.apiModel.value.trim() || "claude-haiku-4-5";
  setStatus(stored.key ? "Key saved in this browser. Answers will be composed by Claude." : "No key set — showing best passages instead.");
  els.settings.hidden = true;
});
els.clearSettings.addEventListener("click", () => {
  stored.key = "";
  els.apiKey.value = "";
  setStatus("Key removed.");
});

/* ── Index & embedding model ──────────────────────────────── */

let index = null;
let indexPromise = null;
let embedder = null;
let embedderPromise = null;

function setStatus(text) {
  els.status.textContent = text;
}

async function loadIndex() {
  if (index) return index;
  indexPromise ??= (async () => {
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Couldn't load index.json — has the deploy workflow run yet?");
    index = await res.json();
    const when = index.generated ? new Date(index.generated).toLocaleDateString() : "unknown";
    els.indexMeta.textContent = `${index.documentCount} document(s) · ${index.chunks.length} passages · indexed ${when}`;
    return index;
  })();
  return indexPromise;
}

async function loadEmbedder() {
  if (embedder) return embedder;
  embedderPromise ??= (async () => {
    setStatus("Warming up the desk — loading the search model (first visit only, ~25 MB)…");
    const { pipeline, env } = await import(
      "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2"
    );
    env.allowLocalModels = false;
    embedder = await pipeline("feature-extraction", (index && index.model) || "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    setStatus("");
    return embedder;
  })();
  return embedderPromise;
}

// Warm both in the background so the first question feels instant.
loadIndex().catch((err) => setStatus(err.message));
if ("requestIdleCallback" in window) {
  requestIdleCallback(() => loadEmbedder().catch(() => {}));
} else {
  setTimeout(() => loadEmbedder().catch(() => {}), 1500);
}

/* ── Retrieval ────────────────────────────────────────────── */

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum; // vectors are normalized, so dot product = cosine similarity
}

async function retrieve(question) {
  const [idx] = await Promise.all([loadIndex(), loadEmbedder()]);
  const output = await embedder(question, { pooling: "mean", normalize: true });
  const query = Array.from(output.data);

  const results = idx.chunks
    .map((chunk) => ({ chunk, score: dot(query, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .filter((r) => r.score >= MIN_SCORE);

  return { results, query };
}

/**
 * Free-mode answer composition: score every sentence in the retrieved
 * passages against the question (same in-browser model) and stitch the
 * strongest few into one concise answer, in reading order.
 */
async function composeExtractiveAnswer(queryVec, results) {
  const candidates = [];
  results.forEach((r, ri) => {
    const sentences = r.chunk.text.split(/(?<=[.!?])\s+|\n+/);
    sentences.forEach((raw, pos) => {
      const t = raw.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*•]\s*/, "");
      if (t.length >= 40 && t.length <= 420) {
        candidates.push({ t, order: ri * 1000 + pos });
      }
    });
  });
  if (candidates.length === 0) return results[0].chunk.text;

  const pool = candidates.slice(0, 80); // bound the in-browser compute
  const output = await embedder(pool.map((c) => c.t), { pooling: "mean", normalize: true });
  const dims = output.dims[1];
  pool.forEach((c, i) => {
    let score = 0;
    for (let k = 0; k < dims; k++) score += queryVec[k] * output.data[i * dims + k];
    c.score = score;
  });

  const picked = pool
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => a.order - b.order); // reading order, not score order

  if (picked.length === 0) return results[0].chunk.text;
  return picked.map((c) => c.t).join(" ");
}

/* ── Optional Claude synthesis ────────────────────────────── */

async function composeAnswer(question, results) {
  const context = results
    .map((r, i) => `[${i + 1}] (${r.chunk.source})\n${r.chunk.text}`)
    .join("\n\n---\n\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": stored.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: stored.model,
      max_tokens: 700,
      system:
        "You are the front desk assistant for an organization. Answer the visitor's question using ONLY the numbered reference passages provided. Cite passages inline like [1] or [2]. If the passages don't contain the answer, say so plainly and suggest what they might look for instead. Be warm, concise, and professional.",
      messages: [
        {
          role: "user",
          content: `Reference passages:\n\n${context}\n\nVisitor's question: ${question}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude request failed (${res.status}). ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/* ── Rendering ────────────────────────────────────────────── */

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function sourceUrl(idx, chunk) {
  if (chunk.link) return chunk.link; // websites & external repos carry their own URL
  if (/^https?:\/\//i.test(chunk.source)) return chunk.source;
  if (!idx.repo) return null;
  return `https://github.com/${idx.repo}/blob/${idx.branch || "main"}/${chunk.source}`;
}

function renderEntry(question) {
  const entry = document.createElement("article");
  entry.className = "entry";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  entry.innerHTML = `
    <h2 class="entry-question">${escapeHtml(question)}</h2>
    <span class="entry-time">Asked at ${time}</span>
    <p class="entry-answer">Looking that up…</p>
  `;
  els.ledger.replaceChildren(entry); // only the current question is shown
  return entry;
}

function renderSources(entry, idx, results) {
  const label = document.createElement("p");
  label.className = "sources-label";
  label.textContent = "Sources";
  entry.appendChild(label);
  const wrap = document.createElement("div");
  wrap.className = "sources";
  // Show each source file once, at its best-scoring passage.
  const seen = new Map();
  for (const r of results) {
    if (!seen.has(r.chunk.source)) seen.set(r.chunk.source, r);
  }
  for (const r of seen.values()) {
    const url = sourceUrl(idx, r.chunk);
    const card = document.createElement(url ? "a" : "div");
    card.className = "source-card";
    if (url) {
      card.href = url;
      card.target = "_blank";
      card.rel = "noopener";
    }
    card.innerHTML = `
      <p class="source-title">${escapeHtml(r.chunk.title)}</p>
      <p class="source-path">${escapeHtml(r.chunk.source)}</p>
      <p class="source-snippet">${escapeHtml(r.chunk.text.slice(0, 220))}</p>
      <p class="source-score">${Math.round(r.score * 100)}% match</p>
    `;
    wrap.appendChild(card);
  }
  entry.appendChild(wrap);
}

/* ── Ask flow ─────────────────────────────────────────────── */

let busy = false;

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = els.question.value.trim();
  if (!question || busy) return;

  busy = true;
  els.askButton.disabled = true;
  els.bell?.classList.add("ringing");
  els.question.value = "";

  // Creating/resuming the audio context during this click/submit gesture
  // lets the soft "answer ready" ding play later without being blocked.
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio — fine */ }

  const entry = renderEntry(question);
  const answerEl = entry.querySelector(".entry-answer");

  try {
    const { results, query } = await retrieve(question);
    const idx = await loadIndex();

    if (results.length === 0) {
      answerEl.className = "entry-answer empty-result";
      answerEl.textContent =
        "I couldn't find anything about that in our files. Try rephrasing, or check whether the topic has been added to the knowledge folder yet.";
      return;
    }

    if (stored.key) {
      answerEl.textContent = "Composing an answer…";
      try {
        answerEl.textContent = await composeAnswer(question, results);
      } catch (err) {
        answerEl.textContent = results[0].chunk.text;
        const note = document.createElement("p");
        note.className = "entry-note";
        note.textContent = `Claude synthesis failed (${err.message}) — showing the best matching passage instead.`;
        entry.appendChild(note);
      }
    } else {
      answerEl.textContent = "Composing an answer…";
      answerEl.textContent = await composeExtractiveAnswer(query, results);
      const note = document.createElement("p");
      note.className = "entry-note";
      note.textContent = "Composed from the most relevant material in our files — sources below.";
      entry.appendChild(note);
    }

    renderSources(entry, idx, results);
    ringBell({ soft: true }); // answer's ready — a gentle ding
  } catch (err) {
    answerEl.className = "entry-answer empty-result";
    answerEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    busy = false;
    els.askButton.disabled = false;
    els.bell?.classList.remove("ringing");
    setStatus("");
  }
});
