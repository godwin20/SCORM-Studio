// Builds the standalone builder page from the source.
//
//   src/scorm-studio.html   the source. It has no <html>/<head>/<body> tags because the
//                           claude.ai Artifact publisher adds them. Edit this file.
//   dist/scorm-studio.html  a complete page that opens on its own in any browser and is
//                           the file the server hosts. Never edit this by hand.
//
// Also copies the built page next to the server (for local runs) and into
// deploy/truenas/app/ together with server.js, ready to copy into the TrueNAS dataset.
//
// Usage: node scripts/build.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src", "scorm-studio.html"), "utf8");

if (/<\/?(html|head|body)[\s>]/i.test(src.slice(0, 400))) {
  console.error("src/scorm-studio.html should not contain <html>, <head> or <body> tags.");
  process.exit(1);
}

// Same small reset the claude.ai publisher adds, so both versions look identical.
const reset =
  ":root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}" +
  "body{margin:0;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}img{max-width:100%}[hidden]{display:none!important}";

const page =
  "<!doctype html>\n<html lang=\"en-GB\">\n<head>\n<meta charset=\"utf-8\">\n" +
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n" +
  "<style>" + reset + "</style>\n</head>\n<body>\n" + src + "\n</body>\n</html>\n";

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "scorm-studio.html"), page);

mkdirSync(join(root, "deploy", "truenas", "app"), { recursive: true });
copyFileSync(join(root, "dist", "scorm-studio.html"), join(root, "deploy", "truenas", "app", "scorm-studio.html"));
copyFileSync(join(root, "server", "server.js"), join(root, "deploy", "truenas", "app", "server.js"));
copyFileSync(join(root, "dist", "scorm-studio.html"), join(root, "server", "scorm-studio.html"));

console.log("Built dist/scorm-studio.html (" + Math.round(page.length / 1024) + " KB)");
console.log("Updated deploy/truenas/app/ and server/scorm-studio.html");
