import { spawn } from "node:child_process";

const child = spawn("npx", ["vitest", "run", "tests/security"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
