import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pathExists } from "./fs.js";

export async function withSqliteSnapshot<T>(
  sourceDbPath: string,
  tempPrefix: string,
  operation: (snapshotPath: string) => T | Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${tempPrefix}-${process.pid}-`));
  const snapshotPath = path.join(tempDir, path.basename(sourceDbPath));

  try {
    await copyFile(sourceDbPath, snapshotPath);
    await Promise.all([
      copySidecar(sourceDbPath, snapshotPath, "-wal"),
      copySidecar(sourceDbPath, snapshotPath, "-shm"),
      copySidecar(sourceDbPath, snapshotPath, "-journal"),
    ]);
    return await operation(snapshotPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function copySidecar(
  sourceDbPath: string,
  targetDbPath: string,
  suffix: string,
): Promise<void> {
  const source = `${sourceDbPath}${suffix}`;
  if (!(await pathExists(source))) return;

  try {
    await copyFile(source, `${targetDbPath}${suffix}`);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== "ENOENT") throw error;
  }
}
