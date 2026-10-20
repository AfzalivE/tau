#!/usr/bin/env node
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSandboxRuntime } from "./sandbox-runtime.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(rootDir, "packages");
const distDir = path.join(rootDir, "dist");

const packageNames = ["tau-coding-agent", "tau-all-agent", "double-tau", "pi-code-links"];
const resourceTypes = ["extensions", "skills", "prompts", "themes"];

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

for (const packageName of packageNames) {
  await buildPackage(packageName);
}

async function buildPackage(packageName) {
  const sourceDir = path.join(packagesDir, packageName);
  const outputDir = path.join(distDir, packageName);
  const packageJson = await readJson(path.join(sourceDir, "package.json"));

  const pi = localizePiManifest(packageJson.pi ?? {}, sourceDir);

  await mkdir(outputDir, { recursive: true });
  await cp(path.join(sourceDir, "README.md"), path.join(outputDir, "README.md"));
  await cp(await getLicensePath(sourceDir), path.join(outputDir, "LICENSE"));
  // A separately versioned package ships its own release notes.
  const hasChangelog = await exists(path.join(sourceDir, "CHANGELOG.md"));
  if (hasChangelog) {
    await cp(path.join(sourceDir, "CHANGELOG.md"), path.join(outputDir, "CHANGELOG.md"));
  }

  for (const resourceType of resourceTypes) {
    await copyResources(pi[resourceType] ?? [], outputDir);
  }

  const bundlesSandboxRuntime = Boolean(
    packageJson.dependencies?.["@anthropic-ai/sandbox-runtime"],
  );
  if (bundlesSandboxRuntime) await bundleSandboxRuntime(outputDir);

  const generatedPackageJson = {
    ...packageJson,
    ...(bundlesSandboxRuntime ? { bundleDependencies: ["@anthropic-ai/sandbox-runtime"] } : {}),
    files: [
      ...resourceTypes.filter((resourceType) => pi[resourceType]?.length),
      "README.md",
      ...(hasChangelog ? ["CHANGELOG.md"] : []),
      "LICENSE",
    ],
    pi,
  };
  delete generatedPackageJson.private;

  await writeJson(path.join(outputDir, "package.json"), generatedPackageJson);
  console.log(`Built ${path.relative(rootDir, outputDir)}`);
}

function localizePiManifest(sourcePi, sourceDir) {
  const pi = {};
  for (const resourceType of resourceTypes) {
    if (!Array.isArray(sourcePi[resourceType])) continue;
    pi[resourceType] = localizePiEntries(sourcePi[resourceType], sourceDir, resourceType);
  }
  return pi;
}

function localizePiEntries(entries, sourceDir, topLevelDirectory) {
  return entries.map((entry) => {
    if (entry.includes("node_modules")) {
      throw new Error(
        `Package source manifests must not include generated install paths: ${entry}`,
      );
    }

    const absolutePath = path.resolve(sourceDir, entry);
    const relativePath = toPosixPath(path.relative(rootDir, absolutePath));
    if (!relativePath.startsWith(`${topLevelDirectory}/`)) {
      throw new Error(
        `Expected ${entry} to resolve under ${topLevelDirectory}/, got ${relativePath}`,
      );
    }
    return relativePath;
  });
}

async function copyResources(entries, outputDir) {
  const copied = new Set();
  for (const entry of entries) {
    const resourcePath = await getCopiedResourcePath(entry);
    if (copied.has(resourcePath)) continue;
    copied.add(resourcePath);

    await cp(path.join(rootDir, resourcePath), path.join(outputDir, resourcePath), {
      recursive: true,
      force: true,
    });
  }
}

async function getCopiedResourcePath(entry) {
  const sourcePath = path.join(rootDir, entry);
  const sourceStat = await stat(sourcePath);

  if (sourceStat.isDirectory()) return entry;
  if (isDirectoryEntryPoint(entry)) return toPosixPath(path.dirname(entry));
  return entry;
}

function isDirectoryEntryPoint(entry) {
  const basename = path.basename(entry);
  return (
    basename === "index.js" ||
    basename === "index.mjs" ||
    basename === "index.mts" ||
    basename === "index.ts"
  );
}

// A package by a different copyright holder keeps its own LICENSE next to its manifest.
async function getLicensePath(sourceDir) {
  const packageLicense = path.join(sourceDir, "LICENSE");
  return (await exists(packageLicense)) ? packageLicense : path.join(rootDir, "LICENSE");
}

async function exists(filePath) {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}
