// Invoked by runtime.mjs only, after its isolated environment has been established.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [targetRoot, packageDir] = process.argv.slice(2);
const piRoot = path.join(targetRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const { Compile } = await import(pathToFileURL(piRequire.resolve("typebox/compile")).href);
const schemaPath = path.join(piRoot, "schemas", "theme.schema.json");
const themeValidator = Compile(await readJson(schemaPath));
const piManifest = await readJson(path.join(piRoot, "package.json"));
const { DefaultResourceLoader, SettingsManager } = await import(
  pathToFileURL(path.resolve(piRoot, piManifest.exports["."].import)).href
);
const manifest = await readJson(path.join(packageDir, "package.json"));

// The resource loader may omit invalid themes without diagnostics. Check their JSON independently.
for (const resource of manifest.pi?.themes ?? []) {
  const themePath = path.resolve(packageDir, resource);
  const theme = await readJson(themePath);
  if (!themeValidator.Check(theme)) {
    throw new Error(
      `${themePath} fails target theme schema ${schemaPath}:\n${JSON.stringify([...themeValidator.Errors(theme)], null, 2)}`,
    );
  }
  if (themeValidator.Check({ ...theme, unsupportedMetadata: true })) {
    throw new Error(`Target theme schema accepted unsupportedMetadata: ${schemaPath}`);
  }
  console.log(
    `${manifest.name}: ${resource} passes target theme schema; unsupported-property negative control rejected (${schemaPath})`,
  );
}

const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.create(cwd, agentDir);
try {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => false });
  assertPackageResources(manifest.name, packageDir, manifest, loader);
} finally {
  await settingsManager.flush();
}

function assertPackageResources(packageName, packageDir, manifest, loader) {
  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();
  const belongsToPackage = (sourceInfo) =>
    sourceInfo?.source && path.resolve(sourceInfo.source) === path.resolve(packageDir);

  const loadedExtensions = extensions.extensions.filter((extension) =>
    belongsToPackage(extension.sourceInfo),
  );
  const loadedSkills = skills.skills.filter((skill) => belongsToPackage(skill.sourceInfo));
  const loadedPrompts = prompts.prompts.filter((prompt) => belongsToPackage(prompt.sourceInfo));
  const loadedThemes = themes.themes.filter((theme) => belongsToPackage(theme.sourceInfo));
  const diagnostics = [
    ...extensions.errors.map(({ path: resourcePath, error }) => ({
      type: "error",
      message: `${resourcePath}: ${error}`,
    })),
    ...(extensions.warnings ?? []).map(({ path: resourcePath, warning }) => ({
      type: "warning",
      message: `${resourcePath}: ${warning}`,
    })),
    ...skills.diagnostics,
    ...prompts.diagnostics,
    ...themes.diagnostics,
  ];

  const expected = {
    extensions: manifest.pi?.extensions?.length ?? 0,
    skills: manifest.pi?.skills?.length ?? 0,
    prompts: manifest.pi?.prompts?.length ?? 0,
    themes: manifest.pi?.themes?.length ?? 0,
  };
  const actual = {
    extensions: loadedExtensions.length,
    skills: loadedSkills.length,
    prompts: loadedPrompts.length,
    themes: loadedThemes.length,
  };

  console.log(
    `${packageName}: extensions ${actual.extensions}/${expected.extensions}, skills ${actual.skills}/${expected.skills}, prompts ${actual.prompts}/${expected.prompts}, themes ${actual.themes}/${expected.themes}, diagnostics ${diagnostics.length}`,
  );

  const mismatches = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
  if (mismatches.length > 0 || diagnostics.length > 0) {
    const details = [
      ...mismatches.map((key) => `${key}: loaded ${actual[key]}, expected ${expected[key]}`),
      ...diagnostics.map((diagnostic) => `${diagnostic.type}: ${diagnostic.message}`),
    ];
    throw new Error(`${packageName} resource validation failed:\n${details.join("\n")}`);
  }
}

async function readJson(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}
