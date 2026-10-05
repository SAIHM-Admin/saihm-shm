export const COMPACT_MARKER = '"subtype":"compact_boundary"';

export const MACHINE_AUTHORED_PREFIXES: readonly string[] = [
  "This session is being continued from a previous conversation that ran out of context",
  "Caveat: The messages below",
];

export function isMachineAuthoredPrompt(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.startsWith("<")) return true;
  if (t.includes("<local-command-") || t.includes("<system-reminder>")) return true;
  return MACHINE_AUTHORED_PREFIXES.some((pre) => t.startsWith(pre));
}

export type PromptSource = "cli" | "sdk" | "other";

export function classifyPromptSource(record: Readonly<Record<string, unknown>>): PromptSource {
  if (record["promptSource"] === "sdk" || record["entrypoint"] === "sdk-cli") return "sdk";
  if (record["entrypoint"] === "cli") return "cli";
  return "other";
}
