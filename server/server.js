// SCORM Studio quiz server
// Holds your Claude API key so colleagues can generate quiz questions
// without ever seeing the key. No packages needed: Node 18 or newer.
//
// Settings come from environment variables (see .env.example):
//   ANTHROPIC_API_KEY  your Claude API key (required)
//   ACCESS_CODE        code your colleagues type into SCORM Studio (required)
//   MODEL              Claude model to use            (default claude-sonnet-5-5)
//   PORT               port to listen on               (default 8787)
//   LIMIT_PER_HOUR     requests per person per hour    (default 20)
//   LIMIT_PER_DAY      requests in total per day       (default 100)
//   MAX_QUESTIONS      most questions in one request   (default 15)

//   HTML_FILE          path to scorm-studio.html to host at /   (default: next to server.js)
//
//   AUTO_UPDATE        "1" to auto-pull scorm-studio.html from the newest GitHub Release (default off)
//   LIVE_HTML_FILE     writable path to keep the auto-updated copy in (required for AUTO_UPDATE;
//                      must be writable - HTML_FILE itself is usually a read-only mount)
//   UPDATE_REPO        "owner/repo" to check                          (default godwin20/SCORM-Studio)
//   UPDATE_INTERVAL_MIN how often to check, in minutes, minimum 5      (default 60)
//
// Web addresses:
//   GET  /          the SCORM Studio builder (if scorm-studio.html is present)
//   GET  /ping      "is it running" check, no code needed
//   GET  /health    checks the access code, shows requests left today
//   POST /generate  writes quiz questions (needs the access code)
//   POST /draft     drafts or rewrites a page's text (needs the access code; shares the same limits)

"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const pathMod = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const MODEL = process.env.MODEL || "claude-sonnet-5-5";
const PORT = parseInt(process.env.PORT || "8787", 10);
const LIMIT_PER_HOUR = parseInt(process.env.LIMIT_PER_HOUR || "20", 10);
const LIMIT_PER_DAY = parseInt(process.env.LIMIT_PER_DAY || "100", 10);
const MAX_QUESTIONS = parseInt(process.env.MAX_QUESTIONS || "15", 10);
const API_URL = process.env.API_URL || "https://api.anthropic.com/v1/messages"; // only change for testing
const HTML_FILE = process.env.HTML_FILE || pathMod.join(__dirname, "scorm-studio.html");
const TRUST_PROXY = process.env.TRUST_PROXY === "1"; // only true behind a reverse proxy that sets x-forwarded-for itself
const MAX_BODY = 600 * 1024;       // biggest request accepted (course text)
const MAX_CONTENT = 150000;        // characters of course text sent to Claude

const AUTO_UPDATE = process.env.AUTO_UPDATE === "1";
const LIVE_HTML_FILE = process.env.LIVE_HTML_FILE || "";
const UPDATE_REPO = process.env.UPDATE_REPO || "godwin20/SCORM-Studio";
const UPDATE_INTERVAL_MIN = Math.max(5, parseInt(process.env.UPDATE_INTERVAL_MIN || "60", 10) || 60);
const UPDATE_API_BASE = process.env.UPDATE_API_BASE || "https://api.github.com"; // only change for testing
const UPDATE_INITIAL_DELAY_MS = parseInt(process.env.UPDATE_INITIAL_DELAY_MS || "5000", 10); // only change for testing
if (AUTO_UPDATE && !LIVE_HTML_FILE) {
  console.error("AUTO_UPDATE is on but LIVE_HTML_FILE is not set, so there is nowhere writable to put the update. Auto-update is disabled.");
}

if (!API_KEY || !ACCESS_CODE) {
  console.error("Missing settings: set ANTHROPIC_API_KEY and ACCESS_CODE (see .env.example).");
  process.exit(1);
}
if (ACCESS_CODE.length < 8) {
  console.error("ACCESS_CODE is too short. Use at least 8 characters.");
  process.exit(1);
}

// ---------- limits ----------
const perIp = new Map();             // ip -> [timestamps in the last hour]
let day = new Date().toDateString();
let usedToday = 0;

