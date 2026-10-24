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
// Web addresses:
//   GET  /          the SCORM Studio builder (if scorm-studio.html is present)
//   GET  /ping      "is it running" check, no code needed
//   GET  /health    checks the access code, shows requests left today
//   POST /generate  writes quiz questions (needs the access code)

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
const MAX_BODY = 600 * 1024;       // biggest request accepted (course text)
const MAX_CONTENT = 150000;        // characters of course text sent to Claude

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

// ---------- the builder page ----------
// Re-read when the file changes, so replacing scorm-studio.html needs no restart.
let pageCache = { mtime: 0, html: null };
function builderPage() {
  try {
    const st = fs.statSync(HTML_FILE);
    if (st.mtimeMs !== pageCache.mtime) {
      let html = fs.readFileSync(HTML_FILE, "utf8");
      // point the page's quiz generator at this server
      html = html.replace(/proxyUrl:\s*"[^"]*"/, "proxyUrl:   location.origin");
      pageCache = { mtime: st.mtimeMs, html };
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
  // behind Cloudflare Tunnel or a reverse proxy the real address is in a header
  const h = req.headers["cf-connecting-ip"] || (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
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
    return send(res, 200, { ok: true, model: MODEL, remainingToday: Math.max(0, LIMIT_PER_DAY - usedToday) });
  }

  if (req.method !== "POST" || path !== "/generate") return send(res, 404, { code: "not_found" });

  if (tooManyBadTries(ip)) return send(res, 429, { code: "rate_limited", message: "Too many wrong access codes. Wait 15 minutes." });
  if (!codeMatches(req.headers["x-access-code"])) { noteBadTry(ip); return send(res, 401, { code: "bad_code" }); }

  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { aborted = true; send(res, 413, { code: "too_large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (aborted) return;
    let parsed;
    try { parsed = cleanRequest(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { parsed = null; }
    if (!parsed) return send(res, 400, { code: "bad_request", message: "The course content was missing or too short." });

    const limited = checkLimits(ip);
    if (limited) return send(res, 429, { code: "rate_limited", message: limited });

    try {
      const started = Date.now();
      const { status, body } = await callClaude(buildPrompt(parsed));
      if (status !== 200) {
        const msg = (body && body.error && body.error.message) || "";
        console.log(new Date().toISOString(), ip, "claude error", status, msg.slice(0, 120));
        if (/credit balance/i.test(msg)) return send(res, 402, { code: "no_credit" });
        if (status === 429 || status === 529) return send(res, 429, { code: "rate_limited", message: "Claude is busy right now. Try again in a minute." });
        return send(res, 502, { code: "upstream_error" });
      }
      const text = (body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      const questions = parseQuestions(text);
      if (!questions) return send(res, 502, { code: "invalid_json" });
      console.log(new Date().toISOString(), ip, "ok", questions.length + " questions", (Date.now() - started) + "ms",
        "tokens in/out", body.usage ? body.usage.input_tokens + "/" + body.usage.output_tokens : "?");
      send(res, 200, { questions });
    } catch (e) {
      console.log(new Date().toISOString(), ip, "failed", e && e.name);
      send(res, 504, { code: "upstream_error" });
    }
  });
});

server.listen(PORT, () => {
  console.log("SCORM Studio quiz server on port " + PORT + " using " + MODEL +
    " (limits: " + LIMIT_PER_HOUR + "/hour per person, " + LIMIT_PER_DAY + "/day total)");
  console.log(builderPage() ? "Hosting the builder at / from " + HTML_FILE : "No builder page found at " + HTML_FILE + " (quiz service only)");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
