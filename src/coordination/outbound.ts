import { gateScope, renderGateVerdict, type GateScope } from "../gate/scope.js";
import { resolveRecipient, type DirectoryEntry, type DeniedRoute, type RouteVerdict } from "./identity.js";

export interface OutboundPayload {
  readonly to: string;
  readonly text: string;
  readonly cellId?: string;
}

export interface OutboundPolicy {
  readonly name: string;
  readonly reason: string;
  readonly refuses: (payload: OutboundPayload) => string | null;
  readonly applies?: (payload: OutboundPayload) => boolean;
}

export interface OutboundOptions {
  readonly directory: readonly DirectoryEntry[];
  readonly denials?: readonly DeniedRoute[];
  readonly policies?: readonly OutboundPolicy[];
}

export interface Refusal {
  readonly policy: string;
  readonly detail: string;
  readonly reason: string;
}

export interface OutboundVerdict {
  readonly allowed: boolean;
  readonly route: RouteVerdict;
  readonly refusals: readonly Refusal[];
  readonly scope: GateScope;
  readonly verdict: string;
}

export function screenOutbound(payload: OutboundPayload, opts: OutboundOptions): OutboundVerdict {
  const policies = opts.policies ?? [];
  const route = resolveRecipient(payload.to, opts.directory, opts.denials ?? []);

  const refusals: Refusal[] = [];
  let applicable = 0;
  for (const p of policies) {
    let relevant = true;
    try {
      relevant = p.applies === undefined ? true : p.applies(payload);
    } catch (e) {
      relevant = true;
      refusals.push({
        policy: p.name,
        reason: p.reason,
        detail: `applicability check THREW (${e instanceof Error ? e.message : String(e)}) — treated as applicable and refused`,
      });
      applicable += 1;
      continue;
    }
    if (!relevant) continue;
    applicable += 1;
    try {
      const hit = p.refuses(payload);
      if (hit !== null) refusals.push({ policy: p.name, reason: p.reason, detail: hit });
    } catch (e) {
      refusals.push({
        policy: p.name,
        reason: p.reason,
        detail: `policy THREW (${e instanceof Error ? e.message : String(e)}) — a check that cannot run does not grant permission`,
      });
    }
  }

  const scope = gateScope({
    unit: "content policy",
    examined: policies.length,
    discriminating: applicable,
    discriminator: "could have refused this payload",
  });

  const allowed = route.ok && refusals.length === 0;
  const head = route.ok
    ? renderGateVerdict(refusals.length === 0, scope, { pass: "ALLOW", fail: "REFUSE" })
    : `REFUSE (route) — ${route.reason}`;
  const detail = refusals.map((r) => `  · ${r.policy}: ${r.detail} [${r.reason}]`).join("\n");

  return {
    allowed,
    route,
    refusals,
    scope,
    verdict: refusals.length === 0 ? head : `${head}\n${detail}`,
  };
}

export function assertSendable(payload: OutboundPayload, opts: OutboundOptions): OutboundVerdict {
  const v = screenOutbound(payload, opts);
  if (!v.allowed) {
    throw new Error(`refusing to send to ${JSON.stringify(payload.to)}:\n${v.verdict}`);
  }
  if (!v.scope.conclusive) {
    throw new Error(
      `refusing to send to ${JSON.stringify(payload.to)}: no content policy could have refused this payload — ` +
        `${v.scope.note}. An unscreened send is not a cleared one.`,
    );
  }
  return v;
}
