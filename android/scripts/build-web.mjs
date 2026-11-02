// Builds www/ (the app's web content) from the web version in ../static and
// ../templates, plus the Android files in src/. Run: npm run build
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const web = join(root, "..");
const www = join(root, "www");

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const f of ["app.js", "liquify.js", "style.css"]) cpSync(join(web, "static", f), join(www, f));
for (const f of ["engine.js", "mobile.js", "mobile.css"]) cpSync(join(root, "src", f), join(www, f));

let html = readFileSync(join(web, "templates", "index.html"), "utf8");
function replace(from, to) {
  if (!html.includes(from)) throw new Error(`build-web: "${from}" not found in templates/index.html`);
  html = html.replace(from, to);
}
html = html.replace(/\{\{\s*url_for\('static',\s*filename='([^']+)'\)\s*\}\}/g, "$1");
if (html.includes("{{")) throw new Error("build-web: index.html still has template tags");
replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"');
replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="mobile.css">');
replace('<script src="app.js"></script>', '<script src="mobile.js"></script>\n<script src="app.js"></script>');
writeFileSync(join(www, "index.html"), html);
console.log("www/ built");
