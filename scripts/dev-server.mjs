// Runs the quiz server locally with a fake Claude API, so you can try the whole app,
// including "Generate questions", without an API key or spending credit.
//
//   npm run serve   then open http://localhost:8787   (access code: local-dev-code)
//
// The fake API always returns the same two sample questions.

import http from "node:http";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PORT = 9901;

const sample = [
  { question: "Sample question: what should you do with a lost pass?", options: ["Report it straight away", "Wait a week", "Borrow a colleague's", "Nothing"], correct: 0, feedback: "Reporting it lets it be suspended.", page: 1 },
  { question: "Sample question: who should visitors go to?", options: ["Reception", "The canteen", "Any open door", "Security only at night"], correct: 0, feedback: "Reception signs visitors in.", page: 2 },
];

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(sample) }], usage: { input_tokens: 0, output_tokens: 0 } }));
  });
}).listen(MOCK_PORT, () => {
  const child = spawn(process.execPath, [join(root, "server", "server.js")], {
    stdio: "inherit",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-ant-local-dev-not-real",
      ACCESS_CODE: "local-dev-code",
      API_URL: "http://127.0.0.1:" + MOCK_PORT + "/v1/messages",
      PORT: process.env.PORT || "8787",
    },
  });
  console.log("Open http://localhost:" + (process.env.PORT || "8787") + "  (access code: local-dev-code, fake questions)");
  const stop = () => { child.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
});
