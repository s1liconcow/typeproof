import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(projectRoot, "dist");
const extensionOutput = path.join(outputRoot, "extension");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(extensionOutput, { recursive: true });
await cp(path.join(projectRoot, "apps/extension"), extensionOutput, { recursive: true });
await cp(path.join(projectRoot, "packages/proof-core"), path.join(extensionOutput, "shared"), { recursive: true });
await cp(path.join(projectRoot, "apps/backend"), path.join(outputRoot, "apps/backend"), { recursive: true });
await cp(path.join(projectRoot, "packages"), path.join(outputRoot, "packages"), { recursive: true });

console.log(`Built unpacked Chrome extension at ${path.relative(projectRoot, extensionOutput)}`);
console.log("Built backend at dist/apps/backend (run dist/apps/backend/src/server.mjs)");
