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
    matchPick: (fieldsetIndex, leftIndex, pairIndex) => {
      const fs = d.querySelectorAll("fieldset.q")[fieldsetIndex];
      assert.ok(fs, `fieldset ${fieldsetIndex} should exist`);
      const l = fs.querySelector(`.match-item[data-side="l"][data-i="${leftIndex}"]`);
      assert.ok(l, `left match item ${leftIndex} should exist`);
      const r = fs.querySelector(`.match-item[data-side="r"][data-i="${pairIndex}"]`);
      assert.ok(r, `right match item ${pairIndex} should exist`);
      l.click();
      r.click();
    },
    fillIn: (fieldsetIndex, blankIndex, text) => {
      const fs = d.querySelectorAll("fieldset.q")[fieldsetIndex];
      assert.ok(fs, `fieldset ${fieldsetIndex} should exist`);
      const inp = fs.querySelector(`input[data-blank="${blankIndex}"]`);
      assert.ok(inp, `blank ${blankIndex} should exist`);
      inp.value = text;
      inp.dispatchEvent(new dom.window.Event("input"));
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

test("Page blocks: text, image, quote and key point all render, in order", () => {
  const pages = [
    {
      id: "p0", heading: "Mixed page", check: null,
      blocks: [
        { id: "b0", type: "text", body: "Intro paragraph." },
        { id: "b1", type: "image", image: "data:image/png;base64,AA==", imageAlt: "A diagram", imagePos: "standard" },
        { id: "b2", type: "quote", text: "Safety first.", cite: "Site policy" },
        { id: "b3", type: "keypoint", text: "Always badge in.", tone: "warning" },
      ],
    },
  ];
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  const card = p.d.querySelector(".card");
  assert.match(card.innerHTML, /Intro paragraph/);
  const img = card.querySelector("img.hero");
  assert.ok(img, "image block rendered with the hero class");
  assert.equal(img.getAttribute("alt"), "A diagram");
  const quote = card.querySelector("blockquote.quote");
  assert.ok(quote, "quote block rendered");
  assert.match(quote.textContent, /Safety first/);
  assert.match(quote.querySelector("cite").textContent, /Site policy/);
  const key = card.querySelector(".key.k-warning");
  assert.ok(key, "key point block rendered with its tone class");
  assert.match(key.textContent, /Always badge in/);
  // order in the DOM should match block order
  const order = [...card.querySelectorAll("p, img, blockquote, .key")].map((n) => n.className || n.tagName);
  assert.ok(order.indexOf("hero") < order.indexOf("quote"), "image comes before quote");
  assert.ok(order.findIndex((c) => c === "quote") < order.findIndex((c) => /\bkey\b/.test(c)), "quote comes before key point");
});

test("Page blocks: accordion and numbered steps render, filtering out empty items", () => {
  const pages = [
    {
      id: "p0", heading: "Mixed page", check: null,
      blocks: [
        { id: "b0", type: "accordion", items: [
          { title: "What is tailgating?", body: "Following someone through a door without using your own pass." },
          { title: "", body: "" },
          { title: "What to do", body: "Report it the same day." },
        ] },
        { id: "b1", type: "steps", items: [
          { title: "Badge in", body: "Use your own pass at the reader." },
          { title: "Check the light", body: "Green means you're through." },
        ] },
      ],
    },
  ];
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  const card = p.d.querySelector(".card");

  const details = card.querySelectorAll(".accordion details");
  assert.equal(details.length, 2, "the blank item is filtered out");
  assert.match(details[0].querySelector("summary").textContent, /What is tailgating/);
  assert.match(details[0].querySelector(".acc-body").textContent, /Following someone/);
  assert.match(details[1].querySelector("summary").textContent, /What to do/);

  const steps = card.querySelectorAll(".steps li");
  assert.equal(steps.length, 2);
  assert.equal(steps[0].querySelector(".step-n").textContent, "1");
  assert.match(steps[0].querySelector("h3").textContent, /Badge in/);
  assert.equal(steps[1].querySelector(".step-n").textContent, "2");
  assert.match(steps[1].querySelector(".step-body").textContent, /Green means/);
});

test("Labelled image: clicking a pin toggles a speech-bubble panel, filtering out empty pins", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const pages = [
    {
      id: "p0", heading: "A pass, labelled", check: null,
      blocks: [
        { id: "b0", type: "labels", image: PNG, imageAlt: "A security pass", points: [
          { x: 20, y: 30, title: "Photo", body: "Confirms it's your pass, not someone else's." },
          { x: 70, y: 60, title: "", body: "This is the chip that unlocks doors." },
          { x: 50, y: 50, title: "", body: "" },
        ] },
      ],
    },
  ];
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  const card = p.d.querySelector(".card");

  const pins = card.querySelectorAll(".lbl-pin");
  assert.equal(pins.length, 2, "the empty pin is filtered out");
  const bubble = card.querySelector(".lbl-bubble");
  assert.equal(bubble.hidden, true, "closed until a pin is clicked");

  pins[0].click();
  assert.equal(bubble.hidden, false);
  assert.equal(bubble.querySelector("h4").textContent, "Photo");
  assert.equal(bubble.querySelector("h4").hidden, false);
  assert.match(bubble.querySelector(".lbl-body").textContent, /Confirms it's your pass/);
  assert.equal(pins[0].getAttribute("aria-expanded"), "true");

  pins[0].click(); // clicking the same pin again closes it
  assert.equal(bubble.hidden, true);
  assert.equal(pins[0].getAttribute("aria-expanded"), "false");

  pins[1].click(); // a pin with no title hides the heading, still shows the body
  assert.equal(bubble.hidden, false);
  assert.equal(bubble.querySelector("h4").hidden, true, "no title to show for this pin");
  assert.match(bubble.querySelector(".lbl-body").textContent, /chip that unlocks doors/);
  assert.equal(pins[0].getAttribute("aria-expanded"), "false");
  assert.equal(pins[1].getAttribute("aria-expanded"), "true");
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
      { ...course().pages[0], blocks: [{ id: "b0", type: "video", video: { kind: "file", src: "media/v.mp4", type: "video/mp4", required: true } }] },
      { ...course().pages[1], blocks: [{ id: "b1", type: "video", video: { kind: "embed", src: "https://www.youtube-nocookie.com/embed/abcdefghijk", site: "YouTube", url: "u" } }] },
    ],
  });
  const p = play(data, lms);
  assert.equal(p.d.getElementById("next").disabled, true);
  p.d.getElementById("vid-0").dispatchEvent(new p.dom.window.Event("ended"));
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