function checkLimits(ip) {
  const now = Date.now();
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); usedToday = 0; }
  if (usedToday >= LIMIT_PER_DAY) return "The daily limit for question writing has been reached. Try again tomorrow.";
  const recent = (perIp.get(ip) || []).filter((t) => now - t < 3600000);
  if (recent.length >= LIMIT_PER_HOUR) return "You have reached the hourly limit for question writing. Try again later.";
  recent.push(now);
  perIp.set(ip, recent);
  usedToday++;
  return null;
}
setInterval(() => { // tidy old entries
  const now = Date.now();
  for (const [ip, list] of perIp) { const keep = list.filter((t) => now - t < 3600000); if (keep.length) perIp.set(ip, keep); else perIp.delete(ip); }
  for (const [ip, t] of badTries) { if (now - t.first > 900000) badTries.delete(ip); }
}, 600000).unref();

// failed access-code attempts, to slow down guessing
const badTries = new Map();
function tooManyBadTries(ip) {
  const t = badTries.get(ip);
  return t && t.count >= 10 && Date.now() - t.first < 900000;
}
function noteBadTry(ip) {
  const t = badTries.get(ip);
  if (!t || Date.now() - t.first > 900000) badTries.set(ip, { count: 1, first: Date.now() });
  else t.count++;
}

function codeMatches(given) {
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(ACCESS_CODE).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- prompt (keep in step with buildPrompt in scorm-studio.html) ----------
function buildPrompt(req) {
  const levels = {
    easy: "straightforward recall of facts stated in the content",
    mixed: "a mix of simple recall and short practical scenarios",
    hard: "short realistic workplace scenarios where the learner must apply the guidance",
  };
  const existing = (req.existing || []).map((q) => "- " + q).join("\n");
  return "You are writing an assessment for a workplace e-learning course. Write exactly " + req.count + " multiple-choice questions based ONLY on the course content below.\n\n" +
    "Rules:\n" +
    "- Use only facts, rules and procedures that appear in the content. Do not add outside knowledge.\n" +
    "- Questions should test " + (levels[req.level] || levels.mixed) + ".\n" +
    "- Each question has 4 answer options (3 if the content only supports 3), exactly one correct.\n" +
    "- Wrong options must be plausible but clearly wrong according to the content. Do not use \"All of the above\" or \"None of the above\".\n" +
    "- Keep questions and answers short and in plain British English.\n" +
    "- Spread questions across the pages rather than repeating one point.\n" +
    "- Feedback: one sentence explaining why the correct answer is right, based on the content.\n" +
    (req.focus ? "- Concentrate on: " + req.focus + "\n" : "") +
    (existing ? "- Do not repeat or closely reword these existing questions:\n" + existing + "\n" : "") +
    "\nReply with ONLY a JSON array, no other text, in this shape:\n" +
    '[{"question":"...","options":["...","...","...","..."],"correct":0,"feedback":"...","page":1}]\n' +
    "\"correct\" is the zero-based index of the right option. \"page\" is the page number the question is based on.\n\n" +
    "COURSE TITLE: " + req.title + "\n\nCOURSE CONTENT:\n" + req.content;
}

function cleanRequest(b) {
  if (!b || typeof b !== "object") return null;
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  const content = str(b.content, MAX_CONTENT + 1000);
  if (content.trim().length < 50) return null;
  return {
    title: str(b.title, 200),
    content: content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) + "\n\n[content shortened]" : content,
    count: Math.max(1, Math.min(MAX_QUESTIONS, parseInt(b.count, 10) || 5)),
    level: ["easy", "mixed", "hard"].includes(b.level) ? b.level : "mixed",
    focus: str(b.focus, 200).trim(),
    existing: Array.isArray(b.existing) ? b.existing.slice(0, 60).map((q) => str(q, 300)) : [],
  };
}

function parseQuestions(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a < 0 || b < a) return null;
  try { const v = JSON.parse(t.slice(a, b + 1)); return Array.isArray(v) ? v : null; } catch (e) { return null; }
}

