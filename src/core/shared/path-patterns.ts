function escapeRegexChar(value: string): string {
  return /[.*+?^${}()|[\]\\]/.test(value) ? `\\${value}` : value;
}

export function normalizeQuestPathPattern(pattern: string): string {
  return pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function patternToRegExp(pattern: string): RegExp {
  const normalized = normalizeQuestPathPattern(pattern);
  let expression = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === undefined) {
      break;
    }

    if (char === "*") {
      if (normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }

    expression += escapeRegexChar(char);
  }

  return new RegExp(`${expression}$`);
}

export function matchesQuestPathPattern(relativePath: string, patterns: string[]): boolean {
  const normalized = normalizeQuestPathPattern(relativePath);
  if (normalized.length === 0) {
    return false;
  }

  return patterns
    .map((pattern) => normalizeQuestPathPattern(pattern))
    .filter((pattern) => pattern.length > 0)
    .some((pattern) => patternToRegExp(pattern).test(normalized));
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*");
}

function splitPatternSegments(pattern: string): string[] {
  const normalized = normalizeQuestPathPattern(pattern);
  return normalized.length === 0 ? [] : normalized.split("/");
}

function pathsHaveLiteralOwnershipOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function segmentPatternsIntersect(left: string, right: string): boolean {
  const queue: Array<[number, number]> = [[0, 0]];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift() ?? [0, 0];
    const key = `${leftIndex}:${rightIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (leftIndex === left.length && rightIndex === right.length) {
      return true;
    }

    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];
    const enqueue = (nextLeftIndex: number, nextRightIndex: number): void => {
      if (nextLeftIndex <= left.length && nextRightIndex <= right.length) {
        queue.push([nextLeftIndex, nextRightIndex]);
      }
    };

    if (leftChar === "*" && rightChar === "*") {
      enqueue(leftIndex + 1, rightIndex);
      enqueue(leftIndex, rightIndex + 1);
      enqueue(leftIndex + 1, rightIndex + 1);
      continue;
    }

    if (leftChar === "*") {
      enqueue(leftIndex + 1, rightIndex);
      if (rightChar !== undefined) {
        enqueue(leftIndex, rightIndex + 1);
      }
      continue;
    }

    if (rightChar === "*") {
      enqueue(leftIndex, rightIndex + 1);
      if (leftChar !== undefined) {
        enqueue(leftIndex + 1, rightIndex);
      }
      continue;
    }

    if (leftChar !== undefined && rightChar !== undefined && leftChar === rightChar) {
      enqueue(leftIndex + 1, rightIndex + 1);
    }
  }

  return false;
}

function pathPatternLanguagesIntersect(leftPattern: string, rightPattern: string): boolean {
  const leftSegments = splitPatternSegments(leftPattern);
  const rightSegments = splitPatternSegments(rightPattern);
  const queue: Array<[number, number]> = [[0, 0]];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift() ?? [0, 0];
    const key = `${leftIndex}:${rightIndex}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) {
      return true;
    }

    const leftSegment = leftSegments[leftIndex];
    const rightSegment = rightSegments[rightIndex];
    const enqueue = (nextLeftIndex: number, nextRightIndex: number): void => {
      if (nextLeftIndex <= leftSegments.length && nextRightIndex <= rightSegments.length) {
        queue.push([nextLeftIndex, nextRightIndex]);
      }
    };

    if (leftSegment === "**") {
      enqueue(leftIndex + 1, rightIndex);
      if (rightSegment !== undefined) {
        enqueue(leftIndex, rightIndex + 1);
      }
      continue;
    }

    if (rightSegment === "**") {
      enqueue(leftIndex, rightIndex + 1);
      if (leftSegment !== undefined) {
        enqueue(leftIndex + 1, rightIndex);
      }
      continue;
    }

    if (
      leftSegment !== undefined &&
      rightSegment !== undefined &&
      segmentPatternsIntersect(leftSegment, rightSegment)
    ) {
      enqueue(leftIndex + 1, rightIndex + 1);
    }
  }

  return false;
}

function staticPrefixBeforeGlob(pattern: string): string {
  const prefixSegments: string[] = [];
  for (const segment of splitPatternSegments(pattern)) {
    if (segment === "**" || hasGlob(segment)) {
      break;
    }
    prefixSegments.push(segment);
  }
  return prefixSegments.join("/");
}

function literalOwnsPatternArea(literalPath: string, globPattern: string): boolean {
  const staticPrefix = staticPrefixBeforeGlob(globPattern);
  return (
    staticPrefix.length > 0 &&
    (literalPath === staticPrefix || staticPrefix.startsWith(`${literalPath}/`))
  );
}

export function patternsConflict(left: string, right: string): boolean {
  const normalizedLeft = normalizeQuestPathPattern(left);
  const normalizedRight = normalizeQuestPathPattern(right);

  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }

  if (normalizedLeft === "**" || normalizedRight === "**") {
    return true;
  }

  const leftHasGlob = hasGlob(normalizedLeft);
  const rightHasGlob = hasGlob(normalizedRight);

  if (!leftHasGlob && !rightHasGlob) {
    return pathsHaveLiteralOwnershipOverlap(normalizedLeft, normalizedRight);
  }

  if (leftHasGlob !== rightHasGlob) {
    const globPattern = leftHasGlob ? normalizedLeft : normalizedRight;
    const literalPath = leftHasGlob ? normalizedRight : normalizedLeft;
    return (
      matchesQuestPathPattern(literalPath, [globPattern]) ||
      literalOwnsPatternArea(literalPath, globPattern)
    );
  }

  return pathPatternLanguagesIntersect(normalizedLeft, normalizedRight);
}
