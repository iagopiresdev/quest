function patternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped.replaceAll("**", "__DOUBLE_STAR__").replaceAll("*", "__STAR__");
  return new RegExp(
    `^${withStars.replaceAll("__DOUBLE_STAR__", ".*").replaceAll("__STAR__", "[^/]*")}$`,
  );
}

export function matchesQuestPathPattern(relativePath: string, patterns: string[]): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return patterns.some((pattern) => patternToRegExp(pattern).test(normalized));
}
