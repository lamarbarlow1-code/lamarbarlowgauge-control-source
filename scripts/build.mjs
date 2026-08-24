import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(projectRoot, "dist");
const controllerAssets = [
  "gauge-stack-controller.html",
  "gauge-stack-controller.css",
  "gauge-stack-controller.js",
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await copyFile(resolve(projectRoot, "index.html"), resolve(outputDir, "index.html"));

for (const asset of controllerAssets) {
  await copyFile(
    resolve(projectRoot, "public", asset),
    resolve(outputDir, asset),
  );
}

console.log("Built public adapter and owner controller shell in dist/.");
