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
await mkdir(resolve(outputDir, "controller"), { recursive: true });
await copyFile(resolve(projectRoot, "index.html"), resolve(outputDir, "index.html"));
await copyFile(resolve(projectRoot, "pay.html"), resolve(outputDir, "pay.html"));

for (const asset of controllerAssets) {
  await copyFile(
    resolve(projectRoot, "public", asset),
    resolve(outputDir, asset),
  );
}

await copyFile(
  resolve(projectRoot, "public", "gauge-stack-controller.html"),
  resolve(outputDir, "controller", "index.html"),
);

console.log("Built connected public adapter and owner controller in dist/.");
