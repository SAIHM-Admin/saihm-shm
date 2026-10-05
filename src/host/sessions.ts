import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, sep } from "node:path";

export interface SessionRef {
  readonly sessionId?: string;
  readonly transcriptPath?: string;
}

export type SessionAdmission = (event: SessionRef) => boolean;

export const ALL_SESSIONS: SessionAdmission = () => true;

export function sessionsUnder(transcriptDir: string): SessionAdmission {
  return (event) => {
    try {
      const { sessionId, transcriptPath } = event;
      if (sessionId === undefined || transcriptPath === undefined) return false;
      if (!isAbsolute(transcriptPath) || basename(transcriptPath) !== `${sessionId}.jsonl`) return false;
      if (normalize(transcriptPath) !== transcriptPath) return false;
      if (!transcriptPath.endsWith(`${sep}${sessionId}.jsonl`)) return false;
      let present: ReturnType<typeof lstatSync> | undefined;
      try { present = lstatSync(transcriptPath); } catch { present = undefined; }
      if (present !== undefined && !present.isFile()) return false;
      return realpathSync(dirname(transcriptPath)) === realpathSync(transcriptDir);
    } catch {
      return false;
    }
  };
}
