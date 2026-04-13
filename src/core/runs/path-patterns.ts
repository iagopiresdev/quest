function escapeRegexChar(value: string): string {
  return /[.*+?^${}()|[\]\\]/.test(value) ? `\\${value}` : value;
}

function patternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let expression = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === undefined) {
      break;
    }

    if (char === "*") {
      if (normalized[index + 1] === "*") {
        expression += ".*";
        index += 1;
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
  const normalized = relativePath.replaceAll("\\", "/");
  return patterns.some((pattern) => patternToRegExp(pattern).test(normalized));
}
