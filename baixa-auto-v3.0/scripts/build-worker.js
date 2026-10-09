#!/usr/bin/env node
"use strict";
// Gera background/service-worker.js a partir dos módulos-fonte.
// Uso: npm run build           -> grava o bundle
//      npm run build -- --check -> falha se o bundle gravado estiver desatualizado
const fs = require("node:fs");
const path = require("node:path");

const base = path.join(__dirname, "..");
const MODULES = [
  "utils/helpers.js",
  "automation/navigation.js",
  "automation/batch-handler.js",
  "storage/storage.js",
  "rules/baixa-rules.js",
  "rules/validation.js",
  "ai/ai-schema.js",
  "ai/ai-provider.js",
  "ai/ai-service.js",
  "background/run-guard.js"
];
const MAIN = "background/background.js";
const OUTPUT = "background/service-worker.js";

const read = file => fs.readFileSync(path.join(base, file), "utf8").replace(/\r\n/g, "\n");

function buildBundle() {
  const parts = MODULES.map(file => `/* bundled: ${file} */\n${read(file).replace(/\n+$/, "")}\n`);
  const main = read(MAIN).replace(/importScripts\([\s\S]*?\);\s*/, "");
  parts.push(`/* bundled: ${MAIN} */\n${main.replace(/^\s+/, "")}`);
  return parts.join("\n");
}

function main() {
  const bundle = buildBundle();
  const target = path.join(base, OUTPUT);
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== bundle) {
      console.error(`${OUTPUT} está desatualizado. Execute: npm run build`);
      process.exitCode = 1;
    } else {
      console.log(`${OUTPUT} está sincronizado.`);
    }
    return;
  }
  fs.writeFileSync(target, bundle);
  console.log(`${OUTPUT} gerado (${bundle.length} bytes).`);
}

if (require.main === module) main();
module.exports = { buildBundle, MODULES };
