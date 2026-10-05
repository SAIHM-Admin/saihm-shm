export interface InjectionWindowParts {
  readonly sessionId?: string;
  readonly compactCount?: number;
}

export function injectionWindowId(
  parts: InjectionWindowParts,
): string | undefined {
  const { sessionId, compactCount } = parts;
  if (typeof sessionId !== "string" || sessionId.trim() === "")
    return undefined;
  if (!Number.isInteger(compactCount) || (compactCount as number) < 0) {
    return undefined;
  }
  return `${sessionId.trim()}#${compactCount as number}`;
}
