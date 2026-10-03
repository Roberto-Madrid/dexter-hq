const { mkdirSync, writeFileSync } = require("node:fs");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/ok.txt", "ok\n");
console.log("build ok");
