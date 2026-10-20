import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export type Location = { path: string; line?: number; column?: number };

type Tag = {
  name: string;
  path: string;
  line: number;
  kind: string;
  scope?: string;
  /** The receiver type of a Kotlin extension, which ctags scopes to the package instead. */
  receiver?: string;
  indent: number;
  owner?: Tag;
};

const TYPE_KINDS = new Set([
  "class",
  "interface",
  "object",
  "struct",
  "enum",
  "trait",
  "protocol",
  "typealias",
]);
const IGNORED_KINDS = new Set(["package", "import", "module", "namespace"]);
const IGNORED_LANGUAGES = [
  "Markdown",
  "JSON",
  "YAML",
  "Iniconf",
  "XML",
  "HTML",
  "CSS",
  "SVG",
  "Sh",
];

const FENCE = /^\s*(```|~~~)/;
// Existing links, autolinks, and URLs stay as they are. Code spans and bare references are candidates.
const INLINE =
  /(\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>|\bhttps?:\/\/\S+)|`([^`\n]+)`|(?<![\w./#~:-])([\w~./-][\w./#:~-]*(?:\(\))?)/g;
const TRAILING_PUNCTUATION = /[.:,;]+$/;

/** Definitions and files of one working directory, from Git's file list and Universal Ctags. */
export class CodeIndex {
  private ctags: string | undefined;
  private readonly files = new Set<string>();
  private readonly filesByBasename = new Map<string, string[]>();
  private readonly tagsByName = new Map<string, Tag[]>();
  private readonly tagsByPath = new Map<string, Tag[]>();

  constructor(private readonly cwd: string) {}

  /** A directory outside Git has no file list, so it keeps an empty index without checking ctags. */
  async build() {
    const files = await lines(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      this.cwd,
    ).catch(() => undefined);
    if (!files) return;
    this.ctags = await findUniversalCtags(this.cwd);
    for (const file of files) this.addFile(file);
    for (const tag of await this.readTags(files)) this.addTag(tag);
  }

  async refresh(file: string) {
    const relative = this.relative(file);
    if (!relative || !this.ctags) return;
    for (const tag of this.tagsByPath.get(relative) ?? []) {
      const remaining = this.tagsByName.get(tag.name)!.filter((other) => other !== tag);
      if (remaining.length) this.tagsByName.set(tag.name, remaining);
      else this.tagsByName.delete(tag.name);
    }
    this.tagsByPath.delete(relative);
    this.addFile(relative);
    for (const tag of await this.readTags([relative])) this.addTag(tag);
  }

  /** Bare names resolve only when allowed, because prose words often match short symbols. */
  resolve(reference: string, { allowBareName }: { allowBareName: boolean }): Location | undefined {
    const text = reference.replace(/\([^()]*\)$/, "");
    const file = /^(.+?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
    const filePath = file && this.findFile(file[1]);
    if (filePath) return { path: filePath, line: toNumber(file[2]), column: toNumber(file[3]) };

    const parts = text.split(/::|[.#]/);
    if (parts.some((part) => !/^[A-Za-z_]\w*$/.test(part))) return undefined;
    if (parts.length === 1 && !allowBareName) return undefined;
    const tag = this.findSymbol(parts);
    return tag && { path: path.join(this.cwd, tag.path), line: tag.line };
  }

  private findFile(reference: string) {
    if (!/\.\w+$/.test(reference)) return undefined;
    const relative = this.relative(reference.replace(/^\.\//, ""));
    if (!relative) return undefined;
    if (this.files.has(relative)) return path.join(this.cwd, relative);
    const matches = (this.filesByBasename.get(path.basename(relative)) ?? []).filter((file) =>
      file.endsWith(`/${relative}`),
    );
    return matches.length === 1 ? path.join(this.cwd, matches[0]) : undefined;
  }

  private findSymbol(parts: string[]) {
    const name = parts.at(-1)!;
    const container = parts.at(-2);
    const candidates = this.tagsByName.get(name) ?? [];
    if (container) {
      const members = candidates.filter((tag) => isMemberOf(tag, container));
      if (members.length) return single(members);
    }
    return single(candidates) ?? single(candidates.filter((tag) => TYPE_KINDS.has(tag.kind)));
  }

  private addFile(file: string) {
    if (this.files.has(file)) return;
    this.files.add(file);
    const basename = path.basename(file);
    this.filesByBasename.set(basename, [...(this.filesByBasename.get(basename) ?? []), file]);
  }

  private addTag(tag: Tag) {
    this.tagsByName.set(tag.name, [...(this.tagsByName.get(tag.name) ?? []), tag]);
    this.tagsByPath.set(tag.path, [...(this.tagsByPath.get(tag.path) ?? []), tag]);
  }

  // Universal Ctags parses on one core, so each core gets a share of the files. Sorting would
  // run the external sort command, and the index does not need it.
  private async readTags(files: string[]) {
    const args = [
      "--output-format=json",
      "--fields=+nKs",
      "--sort=no",
      `--languages=${IGNORED_LANGUAGES.map((language) => `-${language}`).join(",")}`,
      "-L",
      "-",
      "-f",
      "-",
    ];
    const workers = Math.min(os.availableParallelism(), files.length);
    const shares = Array.from({ length: workers }, (_, worker) =>
      files.filter((_, i) => i % workers === worker),
    );
    const outputs = await Promise.all(
      shares.map((share) => lines(this.ctags!, args, this.cwd, share.join("\n"))),
    );
    const tags = outputs.flat().flatMap((line): Tag[] => {
      const entry = JSON.parse(line);
      if (entry._type !== "tag" || IGNORED_KINDS.has(entry.kind) || entry.name.startsWith("<"))
        return [];
      return [
        {
          name: entry.name,
          path: entry.path,
          line: entry.line,
          kind: entry.kind,
          scope: entry.scope,
          receiver: receiverOf(entry.name, entry.pattern ?? ""),
          indent: /^\/\^([ \t]*)/.exec(entry.pattern ?? "")?.[1].length ?? 0,
        },
      ];
    });
    assignOwners(tags);
    return tags;
  }

  private relative(file: string) {
    const relative = path.relative(this.cwd, path.resolve(this.cwd, file));
    return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative;
  }
}

/** Rewrite resolvable references outside fenced code as Markdown links. */
export function linkReferences(
  markdown: string,
  index: CodeIndex,
  link: (location: Location) => string,
) {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) fenced = !fenced;
      return fenced || FENCE.test(line) ? line : linkLine(line, index, link);
    })
    .join("\n");
}

function linkLine(line: string, index: CodeIndex, link: (location: Location) => string) {
  return line.replace(INLINE, (match, skipped?: string, code?: string, bare?: string) => {
    if (skipped) return match;
    if (code) {
      const location = index.resolve(code.trim(), { allowBareName: true });
      return location ? `[${match}](${link(location)})` : match;
    }
    const reference = bare!.replace(TRAILING_PUNCTUATION, "");
    const location = index.resolve(reference, { allowBareName: false });
    return location ? `[${reference}](${link(location)})${bare!.slice(reference.length)}` : match;
  });
}

// macOS ships BSD ctags in /usr/bin, which often precedes Homebrew on PATH.
async function findUniversalCtags(cwd: string) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, "ctags");
    if (!(await isExecutable(candidate))) continue;
    const version = await lines(candidate, ["--version"], cwd).catch(() => []);
    if (version[0]?.startsWith("Universal Ctags")) return candidate;
  }
  throw new Error(
    "Universal Ctags is not on PATH. Install it, for example with: brew install universal-ctags",
  );
}

// Some ctags parsers, such as Kotlin's, record wrong scopes and no end lines. In formatted code,
// the nearest preceding type with a smaller indent owns a tag.
function assignOwners(tags: Tag[]) {
  const byPath = new Map<string, Tag[]>();
  for (const tag of tags) byPath.set(tag.path, [...(byPath.get(tag.path) ?? []), tag]);
  for (const fileTags of byPath.values()) {
    const types: Tag[] = [];
    for (const tag of fileTags.sort((a, b) => a.line - b.line)) {
      while (types.length && types.at(-1)!.indent >= tag.indent) types.pop();
      tag.owner = types.at(-1);
      if (TYPE_KINDS.has(tag.kind)) types.push(tag);
    }
  }
}

// Members of a Kotlin companion object belong to the enclosing class.
function isMemberOf(tag: Tag, container: string) {
  const owner = tag.owner?.name === "Companion" ? tag.owner.owner : tag.owner;
  const scope = tag.scope?.split(/::|\./) ?? [];
  const scopeOwner = scope.at(-1) === "Companion" ? scope.at(-2) : scope.at(-1);
  return owner?.name === container || scopeOwner === container || tag.receiver === container;
}

// Kotlin declares an extension as `fun <T> a.b.Type<T>?.name`. The receiver's simple name is
// what a reference such as `Type.name()` uses.
function receiverOf(name: string, pattern: string) {
  if (!/^\w+$/.test(name)) return undefined;
  const declaration = new RegExp(
    `\\b(?:fun|val|var)\\s+(?:<[^=(]*?>\\s+)?([\\w.]+)(?:<[^=(]*>)?\\??\\.${name}\\b`,
  );
  return declaration.exec(pattern)?.[1].split(".").at(-1);
}

// Overloads share a file, so the first definition in that file is a correct target.
function single(tags: Tag[]) {
  if (!tags.length || new Set(tags.map((tag) => tag.path)).size > 1) return undefined;
  return tags.reduce((first, tag) => (tag.line < first.line ? tag : first));
}

function toNumber(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
}

async function isExecutable(file: string) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lines(command: string, args: string[], cwd: string, input = "") {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    const output: string[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => line && output.push(line));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}`)),
    );
    child.stdin.end(input);
  });
}
