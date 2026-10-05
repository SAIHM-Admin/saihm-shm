export interface WithdrawnClaim {
  readonly value: string;
  readonly mustAccompany: readonly string[];
  readonly permittedWith?: readonly string[];
  readonly reason: string;
  readonly withdrawnOn: string;
  readonly replacement?: string;
}

export interface Requotation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly claim: WithdrawnClaim;
}

const WITHDRAWAL_CONTEXT =
  /~~|withdraw|WITHDRAWN|retract|superseded|no longer|corrected|CORRECTION|\bwas wrong\b|\bREFUTED\b|\bFALSE\b|stays withdrawn|never re-quote|previously (read|said|reported)|used to (read|be|say)/i;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findRequotations(
  file: string,
  text: string,
  register: readonly WithdrawnClaim[],
): Requotation[] {
  const out: Requotation[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (WITHDRAWAL_CONTEXT.test(line)) continue;
    for (const claim of register) {
      const isNumeric = /^[\d.]+$/.test(claim.value);
      const hit = isNumeric
        ? new RegExp(`(?<![\\d.])${escape(claim.value)}(?![\\d])`).test(line)
        : line.toLowerCase().includes(claim.value.toLowerCase());
      if (!hit) continue;
      const lower = line.toLowerCase();
      if (!claim.mustAccompany.some((t) => lower.includes(t.toLowerCase()))) continue;
      if (claim.permittedWith?.some((t) => lower.includes(t.toLowerCase()))) continue;
      out.push({ file, line: i + 1, text: line.trim(), claim });
    }
  }
  return out;
}

export function validateRegister(register: readonly WithdrawnClaim[]): void {
  for (const c of register) {
    if (c.value.trim() === "") throw new Error("a withdrawn claim needs the value it published");
    if (c.mustAccompany.length === 0) {
      throw new Error(`withdrawn claim ${c.value} names no companion token — a bare number is not identifiable`);
    }
    if (c.reason.trim() === "") throw new Error(`withdrawn claim ${c.value} states no reason`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.withdrawnOn)) {
      throw new Error(`withdrawn claim ${c.value} needs an ISO withdrawal date, got ${c.withdrawnOn}`);
    }
  }
}
