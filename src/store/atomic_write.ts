import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

const OWNER_ONLY = 0o600;

export interface AtomicWriteOptions {
  readonly tmpSuffix?: string;
}

const TMP_RANDOM_BYTES = 6;

export function tempNameFor(path: string, pid: number, suffix: string): string {
  return `${path}.tmp.${pid}.${suffix}`;
}

export const TEMP_NAME_OVERHEAD_MAX = tempNameFor("", 4_294_967_295, "0".repeat(TMP_RANDOM_BYTES * 2)).length;

export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  const tmp = tempNameFor(path, process.pid, opts.tmpSuffix ?? randomBytes(TMP_RANDOM_BYTES).toString("hex"));
  let created = false;
  try {
    await writeFile(tmp, data, { mode: OWNER_ONLY, flag: "wx" });
    created = true;
    await rename(tmp, path);
  } catch (e) {
    if (created || (e as NodeJS.ErrnoException).code !== "EEXIST") await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
