export interface GateScope {
  readonly unit: string;
  readonly examined: number;
  readonly discriminating: number;
  readonly conclusive: boolean;
  readonly note: string;
}

export interface GateScopeInput {
  readonly unit: string;
  readonly examined: number;
  readonly discriminating: number;
  readonly discriminator: string;
}

const count = (n: number, what: string): number => {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${what} must be a non-negative integer, got ${String(n)}`);
  }
  return n;
};

export function gateScope(input: GateScopeInput): GateScope {
  const examined = count(input.examined, "examined");
  const discriminating = count(input.discriminating, "discriminating");
  const unit = input.unit.trim();
  const discriminator = input.discriminator.trim();
  if (unit.length === 0) throw new RangeError("gateScope: unit must be a non-empty name");
  if (discriminator.length === 0) throw new RangeError("gateScope: discriminator must be stated");
  if (discriminating > examined) {
    throw new RangeError(
      `gateScope: discriminating (${discriminating}) exceeds examined (${examined}) — the gate has ` +
        `miscounted its own scope, so its verdict cannot be trusted either`,
    );
  }

  const conclusive = examined > 0 && discriminating > 0;
  const note = conclusive
    ? `conclusive: ${discriminating} of ${examined} ${unit} ${discriminator}`
    : examined === 0
      ? `VACUOUS: examined 0 ${unit} — the gate ranged over nothing, so its verdict is about the absence of input`
      : `VACUOUS: 0 of ${examined} ${unit} ${discriminator} — NOTHING PRESENT COULD HAVE PRODUCED THE OPPOSITE VERDICT, so this reports the shape of the input, not a property of what was tested`;

  return { unit, examined, discriminating, conclusive, note };
}

export interface VerdictLabels {
  readonly pass: string;
  readonly fail: string;
}

const DEFAULT_LABELS: VerdictLabels = { pass: "PASS", fail: "FAIL" };

export function renderGateVerdict(
  pass: boolean,
  scope: GateScope,
  labels: VerdictLabels = DEFAULT_LABELS,
): string {
  if (!scope.conclusive) return `VACUOUS (verdict withheld) — ${scope.note}`;
  return `${pass ? labels.pass : labels.fail} — ${scope.note}`;
}

export function requireConclusive(scope: GateScope, context: string): void {
  if (scope.conclusive) return;
  throw new Error(
    `${context}: refusing to act on a vacuous gate — ${scope.note}. Either widen the input until ` +
      `something could fail, or record this as UNTESTED rather than as a pass.`,
  );
}
