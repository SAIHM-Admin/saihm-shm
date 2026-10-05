export interface NumberClaim {
  readonly label: string;
  readonly locate: RegExp;
  readonly derived: number;
  readonly tolerance: number;
  readonly source: string;
}

export type NumberVerdict =
  | { readonly kind: "ok"; readonly label: string; readonly stated: number; readonly derived: number }
  | { readonly kind: "drift"; readonly label: string; readonly stated: number; readonly derived: number; readonly source: string }
  | { readonly kind: "absent"; readonly label: string; readonly source: string };

export interface DriftReport {
  readonly verdicts: readonly NumberVerdict[];
  readonly drifted: readonly NumberVerdict[];
  readonly uncovered: number;
  readonly covered: number;
  readonly note: string;
}

const NUMERIC = /(?<![\w.\-/])\d*\.\d+(?![\w]|\.\d)/g;

export function checkNumbers(memoryText: string, claims: readonly NumberClaim[]): DriftReport {
  const verdicts: NumberVerdict[] = [];
  for (const c of claims) {
    if (c.source.trim() === "") throw new Error(`claim ${c.label} states no derivation`);
    if (!(c.tolerance >= 0)) throw new Error(`claim ${c.label} has a negative or NaN tolerance`);
    const m = c.locate.exec(memoryText);
    c.locate.lastIndex = 0;
    if (m?.[1] === undefined) {
      verdicts.push({ kind: "absent", label: c.label, source: c.source });
      continue;
    }
    const stated = Number(m[1]);
    if (!Number.isFinite(stated)) {
      verdicts.push({ kind: "absent", label: c.label, source: c.source });
      continue;
    }
    verdicts.push(
      Math.abs(stated - c.derived) <= c.tolerance
        ? { kind: "ok", label: c.label, stated, derived: c.derived }
        : { kind: "drift", label: c.label, stated, derived: c.derived, source: c.source },
    );
  }
  const total = (memoryText.match(NUMERIC) ?? []).length;
  const covered = verdicts.filter((v) => v.kind !== "absent").length;
  const drifted = verdicts.filter((v) => v.kind !== "ok");
  return {
    verdicts,
    drifted,
    covered,
    uncovered: Math.max(0, total - covered),
    note:
      `${covered} of ${total} decimal figures are re-derived; ${Math.max(0, total - covered)} are not checked by anything. ` +
      (drifted.length === 0
        ? "No drift among the checked ones — which is a statement about those, not about the memory."
        : `${drifted.length} DRIFTED or went ABSENT.`),
  };
}

export function renderDrift(r: DriftReport): string {
  if (r.verdicts.length === 0) return `VACUOUS — no claims supplied, so nothing could have failed. ${r.note}`;
  const lines = r.drifted.map((v) => {
    if (v.kind === "absent") {
      return `  ABSENT  ${v.label} — its anchor is no longer in the memory; the check has stopped checking (${v.source})`;
    }
    if (v.kind === "drift") {
      return `  DRIFT   ${v.label}: memory says ${v.stated}, source says ${v.derived} (${v.source})`;
    }
    return `  ${v.label}`;
  });
  return [r.drifted.length === 0 ? "no drift" : "MEMORY DISAGREES WITH ITS SOURCES", ...lines, `  ${r.note}`].join("\n");
}
