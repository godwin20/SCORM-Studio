// The learner player (what runs inside Bridge), tested against a fake LMS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { playerScript, course, fakeLms } from "./helpers.mjs";

const SCRIPT = playerScript();

function play(data, lms) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const dom = new JSDOM(`<div id="app"></div><script type="application/json" id="course">${json}</script>`, { runScripts: "outside-only" });
  if (lms) dom.window[lms.name] = lms.api;
  dom.window.eval(SCRIPT);
  const d = dom.window.document;
  return {
    dom, d,
    click: (id) => { const b = d.getElementById(id); assert.ok(b, "button #" + id + " should exist"); b.click(); },
    pick: (name, value) => {
      const r = d.querySelector(`input[name="${name}"][value="${value}"]`);
      assert.ok(r, `answer ${name}=${value} should exist`);
      r.checked = true;
      r.dispatchEvent(new dom.window.Event("change"));
    },
    heading: () => d.querySelector("h2")?.textContent,
  };
}

test("SCORM 1.2: pages, quiz pass, score and finish are reported", () => {
  const lms = fakeLms("1.2");
  const p = play(course(), lms);
  assert.equal(p.heading(), "A");
  p.click("next"); p.click("next"); // -> quiz
  p.pick("q0", 1);
  p.click("submit");
  assert.equal(lms.data["cmi.core.lesson_status"], "passed");
  assert.equal(lms.data["cmi.core.score.raw"], "100");
  p.click("finish"); p.click("close");
  assert.ok(lms.calls.includes("finish"));
  assert.equal(lms.data["cmi.core.exit"], "");
  assert.match(lms.data["cmi.core.session_time"], /^\d{4}:\d{2}:\d{2}$/);
});

test("SCORM 1.2: failing the quiz reports failed", () => {
  const lms = fakeLms("1.2");
  const p = play(course(), lms);
  p.click("next"); p.click("next");
  p.pick("q0", 0);
  p.click("submit");
  assert.equal(lms.data["cmi.core.lesson_status"], "failed");
  assert.ok(p.d.getElementById("retry"), "retry offered when allowed");
});

test("No quiz: completed on the last page", () => {
  const lms = fakeLms("1.2");
  const p = play(course({ quiz: [] }), lms);
  p.click("next"); p.click("next");
  assert.equal(lms.data["cmi.core.lesson_status"], "completed");
});

test("SCORM 2004: required video blocks Next until it ends; embeds render", () => {
  const lms = fakeLms("2004");
  const data = course({
    scorm: "2004", quiz: [],
    pages: [
      { ...course().pages[0], video: { kind: "file", src: "media/v.mp4", type: "video/mp4", required: true } },
      { ...course().pages[1], video: { kind: "embed", src: "https://www.youtube-nocookie.com/embed/abcdefghijk", site: "YouTube", url: "u" } },
    ],
  });
  const p = play(data, lms);
  assert.equal(p.d.getElementById("next").disabled, true);
  p.d.getElementById("vid").dispatchEvent(new p.dom.window.Event("ended"));
  assert.equal(p.d.getElementById("next").disabled, false);
  p.click("next");
  assert.ok(p.d.querySelector(".vid.embed iframe"));
  p.click("next"); p.click("close");
  assert.equal(lms.data["cmi.completion_status"], "completed");
  assert.equal(lms.data["cmi.success_status"], "passed");
  assert.match(lms.data["cmi.session_time"], /^PT\d+S$/);
  assert.deepEqual(JSON.parse(lms.data["cmi.suspend_data"]).w, [0]);
});

test("Knowledge check: must-pass blocks until right, then is skipped on return", () => {
  const lms = fakeLms("1.2");
  const pages = course().pages;
  pages[0].check = { mustPass: true, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "Yes is right." }] };
  const p = play(course({ pages, quiz: [] }), lms);
  p.click("next");
  assert.match(p.d.querySelector(".count").textContent, /Knowledge check/);
  p.pick("k0", 0); p.click("kcheck");
  assert.match(p.d.querySelector(".verdict").textContent, /try again/);
  assert.ok(p.d.getElementById("kretry"));
  p.click("kretry"); p.pick("k0", 1); p.click("kcheck");
  assert.match(p.d.querySelector(".verdict").textContent, /Correct/);
  p.click("kgo");
  assert.equal(p.heading(), "B");
  p.click("back"); p.click("next");
  assert.equal(p.heading(), "B", "passed check is not repeated");
  assert.deepEqual(JSON.parse(lms.data["cmi.suspend_data"]).k, [0]);
});

test("Knowledge check: practice mode lets learners carry on after a wrong answer", () => {
  const pages = course().pages;
  pages[0].check = { mustPass: false, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "" }] };
  const p = play(course({ pages }), fakeLms("1.2"));
  p.click("next"); p.pick("k0", 0); p.click("kcheck");
  assert.ok(p.d.getElementById("kgo"), "Continue offered");
  assert.match(p.d.querySelector(".verdict.no").textContent, /highlighted in green/);
});

test("Resume: returns to the saved page and keeps passed checks", () => {
  const lms = fakeLms("1.2", { "cmi.core.lesson_location": "1", "cmi.suspend_data": JSON.stringify({ v: [0, 1], w: [], k: [0], f: 0, s: null }) });
  const p = play(course(), lms);
  assert.equal(p.heading(), "B");
});

test("Cover page shows first when switched on", () => {
  const p = play(course({ design: { cover: true, coverButton: "Begin" } }), fakeLms("1.2"));
  assert.equal(p.d.getElementById("start").textContent, "Begin");
  p.click("start");
  assert.equal(p.heading(), "A");
});

test("Works with no LMS at all (preview / opened from disk)", () => {
  const p = play(course({ quiz: [] }), null);
  p.click("next"); p.click("next");
  assert.match(p.d.body.textContent, /reached the end/);
});
