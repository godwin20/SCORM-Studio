// The quiz server, against a fake Claude API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockClaude, startQuizServer, extractFunction, SRC, SERVER, SAMPLE_QUESTIONS } from "./helpers.mjs";

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
const postDraft = (body, code = CODE) => fetch(srv.base + "/draft", {
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

test("drafts page text and builds the prompt itself", async () => {
  const draftMock = await startMockClaude({ text: "A fuller paragraph about tailgating, written for the course." });
  const draftSrv = await startQuizServer({
    ANTHROPIC_API_KEY: "sk-ant-test", ACCESS_CODE: CODE,
    API_URL: `http://127.0.0.1:${draftMock.port}/v1/messages`,
  });
  try {
    const r = await fetch(draftSrv.base + "/draft", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Access-Code": CODE },
      body: JSON.stringify({ title: "T", heading: "Doors", body: content, mode: "expand", instruction: "mention reporting it" }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.text, "A fuller paragraph about tailgating, written for the course.");
    const sent = draftMock.seen.at(-1).body.messages[0].content;
    assert.match(sent, /Expand this into a fuller page/);
    assert.match(sent, /Also: mention reporting it/);
    assert.match(sent, /Tailgating is when someone/);
  } finally {
    draftSrv.child.kill(); draftMock.server.close();
  }
});

test("/draft rejects bad codes and too-short body, same as /generate", async () => {
  assert.equal((await postDraft({ body: content }, "wrong-code")).status, 401);
  assert.equal((await postDraft({ body: "hi" })).status, 400);
});

test("/draft shares the same per-person limit as /generate", async () => {
  const sharedMock = await startMockClaude(SAMPLE_QUESTIONS);
  const sharedSrv = await startQuizServer({
    ANTHROPIC_API_KEY: "sk-ant-test", ACCESS_CODE: CODE,
    API_URL: `http://127.0.0.1:${sharedMock.port}/v1/messages`, LIMIT_PER_HOUR: "1",
  });
  try {
    const postTo = (path, body) => fetch(sharedSrv.base + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Access-Code": CODE }, body: JSON.stringify(body),
    });
    assert.equal((await postTo("/generate", { title: "T", content, count: 1 })).status, 200);
    assert.equal((await postTo("/draft", { title: "T", heading: "H", body: content, mode: "expand" })).status, 429);
  } finally {
    sharedSrv.child.kill(); sharedMock.server.close();
  }
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

test("a large body delivered as many TCP chunks does not crash the server", async () => {
  // Regression guard for a bug where a chunk arriving after the body already went over
  // MAX_BODY called send() a second time on the same response (res.writeHead twice),
  // which throws ERR_HTTP_HEADERS_SENT uncaught and kills the process. Whether any given
  // run actually lands two "data" events on the request after the first abort is a timing
  // race this test can't force deterministically — so it's a smoke test (server keeps
  // serving afterwards), not direct proof of the race, and relies on the code guarding
  // against re-entry (`if (aborted) return;`) rather than on hitting the exact timing.
  const net = await import("node:net");
  const bodySize = 8 * 1024 * 1024; // 8 MB, far over the 600 KB cap
  await new Promise((resolve) => {
    const socket = net.connect(srv.port, "127.0.0.1", () => {
      socket.write(
        "POST /generate HTTP/1.1\r\nHost: localhost\r\nX-Access-Code: " + CODE +
        "\r\nContent-Type: application/json\r\nContent-Length: " + bodySize +
        "\r\nConnection: close\r\n\r\n"
      );
      socket.write(Buffer.alloc(bodySize, "a"));
    });
    socket.on("error", () => {}); // the server destroying the socket mid-write is expected
    socket.on("close", resolve);
    setTimeout(resolve, 4000);
  });
  assert.equal((await fetch(srv.base + "/ping")).status, 200);
});

test("x-forwarded-for is ignored unless TRUST_PROXY is set, so it can't be used to dodge the per-person limit", async () => {
  const srv2 = await startQuizServer({
    ANTHROPIC_API_KEY: "sk-ant-test", ACCESS_CODE: CODE,
    API_URL: `http://127.0.0.1:${mock.port}/v1/messages`, LIMIT_PER_HOUR: "2",
  });
  try {
    const postWithXff = (xff) => fetch(srv2.base + "/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Access-Code": CODE, "X-Forwarded-For": xff },
      body: JSON.stringify({ title: "T", content, count: 1 }),
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await postWithXff(`10.0.0.${i}`)).status);
    // all 3 requests come from this test's real loopback socket; a different claimed
    // x-forwarded-for on each must NOT grant each one its own rate-limit bucket.
    assert.deepEqual(statuses, [200, 200, 429]);
  } finally {
    srv2.child.kill();
  }
});

test("buildPrompt in server.js and scorm-studio.html haven't drifted apart", () => {
  // CLAUDE.md flags this as a manually-kept-in-step duplicate. The two copies are written
  // in different JS styles (const/arrow in server.js, var/function in the browser file), so
  // this compares behaviour, not source text.
  const serverBuildPrompt = extractFunction(SERVER, "buildPrompt");
  const htmlBuildPrompt = extractFunction(SRC, "buildPrompt");
  const reqs = [
    { title: "Door security", content, count: 3, level: "hard", focus: "tailgating", existing: ["Old question?"] },
    { title: "Plain", content, count: 1, level: "easy" },
  ];
  for (const req of reqs) assert.equal(serverBuildPrompt(req), htmlBuildPrompt(req));
});

test("buildDraftPrompt in server.js and scorm-studio.html haven't drifted apart", () => {
  const serverBuildDraftPrompt = extractFunction(SERVER, "buildDraftPrompt");
  const htmlBuildDraftPrompt = extractFunction(SRC, "buildDraftPrompt");
  const reqs = [
    { title: "Door security", heading: "Tailgating", body: content, mode: "expand", instruction: "mention reporting it" },
    { title: "Plain", heading: "Intro", body: content, mode: "polish", instruction: "" },
  ];
  for (const req of reqs) assert.equal(serverBuildDraftPrompt(req), htmlBuildDraftPrompt(req));
});
