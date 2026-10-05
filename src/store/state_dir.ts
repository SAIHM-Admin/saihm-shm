import { statSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";

export interface StateDirExposure {
  readonly mode: number;
  readonly othersWritable: boolean;
  readonly groupWritable: boolean;
  readonly ownedByAnother: boolean;
}

export function stateDirExposure(st: { readonly mode: number; readonly uid: number }, uid: number | undefined): StateDirExposure {
  const mode = st.mode & 0o7777;
  if (uid === undefined) return { mode, othersWritable: false, groupWritable: false, ownedByAnother: false };
  return { mode, othersWritable: (mode & 0o002) !== 0, groupWritable: (mode & 0o020) !== 0, ownedByAnother: st.uid !== uid && st.uid !== 0 };
}

export class StateDirExposedError extends Error {
  constructor(readonly dir: string, readonly mode: number, what: string) {
    super(
      `${what}: ${dir} is writable by every local account (mode ${mode.toString(8).padStart(4, "0")}) — anyone on this machine could replace or remove ` +
        "what is kept there, a store's key included. Give it a directory of its own (the package creates it owner-only), or close this one (chmod o-w).",
    );
    this.name = "StateDirExposedError";
  }
}

const posixUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export function inspectStateDir(dir: string): StateDirExposure | undefined {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return undefined;
  }
  return st.isDirectory() ? stateDirExposure(st, posixUid()) : undefined;
}

export function assertStateDir(what: string, dir: string): void {
  const e = inspectStateDir(dir);
  if (e?.othersWritable === true) throw new StateDirExposedError(dir, e.mode, what);
}

export async function ensureStateDir(what: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const e = stateDirExposure(await stat(dir), posixUid());
  if (e.othersWritable) throw new StateDirExposedError(dir, e.mode, what);
}
