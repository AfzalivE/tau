import { execFile } from "node:child_process";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeName = "@anthropic-ai/sandbox-runtime";
const runtimeVersion = "0.0.79";
const patchDirectory = path.join(rootDir, "patches");
const exec = promisify(execFile);

/** Publish a private patched copy, without changing the dependency used by the build process. */
export async function bundleSandboxRuntime(outputDir) {
  const runtime = await resolvePackage(runtimeName, rootDir);
  const destination = path.join(outputDir, "node_modules", runtimeName);
  assertRuntimeVersion(runtime.manifest);
  await copyPackage(runtime, destination);
  await applyPatches(destination);
}

async function patchDevelopmentRuntime() {
  const runtime = await resolvePackage(runtimeName, rootDir);
  assertRuntimeVersion(runtime.manifest);
  await applyPatches(runtime.directory);
  console.log(`Prepared ${runtimeName}@${runtimeVersion} with Tau compatibility fixes`);
}

async function applyPatches(directory) {
  const relative = path.relative(rootDir, directory);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Refusing to patch a sandbox runtime outside this Tau checkout");
  }
  const patches = (await readdir(patchDirectory)).filter((name) => name.endsWith(".patch")).sort();
  if (patches.length === 0)
    throw new Error(`No sandbox runtime patches found in ${patchDirectory}`);
  const args = ["apply", "--whitespace=nowarn", `--directory=${relative}`];
  const options = { cwd: rootDir };
  for (const name of patches) {
    const patchPath = path.join(patchDirectory, name);
    try {
      await exec("git", [...args, "--reverse", "--check", patchPath], options);
      continue;
    } catch {
      // A fresh install needs the forward patch. Its checked application must succeed.
    }
    await exec("git", [...args, "--check", patchPath], options);
    await exec("git", [...args, patchPath], options);
  }
}

function assertRuntimeVersion(manifest) {
  if (manifest.name !== runtimeName || manifest.version !== runtimeVersion) {
    throw new Error(
      `Expected ${runtimeName}@${runtimeVersion}, found ${manifest.name}@${manifest.version}`,
    );
  }
}

/** Resolve through Node's public loader, including packages that hide package.json in exports. */
async function resolvePackage(name, from) {
  const manifestPath = findPackageJSON(name, pathToFileURL(path.join(from, "package.json")));
  if (!manifestPath) throw new Error(`Could not locate package manifest for ${name}`);
  return {
    directory: path.dirname(manifestPath),
    manifest: JSON.parse(await readFile(manifestPath, "utf8")),
  };
}

/** Materialize the pinned runtime's production tree so npm can bundle it independently of hoisting. */
async function copyPackage(pkg, destination, ancestors = new Set()) {
  if (ancestors.has(pkg.directory))
    throw new Error(`Cyclic runtime dependency: ${pkg.manifest.name}`);
  if (
    Object.keys(pkg.manifest.optionalDependencies ?? {}).length ||
    Object.keys(pkg.manifest.peerDependencies ?? {}).length
  ) {
    throw new Error(
      `Review cross-platform bundling before adding optional/peer dependencies: ${pkg.manifest.name}`,
    );
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(pkg.directory, destination, {
    recursive: true,
    filter: (source) => !["node_modules", ".git"].includes(path.basename(source)),
  });
  const next = new Set([...ancestors, pkg.directory]);
  for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
    const dependency = await resolvePackage(name, pkg.directory);
    await copyPackage(dependency, path.join(destination, "node_modules", name), next);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchDevelopmentRuntime();
}