test("Branching: a failed practice check jumps to the configured remedial page", () => {
  const pages = course().pages;
  pages[0].id = "p0"; pages[1].id = "p1";
  pages.push({ id: "p2", heading: "Remedial", blocks: [{ id: "b2", type: "text", body: "Review this." }], check: null });
  pages[0].check = { mustPass: false, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "" }], branch: { pass: null, fail: "p2" } };
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  p.click("next"); // page A -> its check
  p.pick("k0", 0); // wrong answer
  p.click("kcheck");
  p.click("kgo");
  assert.equal(p.heading(), "Remedial", "wrong answer branched to the remedial page, not the normal next page");
});

test("Branching: a passed check can jump ahead, skipping the normal next page", () => {
  const pages = course().pages;
  pages[0].id = "p0"; pages[1].id = "p1";
  pages.push({ id: "p2", heading: "Skip target", blocks: [{ id: "b2", type: "text", body: "You knew it already." }], check: null });
  pages[0].check = { mustPass: false, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "" }], branch: { pass: "p2", fail: null } };
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  p.click("next");
  p.pick("k0", 1); // right answer
  p.click("kcheck");
  p.click("kgo");
  assert.equal(p.heading(), "Skip target", "correct answer branched ahead past page B");
});

test("Branching: no branch set keeps the normal next-page behaviour", () => {
  const pages = course().pages;
  pages[0].id = "p0"; pages[1].id = "p1";
  pages[0].check = { mustPass: false, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "" }], branch: { pass: null, fail: null } };
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  p.click("next");
  p.pick("k0", 0);
  p.click("kcheck");
  p.click("kgo");
  assert.equal(p.heading(), "B", "no branch configured falls through to the normal next page");
});

