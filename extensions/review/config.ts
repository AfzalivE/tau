import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { parseReviewFocuses } from "./focus.js";
import type { ParsedRequest } from "./schema.js";

type ReviewDefaults = Pick<ParsedRequest, "models" | "focuses">;

export function loadReviewDefaults(): ReviewDefaults {
  const configPath = path.join(getAgentDir(), "review.json");
  try {
    let value: unknown = {};
    try {
      value = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return parseReviewDefaults(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid review config at ${configPath}: ${message}`);
  }
}

function parseReviewDefaults(value: unknown): ReviewDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object with optional models and focuses arrays");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!["models", "model", "focuses", "focus"].includes(key))
      throw new Error(`Unknown field ${JSON.stringify(key)}`);
  }
  const models = parseStringList(readAliasedField(config, "models", "model"), "models");
  const rawFocuses = readAliasedField(config, "focuses", "focus");
  const focuses = parseStringList(rawFocuses, "focuses");
  if (rawFocuses !== undefined && focuses.length === 0)
    throw new Error("focuses must contain at least one focus name; omit it to use all focuses");
  return { models, focuses: parseReviewFocuses(focuses) };
}

function readAliasedField(
  config: Record<string, unknown>,
  field: "models" | "focuses",
  alias: "model" | "focus",
): unknown {
  if (Object.hasOwn(config, field) && Object.hasOwn(config, alias))
    throw new Error(`Use either ${JSON.stringify(field)} or ${JSON.stringify(alias)}, not both`);
  return Object.hasOwn(config, field) ? config[field] : config[alias];
}

function parseStringList(value: unknown, field: "models" | "focuses"): string[] {
  if (value === undefined) return [];
  const item = field === "models" ? "model pattern" : "focus name";
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of ${item}s`);

  const entries = value.map((entry: unknown, index: number) => {
    if (typeof entry !== "string" || !entry.trim())
      throw new Error(`${field}[${index}] must be a nonblank ${item}`);
    if (entry.includes(","))
      throw new Error(`${field}[${index}] must contain one ${item}, not a comma-separated list`);
    return entry.trim();
  });
  return [...new Set(entries)];
}
