// Shared test helpers.
import http from "node:http";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC = join(ROOT, "src", "scorm-studio.html");
export const DIST = join(ROOT, "dist", "scorm-studio.html");
export const SERVER = join(ROOT, "server", "server.js");

/** The learner player's script, pulled out of the builder source. */
export function playerScript() {
  const src = readFileSync(SRC, "utf8");
  const m = src.match(/var PLAYER_JS = String\(function\(\)\{([\s\S]*?)\}\)\.replace\(\/\^function/);
  if (!m) throw new Error("PLAYER_JS not found in src/scorm-studio.html");
  return m[1];
}

/** A minimal course, with overrides. */
export function course(over = {}) {
  return {
    title: "Test course", description: "", author: "", scorm: "1.2", passMark: 80,
    accent: "#1F6F5C", showAnswers: true, allowRetry: true, shuffle: false,
    design: { cover: false },
    pages: [
      { id: "p0", heading: "A", blocks: [{ id: "b0", type: "text", body: "First page\n- point" }], check: null },
      { id: "p1", heading: "B", blocks: [{ id: "b1", type: "text", body: "Second page" }], check: null },
    ],
    quiz: [{ q: "Q1", options: ["no", "yes"], correct: 1, feedback: "" }],
    ...over,
  };
}

/** A fake SCORM API that records what the course writes. */
export function fakeLms(version, start = {}) {
  const data = { ...start };
  const calls = [];
  const v12 = {
    LMSInitialize: () => (calls.push("init"), "true"),
    LMSGetValue: (k) => data[k] || "",
    LMSSetValue: (k, v) => ((data[k] = String(v)), "true"),
    LMSCommit: () => "true",
    LMSFinish: () => (calls.push("finish"), "true"),
    LMSGetLastError: () => "0",
  };
  const v04 = {
    Initialize: () => (calls.push("init"), "true"),
    GetValue: (k) => data[k] || "",
    SetValue: (k, v) => ((data[k] = String(v)), "true"),
    Commit: () => "true",
    Terminate: () => (calls.push("finish"), "true"),
    GetLastError: () => "0",
  };
  return { api: version === "2004" ? v04 : v12, name: version === "2004" ? "API_1484_11" : "API", data, calls };
}

/** Fake Claude Messages API. Returns `questions` as the model's text. */
export function startMockClaude(questions, { key = "sk-ant-test" } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.headers["x-api-key"] !== key) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid x-api-key" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "```json\n" + JSON.stringify(questions) + "\n```" }], usage: { input_tokens: 100, output_tokens: 50 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

/** Start server.js with the given env. Resolves once it is listening. */
export function startQuizServer(env) {
  return new Promise((resolve, reject) => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), HTML_FILE: DIST, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (d) => {
      out += d;
      if (out.includes("quiz server on port")) resolve({ child, port, base: "http://127.0.0.1:" + port, log: () => out });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error("server exited " + code + ": " + out)));
    setTimeout(() => reject(new Error("server did not start: " + out)), 8000);
  });
}

/** Pull a top-level `function name(...){...}` declaration's full source out of a file. */
function extractFunctionSource(filePath, name) {
  const src = readFileSync(filePath, "utf8");
  const m = src.match(new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{"));
  if (!m) throw new Error(name + " not found in " + filePath);
  let i = m.index + m[0].length, depth = 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(m.index, i);
}

/** Get a callable `name` function out of a file, isolated from everything else in it. */
export function extractFunction(filePath, name) {
  const ctx = vm.createContext({});
  vm.runInContext(extractFunctionSource(filePath, name), ctx);
  return ctx[name];
}

export const SAMPLE_QUESTIONS = [
  { question: "What is tailgating?", options: ["Following someone through a door without using your pass", "A fire drill", "A pass colour", "Parking"], correct: 0, feedback: "Tailgating means following someone through.", page: 1 },
  { question: "Where do visitors go?", options: ["Reception", "The canteen", "Any door", "The car park"], correct: 0, feedback: "Reception signs visitors in.", page: 2 },
];