// ---------- page drafting prompt (keep in step with buildDraftPrompt in scorm-studio.html) ----------
function buildDraftPrompt(req) {
  const modes = {
    expand: "Expand this into a fuller page, adding relevant detail while staying strictly accurate to what's already here. Do not invent facts, numbers, or policies not implied by the original text.",
    tighten: "Tighten this text: shorter and clearer, with no loss of meaning.",
    simplify: "Rewrite this in simpler, plainer language suitable for a general workplace audience.",
    polish: "Fix grammar, spelling and punctuation. Keep the meaning and tone exactly as written.",
  };
  return "You are helping write a page of a workplace e-learning course. " + (modes[req.mode] || modes.expand) + "\n\n" +
    "Rules:\n" +
    "- Plain British English.\n" +
    "- Output format: a blank line between paragraphs, lines starting with \"- \" for bullets, **double asterisks** for bold. No heading, title or extra commentary, just the replacement text.\n" +
    "- Do not add a sign-off, summary line, or anything not asked for above.\n" +
    (req.instruction ? "- Also: " + req.instruction + "\n" : "") +
    "\nReply with ONLY a JSON object, no other text, in this shape:\n" +
    '{"text":"..."}\n\n' +
    "COURSE TITLE: " + req.title + "\nPAGE HEADING: " + req.heading + "\n\nCURRENT TEXT:\n" + req.body;
}

function cleanDraftRequest(b) {
  if (!b || typeof b !== "object") return null;
  const str = (v, max) => String(v == null ? "" : v).slice(0, max);
  const body = str(b.body, MAX_CONTENT + 1000);
  if (body.trim().length < 10) return null;
  return {
    title: str(b.title, 200),
    heading: str(b.heading, 200),
    body: body.length > MAX_CONTENT ? body.slice(0, MAX_CONTENT) + "\n\n[content shortened]" : body,
    mode: ["expand", "tighten", "simplify", "polish"].includes(b.mode) ? b.mode : "expand",
    instruction: str(b.instruction, 200).trim(),
  };
}

