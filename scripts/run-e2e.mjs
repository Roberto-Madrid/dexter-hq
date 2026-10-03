import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import net from "node:net";

mkdirSync(".agent-work/evidence/G3", { recursive: true });
const port = Number(process.env.PORT ?? "3210");
const env = {
  ...process.env,
  PORT: String(port),
  DEXTER_STORE: "memory",
  DEXTER_CEO: "scripted",
  DEXTER_OWNER_EMAIL: "owner@example.com",
  DEXTER_CALLBACK_SECRET: "e2e-callback-secret",
  CURSOR_API_KEY: "",
  GH_HQ_TOKEN: "",
  GH_WORKERS_REPO: "",
  SUPABASE_DB_URL: "",
};

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function portFree(target) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(target, "127.0.0.1");
  });
}

const bundled = await run("node", ["scripts/bundle-hq.mjs"]);
if (bundled !== 0) process.exit(bundled);
if (!(await portFree(port))) {
  console.error(`port ${port} is already in use`);
  process.exit(1);
}

const server = spawn("npx", ["next", "dev", "--port", String(port)], {
  env,
  stdio: "inherit",
  detached: true,
});

function stopServer() {
  if (!server.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
}

process.on("exit", stopServer);

let ready = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/login`);
    if (response.status < 500) {
      ready = true;
      break;
    }
  } catch {
    // The server is still starting.
  }
}
if (!ready) {
  stopServer();
  console.error("dev server did not start");
  process.exit(1);
}

const code = await run("npx", ["playwright", "test", "--config", "playwright.config.ts"]);
stopServer();
process.exit(code);
