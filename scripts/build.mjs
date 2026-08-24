import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(projectRoot, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await copyFile(resolve(projectRoot, "index.html"), resolve(outputDir, "index.html"));

console.log("Built sealed public bundle: dist/index.html");