function parseDraftText(text) {
  const t = String(text || "").replace(/```(?:json)?/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    const v = JSON.parse(t.slice(a, b + 1));
    return v && typeof v.text === "string" ? v.text : null;
  } catch (e) { return null; }
}

// ---------- the builder page ----------
// Serves LIVE_HTML_FILE (the auto-updated copy) when it exists, else falls back to HTML_FILE
// (the baseline copy next to server.js, kept current by the usual manual deploy). Re-read
// whenever the active file - or which file is active - changes, so neither an edit nor an
// auto-update needs a restart.
let pageCache = { path: null, mtime: 0, html: null };
function activeHtmlPath() {
  try { if (LIVE_HTML_FILE && fs.existsSync(LIVE_HTML_FILE)) return LIVE_HTML_FILE; } catch (e) {}
  return HTML_FILE;
}
function builderPage() {
  const path = activeHtmlPath();
  try {
    const st = fs.statSync(path);
    if (path !== pageCache.path || st.mtimeMs !== pageCache.mtime) {
      let html = fs.readFileSync(path, "utf8");
      // point the page's quiz generator at this server
      html = html.replace(/proxyUrl:\s*"[^"]*"/, "proxyUrl:   location.origin");
      pageCache = { path, mtime: st.mtimeMs, html };
    }
    return pageCache.html;
  } catch (e) {
    return null;
  }
}
function sendPage(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
  });
  res.end(html);
}

// ---------- auto-update: poll GitHub Releases for a newer scorm-studio.html ----------
function liveVersionFile() { return LIVE_HTML_FILE + ".version"; }
function currentLiveVersion() {
  try { return fs.readFileSync(liveVersionFile(), "utf8").trim(); } catch (e) { return ""; }
}
async function checkForUpdate() {
  if (!AUTO_UPDATE || !LIVE_HTML_FILE) return;
  try {
    const res = await fetch(UPDATE_API_BASE + "/repos/" + UPDATE_REPO + "/releases/latest", {
      headers: { "user-agent": "scorm-studio-auto-update", "accept": "application/vnd.github+json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.log(new Date().toISOString(), "update-check", "http " + res.status); return; }
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name === "scorm-studio.html");
    if (!rel.tag_name || !asset) { console.log(new Date().toISOString(), "update-check", "no scorm-studio.html asset on the latest release"); return; }
    if (currentLiveVersion() === rel.tag_name) return; // already up to date

    const dl = await fetch(asset.browser_download_url, {
      headers: { "user-agent": "scorm-studio-auto-update" },
      signal: AbortSignal.timeout(30000),
    });
    if (!dl.ok) { console.log(new Date().toISOString(), "update-check", "download failed, http " + dl.status); return; }
    const buf = Buffer.from(await dl.arrayBuffer());

    // Sanity checks before trusting it: looks like the right file, and matches the digest
    // GitHub itself reported for it (catches a corrupted or tampered-with download).
    if (buf.length < 50000 || buf.toString("utf8").indexOf("STUDIO_CONFIG") < 0) {
      console.log(new Date().toISOString(), "update-check", "downloaded file failed a sanity check, not applying " + rel.tag_name);
      return;
    }
    if (asset.digest) {
      const got = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
      if (got !== asset.digest) {
        console.log(new Date().toISOString(), "update-check", "digest did not match, not applying " + rel.tag_name);
        return;
      }
    }

    // Keep exactly one rollback copy, then swap the new one in atomically (write + rename,
    // so a request mid-update never sees a half-written file).
    try { if (fs.existsSync(LIVE_HTML_FILE)) fs.copyFileSync(LIVE_HTML_FILE, LIVE_HTML_FILE + ".bak"); } catch (e) {}
    const tmp = LIVE_HTML_FILE + ".tmp";
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, LIVE_HTML_FILE);
    fs.writeFileSync(liveVersionFile(), rel.tag_name);
    console.log(new Date().toISOString(), "update-check", "applied " + rel.tag_name + " (" + buf.length + " bytes)");
  } catch (e) {
    console.log(new Date().toISOString(), "update-check", "failed " + (e && e.name));
  }
}
if (AUTO_UPDATE && LIVE_HTML_FILE) {
  setTimeout(checkForUpdate, UPDATE_INITIAL_DELAY_MS).unref();
  setInterval(checkForUpdate, UPDATE_INTERVAL_MIN * 60000).unref();
}

// ---------- http ----------
function send(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  // cf-connecting-ip only exists behind the real Cloudflare Tunnel, so it's always trusted.
  // x-forwarded-for is set by any client calling directly, so it's only trusted with TRUST_PROXY=1
  // (set that only when another reverse proxy you control sits in front and sets it itself).
  const h = req.headers["cf-connecting-ip"] || (TRUST_PROXY ? (req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "");
  return h || req.socket.remoteAddress || "unknown";
}

async function callClaude(prompt) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

// Reads a request body up to MAX_BODY, then calls onDone(rawString). Over the cap, replies
// 413 and destroys the socket; a guard against re-entry keeps a late chunk from calling
// send() a second time on the same response (that threw ERR_HTTP_HEADERS_SENT and killed
// the process, before this guard existed).
function readBody(req, res, onDone) {
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on("data", (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) { aborted = true; send(res, 413, { code: "too_large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => { if (!aborted) onDone(Buffer.concat(chunks).toString("utf8")); });
}

// Calls Claude with `prompt`, parses its reply with `parseFn`, and responds; shared by
// /generate and /draft so the upstream-error handling only lives in one place.
async function askClaude(res, ip, prompt, parseFn, logNote, respond) {
  try {
    const started = Date.now();
    const { status, body } = await callClaude(prompt);
    if (status !== 200) {
      const msg = (body && body.error && body.error.message) || "";
      console.log(new Date().toISOString(), ip, "claude error", status, msg.slice(0, 120));
      if (/credit balance/i.test(msg)) return send(res, 402, { code: "no_credit" });
      if (status === 429 || status === 529) return send(res, 429, { code: "rate_limited", message: "Claude is busy right now. Try again in a minute." });
      return send(res, 502, { code: "upstream_error" });
    }
    const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const parsed = parseFn(text);
    if (parsed == null) return send(res, 502, { code: "invalid_json" });
    console.log(new Date().toISOString(), ip, "ok", logNote(parsed), (Date.now() - started) + "ms",
      "tokens in/out", body.usage ? body.usage.input_tokens + "/" + body.usage.output_tokens : "?");
    send(res, 200, respond(parsed));
  } catch (e) {
    console.log(new Date().toISOString(), ip, "failed", e && e.name);
    send(res, 504, { code: "upstream_error" });
  }
}

function handleGenerate(req, res, ip) {
  readBody(req, res, (raw) => {
    let parsed;
    try { parsed = cleanRequest(JSON.parse(raw)); } catch (e) { parsed = null; }
    if (!parsed) return send(res, 400, { code: "bad_request", message: "The course content was missing or too short." });
    const limited = checkLimits(ip);
    if (limited) return send(res, 429, { code: "rate_limited", message: limited });
    askClaude(res, ip, buildPrompt(parsed), parseQuestions,
      (qs) => qs.length + " questions",
      (qs) => ({ questions: qs }));
  });
}

function handleDraft(req, res, ip) {
  readBody(req, res, (raw) => {
    let parsed;
    try { parsed = cleanDraftRequest(JSON.parse(raw)); } catch (e) { parsed = null; }
    if (!parsed) return send(res, 400, { code: "bad_request", message: "The page text was missing or too short." });
    const limited = checkLimits(ip);
    if (limited) return send(res, 429, { code: "rate_limited", message: limited });
    askClaude(res, ip, buildDraftPrompt(parsed), parseDraftText,
      (t) => "draft " + t.length + " chars",
      (t) => ({ text: t }));
  });
}

const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const path = (req.url || "").split("?")[0];

  if (req.method === "OPTIONS") return send(res, 204, {});

  const isGet = req.method === "GET" || req.method === "HEAD";

  if (isGet && path === "/favicon.ico") { res.writeHead(204, { "Cache-Control": "public, max-age=86400" }); return res.end(); }

  if (isGet && (path === "/" || path === "/index.html" || path === "/scorm-studio.html")) {
    const html = builderPage();
    if (html && req.method === "HEAD") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(); }
    if (html) return sendPage(res, html);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("SCORM Studio quiz server is running, but scorm-studio.html was not found next to server.js.");
  }

  if (isGet && path === "/ping") return send(res, 200, { ok: true });

  if (req.method === "GET" && path === "/health") {
    if (tooManyBadTries(ip)) return send(res, 429, { code: "rate_limited", message: "Too many wrong access codes. Wait 15 minutes." });
    if (!codeMatches(req.headers["x-access-code"])) { noteBadTry(ip); return send(res, 401, { code: "bad_code" }); }
    return send(res, 200, { ok: true, model: MODEL, remainingToday: Math.max(0, LIMIT_PER_DAY - usedToday),
      autoUpdate: AUTO_UPDATE, liveVersion: AUTO_UPDATE ? (currentLiveVersion() || null) : undefined });
  }

  if (req.method === "POST" && (path === "/generate" || path === "/draft")) {
    if (tooManyBadTries(ip)) return send(res, 429, { code: "rate_limited", message: "Too many wrong access codes. Wait 15 minutes." });
    if (!codeMatches(req.headers["x-access-code"])) { noteBadTry(ip); return send(res, 401, { code: "bad_code" }); }
    return path === "/generate" ? handleGenerate(req, res, ip) : handleDraft(req, res, ip);
  }

  return send(res, 404, { code: "not_found" });
});

server.listen(PORT, () => {
  console.log("SCORM Studio quiz server on port " + PORT + " using " + MODEL +
    " (limits: " + LIMIT_PER_HOUR + "/hour per person, " + LIMIT_PER_DAY + "/day total)");
  console.log(builderPage() ? "Hosting the builder at / from " + activeHtmlPath() : "No builder page found at " + HTML_FILE + " (quiz service only)");
  if (AUTO_UPDATE && LIVE_HTML_FILE) console.log("Auto-update on: checking " + UPDATE_REPO + " every " + UPDATE_INTERVAL_MIN + " min, live copy at " + LIVE_HTML_FILE);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
