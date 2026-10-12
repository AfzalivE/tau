import { REVIEW_FOCUS_NAMES, type ReviewFocus } from "./schema.js";

const REVIEW_FOCUS_ALL_VALUE = "all";
const VALID_REVIEW_FOCUS_VALUES = [REVIEW_FOCUS_ALL_VALUE, ...REVIEW_FOCUS_NAMES].join(", ");

export function parseReviewFocuses(rawFocuses: string[]): ReviewFocus[] {
  if (rawFocuses.length === 0) return [...REVIEW_FOCUS_NAMES];

  const selected: ReviewFocus[] = [];
  const seen = new Set<ReviewFocus>();
  let includeAll = false;

  for (const rawFocus of rawFocuses) {
    if (!rawFocus) {
      throw new Error(
        `focuses= requires at least one value. Valid values: ${VALID_REVIEW_FOCUS_VALUES}.`,
      );
    }

    for (const part of rawFocus.split(",")) {
      const focus = part.trim().toLowerCase();
      if (!focus) {
        throw new Error(
          `focuses= contains an empty focus name. Valid values: ${VALID_REVIEW_FOCUS_VALUES}.`,
        );
      }
      if (focus === REVIEW_FOCUS_ALL_VALUE) {
        includeAll = true;
        continue;
      }
      if (!isReviewFocus(focus)) {
        throw new Error(
          `Invalid focus "${part.trim()}". Valid values: ${VALID_REVIEW_FOCUS_VALUES}.`,
        );
      }
      if (!seen.has(focus)) {
        selected.push(focus);
        seen.add(focus);
      }
    }
  }

  return includeAll ? [...REVIEW_FOCUS_NAMES] : selected;
}

export function isReviewFocus(value: string): value is ReviewFocus {
  return (REVIEW_FOCUS_NAMES as readonly string[]).includes(value);
}
