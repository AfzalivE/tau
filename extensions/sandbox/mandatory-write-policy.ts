import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DANGEROUS_FILES,
  getDangerousDirectories,
  normalizeCaseForComparison,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

const GIT_HOOKS_RULE = ".git/hooks";
const GIT_CONFIG_RULE = ".git/config";

export function findMandatoryWriteRule(
  targetPath: string,
  cwd: string,
  allowGitConfig = false,
): string | null {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return null;
  }

  const normalizedPath = normalizeRelativePath(relativePath);
  const segments = normalizedPath.split("/");

  for (const fileName of DANGEROUS_FILES) {
    if (segments.at(-1) === normalizeCaseForComparison(fileName)) {
      return fileName;
    }
  }

  for (const directory of getDangerousDirectories()) {
    if (matchesDirectory(normalizedPath, directory)) return directory;
  }

  if (matchesDirectory(normalizedPath, GIT_HOOKS_RULE)) return GIT_HOOKS_RULE;
  if (!allowGitConfig && matchesDirectory(normalizedPath, GIT_CONFIG_RULE)) {
    return GIT_CONFIG_RULE;
  }

  return null;
}

function normalizeRelativePath(path: string): string {
  return normalizeCaseForComparison(path.split(sep).join("/"));
}

function matchesDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = normalizeCaseForComparison(directory);
  return (
    path === normalizedDirectory ||
    path.startsWith(`${normalizedDirectory}/`) ||
    path.endsWith(`/${normalizedDirectory}`) ||
    path.includes(`/${normalizedDirectory}/`)
  );
}