test("Hotspot question: choosing the correct area (via the accessible button list) grades correct", () => {
  const quiz = [{
    type: "hotspot", q: "Click the fire exit", image: "data:image/png;base64,AA==", imageAlt: "Office floor plan",
    zones: [{ x: 10, y: 10, w: 20, h: 20, correct: true }, { x: 60, y: 60, w: 20, h: 20, correct: false }],
    feedback: "",
  }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  const fs = p.d.querySelectorAll("fieldset.q")[0];
  fs.querySelector('.hs-alt button[data-zone="0"]').click();
  p.click("submit");
  assert.equal(p.d.querySelector(".score").textContent, "100%");
});

test("Hotspot question: choosing a non-correct area grades incorrect", () => {
  const quiz = [{
    type: "hotspot", q: "Click the fire exit", image: "data:image/png;base64,AA==", imageAlt: "",
    zones: [{ x: 10, y: 10, w: 20, h: 20, correct: true }, { x: 60, y: 60, w: 20, h: 20, correct: false }],
    feedback: "",
  }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  const fs = p.d.querySelectorAll("fieldset.q")[0];
  fs.querySelector('.hs-alt button[data-zone="1"]').click();
  p.click("submit");
  assert.equal(p.d.querySelector(".score").textContent, "0%");
});

test("Knowledge check: practice mode lets learners carry on after a wrong answer", () => {
  const pages = course().pages;
  pages[0].check = { mustPass: false, questions: [{ q: "Pick yes", options: ["no", "yes"], correct: 1, feedback: "" }] };
  const p = play(course({ pages }), fakeLms("1.2"));
  p.click("next"); p.pick("k0", 0); p.click("kcheck");
  assert.ok(p.d.getElementById("kgo"), "Continue offered");
  assert.match(p.d.querySelector(".verdict.no").textContent, /highlighted in green/);
});

test("Matching question: graded in the final quiz", () => {
  const quiz = [{ type: "match", q: "Match the term", pairs: [{ left: "Tailgating", right: "Following through a door" }, { left: "Phishing", right: "A fake email" }], feedback: "" }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  p.matchPick(0, 0, 0); p.matchPick(0, 1, 1);
  p.click("submit");
  assert.equal(p.d.querySelector(".score").textContent, "100%");
});

test("Matching question: a swapped pair is marked wrong", () => {
  const quiz = [{ type: "match", q: "Match the term", pairs: [{ left: "Tailgating", right: "Following through a door" }, { left: "Phishing", right: "A fake email" }], feedback: "" }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  p.matchPick(0, 0, 1); p.matchPick(0, 1, 0);
  p.click("submit");
  assert.equal(p.d.querySelector(".score").textContent, "0%");
});

test("Matching question: reconnecting a right item to a different left item clears its old pairing", () => {
  const quiz = [{ type: "match", q: "Match the term", pairs: [{ left: "Tailgating", right: "Following through a door" }, { left: "Phishing", right: "A fake email" }], feedback: "" }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  const fs = p.d.querySelectorAll("fieldset.q")[0];
  // both left items point at pair 0's right item; the second click should steal it from the first
  p.matchPick(0, 0, 0);
  p.matchPick(0, 1, 0);
  const left0 = fs.querySelector('.match-item[data-side="l"][data-i="0"]');
  const left1 = fs.querySelector('.match-item[data-side="l"][data-i="1"]');
  assert.ok(!left0.classList.contains("connected"), "left 0 lost its connection");
  assert.ok(left1.classList.contains("connected"), "left 1 now holds the connection");
  // completing the correct pairing should still grade 100%
  p.matchPick(0, 0, 0); p.matchPick(0, 1, 1);
  p.click("submit");
  assert.equal(p.d.querySelector(".score").textContent, "100%");
});

test("Matching question: clicking an armed left item again cancels arming without connecting", () => {
  const quiz = [{ type: "match", q: "Match the term", pairs: [{ left: "Tailgating", right: "Following through a door" }, { left: "Phishing", right: "A fake email" }], feedback: "" }];
  const p = play(course({ quiz }), fakeLms("1.2"));
  p.click("next"); p.click("next");
  const fs = p.d.querySelectorAll("fieldset.q")[0];
  const left0 = fs.querySelector('.match-item[data-side="l"][data-i="0"]');
  left0.click();
  assert.ok(left0.classList.contains("armed"));
  left0.click();
  assert.ok(!left0.classList.contains("armed"));
  const right0 = fs.querySelector('.match-item[data-side="r"][data-i="0"]');
  right0.click();
  assert.ok(!left0.classList.contains("connected"), "clicking right with nothing armed does nothing");
});

test("Fill-in-the-blank: must-pass knowledge check accepts a case-insensitive match, then locks on retry", () => {
  const pages = course().pages;
  pages[0].check = { mustPass: true, questions: [{ type: "fill", q: "Complete it", text: "The capital of France is ___.", answers: ["Paris"], feedback: "" }] };
  const p = play(course({ pages, quiz: [] }), fakeLms("1.2"));
  p.click("next");
  p.fillIn(0, 0, "berlin");
  p.click("kcheck");
  assert.match(p.d.querySelector(".verdict").textContent, /try again/);
  p.click("kretry");
  p.fillIn(0, 0, "  PARIS  ");
  p.click("kcheck");
  assert.match(p.d.querySelector(".verdict").textContent, /Correct/);
  p.click("kgo");
  assert.equal(p.heading(), "B");
});

test("Completion badge shows on a pass when enabled, not on a fail or when disabled", () => {
  const withBadge = play(course({ showBadge: true }), fakeLms("1.2"));
  withBadge.click("next"); withBadge.click("next");
  withBadge.pick("q0", 1); withBadge.click("submit"); withBadge.click("finish");
  assert.ok(withBadge.d.querySelector(".badge"), "badge shown on pass");

  const noBadgeSetting = play(course({ showBadge: false }), fakeLms("1.2"));
  noBadgeSetting.click("next"); noBadgeSetting.click("next");
  noBadgeSetting.pick("q0", 1); noBadgeSetting.click("submit"); noBadgeSetting.click("finish");
  assert.equal(noBadgeSetting.d.querySelector(".badge"), null, "no badge when the course setting is off");

  const failed = play(course({ showBadge: true }), fakeLms("1.2"));
  failed.click("next"); failed.click("next");
  failed.pick("q0", 0); failed.click("submit");
  assert.equal(failed.d.querySelector(".badge"), null, "no badge shown yet on a fail (course isn't finished)");
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

test("Close button: when window.close() has no effect, shows a return-to-Bridge message", async () => {
  const p = play(course({ quiz: [] }), fakeLms("1.2"));
  // Unlike a real browser (which silently ignores close() on a window script didn't open - Bridge's
  // "Current window" mode), jsdom's close() actually tears the document down. Stub it as a no-op so
  // this matches the real Bridge scenario the fix targets.
  p.dom.window.close = () => {};
  p.click("next"); p.click("next");
  p.click("close");
  await new Promise((r) => setTimeout(r, 400));
  assert.match(p.d.body.textContent, /return to Bridge/);
});
