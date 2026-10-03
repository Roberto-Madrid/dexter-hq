const { readFileSync } = require("node:fs");
const html = readFileSync("index.html", "utf8");
if (!html.includes("<title>Dexter checker</title>")) {
  console.log("lint failed");
  process.exit(1);
}
console.log("lint ok");
