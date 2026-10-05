import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function sourceFilesUnder(dir: string, filter: (p: string) => boolean = (p) => p.endsWith(".ts")): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (filter(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function fingerprintSources(files: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    h.update(f);
    h.update("\0");
    try {
      h.update(readFileSync(f));
    } catch {
      h.update(`<MISSING ${statSync(f, { throwIfNoEntry: false }) ? "UNREADABLE" : "ABSENT"}>`);
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export interface BuildMismatch {
  readonly running: string;
  readonly onDisk: string;
  readonly message: string;
}

export function compareBuild(running: string | undefined, onDisk: string): BuildMismatch | undefined {
  if (running === onDisk) return undefined;
  return {
    running: running ?? "(not reported)",
    onDisk,
    message:
      running === undefined
        ? `the running process reports no build fingerprint, so it predates this check — restart it before trusting a feature-dependent result (disk is ${onDisk})`
        : `the running process started from sources ${running}, but disk is now ${onDisk} — restart it, or its behaviour is the OLD code regardless of what the file says`,
  };
}
