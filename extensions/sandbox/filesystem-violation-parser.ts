export function extractPathLikeValue(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const path = extractPathLikeValueFromLine(lines[index]);
    if (path) return path;
  }

  return undefined;
}

export function extractFilesystemFallbackPath(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Command output can contain unrelated paths and URLs. Correlate the path with
  // the line that reported the fallback error instead of combining separate lines.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/\bEPERM\b|Operation not permitted/i.test(line)) continue;

    const path = extractFilesystemPathFromFailureLine(line);
    if (path) return path;
  }

  return undefined;
}

function extractFilesystemPathFromFailureLine(line: string): string | undefined {
  const operationNotPermittedPath = extractOperationNotPermittedPath(line);
  if (operationNotPermittedPath) return operationNotPermittedPath;

  const quotedPath = extractQuotedPath(line);
  if (quotedPath) return quotedPath;

  const rawPathMatch = line.match(/(?:^|\s)((?:~\/|\/)[^\s,)]+)/);
  return rawPathMatch?.[1] ? sanitizeExtractedPath(rawPathMatch[1]) : undefined;
}

function extractPathLikeValueFromLine(line: string): string | undefined {
  const sandboxViolationMatch = line.match(/\bfile-(?:read|write)[^\s]*\s+((?:~\/|\/).+)$/i);
  if (sandboxViolationMatch?.[1]) return sanitizeExtractedPath(sandboxViolationMatch[1]);

  const operationNotPermittedPath = extractOperationNotPermittedPath(line);
  if (operationNotPermittedPath) return operationNotPermittedPath;

  const quotedPath = extractQuotedPath(line);
  if (quotedPath) return quotedPath;

  const rawPathMatch = line.match(/((?:~\/|\/)[^\s,)]+)/);
  return rawPathMatch?.[1] ? sanitizeExtractedPath(rawPathMatch[1]) : undefined;
}

function extractOperationNotPermittedPath(line: string): string | undefined {
  const match = line.match(/^(?:[^:\n]+:\s+)*((?:~\/|\/).+?):\s+Operation not permitted$/i);
  return match?.[1] ? sanitizeExtractedPath(match[1]) : undefined;
}

function extractQuotedPath(line: string): string | undefined {
  const match = line.match(/["']((?:~\/|\/)[^"']+)["']/);
  return match?.[1] ? sanitizeExtractedPath(match[1]) : undefined;
}

function sanitizeExtractedPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;

  const withoutDelimiter = trimmed.replace(/:+$/g, "");
  return withoutDelimiter.length > 0 ? withoutDelimiter : undefined;
}
