// Full browser runs with Playwright Chromium: builder, export, the exported course, and the hosted quiz flow.
// Needs: npm install && npx playwright install chromium
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { ROOT, DIST, startMockClaude, startQuizServer, SAMPLE_QUESTIONS } from "./helpers.mjs";

let chromium, browser;
const OUT = join(ROOT, "test-output");
// 1x1 PNG and a small JPEG-like PNG are enough to exercise image handling
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

before(async () => {
  try {
    ({ chromium } = await import("playwright"));
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  } catch (e) {
    browser = null;
    console.log("Skipping browser tests: " + e.message.split("\n")[0]);
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "logo.png"), PNG);
  writeFileSync(join(OUT, "pic.png"), PNG);
});
after(async () => { await browser?.close(); });

async function freshBuilder(t) {
  if (!browser) return t.skip("Chromium not installed");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pathToFileURL(DIST).href);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return { ctx, page, errors };
}

async function exportZip(page, name) {
  await page.click("#btn-export");
  await page.waitForSelector("#ex-go");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#ex-go")]);
  const file = join(OUT, name);
  await dl.saveAs(file);
  return JSZip.loadAsync(readFileSync(file));
}

async function unpack(zip, dir) {
  rmSync(dir, { recursive: true, force: true });
  for (const n of Object.keys(zip.files)) {
    if (zip.files[n].dir) continue;
    mkdirSync(join(dir, n, ".."), { recursive: true });
    writeFileSync(join(dir, n), await zip.files[n].async("nodebuffer"));
  }
}

test("builder: design, logo, cover, image position and export", async (t) => {
  const b = await freshBuilder(t); if (!b) return;
  const { page, errors } = b;
  await page.click('[data-sel="design"]');
  await page.click('.theme[data-theme="deepblue"]');
  assert.equal(await page.inputValue("#d-accent"), "#0059a6");
  await page.setInputFiles("#d-logobox input[type=file]", join(OUT, "logo.png"));
  await page.check("#d-cover");
  await page.click("#nav-pages .nav-item >> nth=0");
  await page.setInputFiles("#pg-imgbox input[type=file]", join(OUT, "pic.png"));
  await page.selectOption("#pg-imgpos", "left");
  const zip = await exportZip(page, "designed.zip");
  const names = Object.keys(zip.files);
  for (const f of ["index.html", "imsmanifest.xml", "media/logo.png", "media/page-1.png"]) assert.ok(names.includes(f), f + " in zip");
  const manifest = await zip.file("imsmanifest.xml").async("string");
  assert.match(manifest, /<schemaversion>1.2<\/schemaversion>/);
  assert.match(manifest, /media\/logo.png/);
  await page.screenshot({ path: join(OUT, "builder-design.png") });
  assert.deepEqual(errors, []);
  await b.ctx.close();
});

test("exported course: cover, knowledge check and completion in a fake LMS", async (t) => {
  const b = await freshBuilder(t); if (!b) return;
  const { page, ctx } = b;
  await page.click('[data-sel="design"]');
  await page.check("#d-cover");
  await page.click("#nav-pages .nav-item >> nth=0");
  await page.check("#kc-on");
  await page.fill("#kc-list textarea", "What does your pass show?");
  await page.fill("#kc-list .opt >> nth=0 >> input[type=text]", "That you belong here");
  await page.fill("#kc-list .opt >> nth=1 >> input[type=text]", "Your shift times");
  const zip = await exportZip(page, "checks.zip");
  const dir = join(OUT, "checks");
  await unpack(zip, dir);

  const lp = await ctx.newPage();
  const errs = [];
  lp.on("pageerror", (e) => errs.push(e.message));
  await lp.addInitScript(() => {
    const s = {};
    window.API = { LMSInitialize: () => "true", LMSGetValue: (k) => s[k] || "", LMSSetValue: (k, v) => { s[k] = String(v); return "true"; }, LMSCommit: () => "true", LMSFinish: () => "true" };
    window.__lms = s;
  });
  await lp.goto(pathToFileURL(join(dir, "index.html")).href);
  await lp.click("#start");
  await lp.click("#next");
  assert.match(await lp.textContent(".count"), /Knowledge check/);
  await lp.check('input[name="k0"][value="1"]'); await lp.click("#kcheck");
  await lp.click("#kretry"); await lp.check('input[name="k0"][value="0"]'); await lp.click("#kcheck");
  await lp.click("#kgo");
  assert.equal(await lp.textContent("h2"), "Wearing your pass");
  await lp.setViewportSize({ width: 390, height: 844 });
  assert.equal(await lp.evaluate(() => document.documentElement.scrollWidth), 390, "no sideways scroll on phones");
  const sd = JSON.parse(await lp.evaluate(() => window.__lms["cmi.suspend_data"]));
  assert.deepEqual(sd.k, [0]);
  assert.deepEqual(errs, []);
  await ctx.close();
});

test("hosted: first visit asks for the access code, then generates questions", async (t) => {
  if (!browser) return t.skip("Chromium not installed");
  const mock = await startMockClaude(SAMPLE_QUESTIONS);
  const srv = await startQuizServer({ ANTHROPIC_API_KEY: "sk-ant-test", ACCESS_CODE: "team-code-123", API_URL: `http://127.0.0.1:${mock.port}/v1/messages` });
  try {
    const page = await browser.newPage();
    await page.goto(srv.base + "/");
    await page.click('[data-sel="quiz"]');
    await page.waitForFunction(() => !/checking/.test(document.getElementById("gen-via")?.textContent || "checking"));
    assert.equal(await page.textContent("#gen-via"), "quiz server");
    await page.click("#gen-go");
    await page.waitForSelector("#ai-h");
    assert.equal(await page.inputValue("#ai-url"), srv.base);
    await page.fill("#ai-code", "team-code-123");
    await page.click("#ai-test");
    await page.waitForFunction(() => /Connected/.test(document.getElementById("ai-status").textContent));
    await page.click("#ai-save");
    await page.click("#gen-go");
    await page.waitForSelector(".gq");
    assert.equal(await page.locator(".gq").count(), 2);
    await page.click("#gen-add");
    assert.equal(await page.locator("#qlist .q").count(), 5, "3 example questions + 2 added");
    await page.close();
  } finally {
    srv.child.kill(); mock.server.close();
  }
});
