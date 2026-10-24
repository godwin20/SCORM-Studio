// The quiz server, against a fake Claude API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockClaude, startQuizServer, SAMPLE_QUESTIONS } from "./helpers.mjs";

const CODE = "team-code-123";
let mock, srv;

before(async () => {
  mock = await startMockClaude(SAMPLE_QUESTIONS);
  srv = await startQuizServer({
    ANTHROPIC_API_KEY: "sk-ant-test", ACCESS_CODE: CODE,
    API_URL: `http://127.0.0.1:${mock.port}/v1/messages`, LIMIT_PER_HOUR: "4",
  });
});
after(() => { srv?.child.kill(); mock?.server.close(); });

const post = (body, code = CODE) => fetch(srv.base + "/generate", {
  method: "POST", headers: { "Content-Type": "application/json", "X-Access-Code": code }, body: JSON.stringify(body),
});
const content = "Tailgating is when someone follows you through a controlled door without using their own pass. Report it.";

test("hosts the builder page and points it at itself", async () => {
  const r = await fetch(srv.base + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /proxyUrl:\s+location\.origin/);
  assert.equal((await fetch(srv.base + "/", { method: "HEAD" })).status, 200);
  assert.equal((await fetch(srv.base + "/favicon.ico")).status, 204);
});

test("/ping needs no code; /health checks it", async () => {
  assert.deepEqual(await (await fetch(srv.base + "/ping")).json(), { ok: true });
  assert.equal((await fetch(srv.base + "/health", { headers: { "X-Access-Code": "nope-nope" } })).status, 401);
  const h = await (await fetch(srv.base + "/health", { headers: { "X-Access-Code": CODE } })).json();
  assert.equal(h.ok, true);
});

test("generates questions and builds the prompt itself", async () => {
  const r = await post({ title: "T", content, count: 2, level: "hard", focus: "doors" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.questions.length, 2);
  const sent = mock.seen.at(-1).body.messages[0].content;
  assert.match(sent, /Write exactly 2 multiple-choice questions/);
  assert.match(sent, /Concentrate on: doors/);
  assert.match(sent, /Tailgating is when someone/);
  assert.equal(mock.seen.at(-1).headers["x-api-key"], "sk-ant-test");
});

test("rejects bad codes, short content and unknown routes", async () => {
  assert.equal((await post({ content }, "wrong-code")).status, 401);
  assert.equal((await post({ content: "hi" })).status, 400);
  assert.equal((await fetch(srv.base + "/etc/passwd")).status, 404);
});

test("CORS preflight allows the access code header", async () => {
  const r = await fetch(srv.base + "/generate", { method: "OPTIONS" });
  assert.match(r.headers.get("access-control-allow-headers"), /X-Access-Code/);
});

test("per-person hourly limit applies", async () => {
  // limit is 4; one request already used above
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post({ title: "T", content, count: 1 })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test("refuses to start without settings or with a short code", async () => {
  await assert.rejects(startQuizServer({ ANTHROPIC_API_KEY: "", ACCESS_CODE: "" }), /Missing settings/);
  await assert.rejects(startQuizServer({ ANTHROPIC_API_KEY: "sk-ant-x", ACCESS_CODE: "short" }), /too short/);
});

test("never logs course content", () => {
  assert.doesNotMatch(srv.log(), /Tailgating is when/);
});
