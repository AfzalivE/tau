import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFilesystemFallbackPath,
  extractPathLikeValue,
} from "./filesystem-violation-parser.ts";

test("does not classify a Gradle network failure as filesystem access", () => {
  const output = [
    "> Could not get resource 'https://dl.google.com/example.pom'.",
    "   > Could not GET 'https://dl.google.com/example.pom'.",
    "      > Got socket exception during request.",
    "         > Operation not permitted",
    "For more information, see https://docs.gradle.org/9.6.1/userguide/command_line_interface.html.",
  ].join("\n");

  assert.equal(extractFilesystemFallbackPath(output), undefined);
});

test("does not pair a filesystem error with an unrelated path on another line", () => {
  const output = [
    "Source file: /Users/example/build.gradle.kts",
    "Operation not permitted",
    "Problems report: file:///Users/example/build/reports/problems.html",
  ].join("\n");

  assert.equal(extractFilesystemFallbackPath(output), undefined);
});

test("does not extract a network URL from an error-bearing line", () => {
  assert.equal(
    extractFilesystemFallbackPath(
      "Could not GET 'https://dl.google.com/example.pom': Operation not permitted",
    ),
    undefined,
  );
  assert.equal(
    extractFilesystemFallbackPath(
      "Could not GET https://example.com?redirect=/private/data: Operation not permitted",
    ),
    undefined,
  );
});

test("extracts local paths from filesystem error lines", () => {
  assert.equal(
    extractFilesystemFallbackPath("rm: /private/data: Operation not permitted"),
    "/private/data",
  );
  assert.equal(
    extractFilesystemFallbackPath(
      'Error: EPERM: operation not permitted, open "/private/data with spaces"',
    ),
    "/private/data with spaces",
  );
  assert.equal(
    extractFilesystemFallbackPath("tool: //server/share: Operation not permitted"),
    "//server/share",
  );
});

test("extracts paths from tagged sandbox violations", () => {
  assert.equal(
    extractPathLikeValue("node(1) deny(1) file-read-data /private/data with spaces"),
    "/private/data with spaces",
  );
});
