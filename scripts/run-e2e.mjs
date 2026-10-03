import { readdirSync } from "node:fs";

function specs(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".spec.ts") || name.endsWith(".spec.js"));
  } catch {
    return [];
  }
}

const found = specs("tests/e2e");
if (found.length === 0) {
  console.log("no end-to-end specs in this story");
  process.exit(0);
}
console.error("end-to-end specs exist but no runner is wired yet");
process.exit(1);
