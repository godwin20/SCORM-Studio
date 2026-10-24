# SCORM Studio

Build short training courses in the browser and download them as SCORM packages for Bridge.

- Pages with text, images, video and key points
- Import from Word, PowerPoint and PDF
- Themes, colours, fonts, logo and cover page
- Knowledge checks after any page, and a final quiz
- Quiz questions written by Claude from your page content (through your own quiz server)
- Exports SCORM 1.2 or SCORM 2004 4th Edition

Live at **https://scorm-studio.g-security.uk/**

## Quick start (on your computer)

You need Node.js 18 or newer.

```bash
npm install
npx playwright install chromium     # only needed for the browser tests
npm run serve                        # opens on http://localhost:8787
```

Locally the quiz generator uses a fake Claude API, so nothing is charged. Access code: `local-dev-code`.

## Opening it in Claude Code

1. Unzip this folder somewhere you keep projects, for example `~/projects/scorm-studio`.
2. Open a terminal in that folder and run `claude`.
3. Claude Code reads `CLAUDE.md` automatically, so it knows how everything fits together,
   how to test, and how to deploy to TrueNAS. A good first message is:
   "Run npm install and npm test, then tell me if anything fails."
4. Optional: `git init && git add . && git commit -m "Import SCORM Studio"` so every later change is tracked.

## Making changes

- Edit **`src/scorm-studio.html`** (the builder) or **`server/server.js`** (the quiz server).
- Run `npm test` to build and check everything.
- The files to put on TrueNAS are in **`deploy/truenas/app/`** after a build.

## Putting it on TrueNAS

See **[docs/TRUENAS-SETUP.md](docs/TRUENAS-SETUP.md)** for first-time setup, updates and fixes.

## Using it without a server

`dist/scorm-studio.html` (after `npm run build`) opens on its own in any browser. Everything works except
question writing, which needs a quiz server address and access code (Quiz > Settings).

## Uploading to Bridge

1. Author > Courses > Upload course, choose the .zip as it is (don't unzip it).
2. Under **More Settings**, set **Opens in** to **Current window** so it plays inside Bridge instead of a popup.
3. Set an estimated duration (Bridge doesn't read it from the file), then Publish.
4. Enrol yourself and run through once to check completion is recorded.
