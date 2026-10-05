export interface BehaviourMode {
  readonly id: string;
  readonly name: string;
  readonly question: string;
  readonly cues: readonly string[];
  readonly source: string;
}

export interface ModeSelection {
  readonly applied: readonly BehaviourMode[];
  readonly deferred: readonly BehaviourMode[];
  readonly costWords: number;
  readonly budgetWords: number;
}

export interface ModeSelectOptions {
  readonly budgetWords: number;
}

export function costOf(mode: BehaviourMode): number {
  return mode.question.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function questionProblem(q: string): string | undefined {
  const t = q.trim();
  if (t.length === 0) return "empty";
  if (!t.endsWith("?")) return "not a question (must end with ?)";
  if (t.slice(0, -1).includes("?")) return "more than one question";
  if (/\n/.test(t)) return "contains a line break — that is a protocol, not a question";
  if (/[.!]\s+[A-Z]/.test(t)) return "contains a sentence break — compile the mode, do not recite it";
  return undefined;
}

export function validateRegistry(modes: readonly BehaviourMode[]): void {
  const seen = new Set<string>();
  for (const m of modes) {
    if (seen.has(m.id)) throw new Error(`duplicate mode id: ${m.id}`);
    seen.add(m.id);
    const bad = questionProblem(m.question);
    if (bad !== undefined) throw new Error(`mode ${m.id}: question ${bad}`);
    if (m.cues.length === 0) throw new Error(`mode ${m.id}: no cues — it could never be selected`);
    for (const c of m.cues) {
      if (c !== c.toLowerCase()) throw new Error(`mode ${m.id}: cue "${c}" must be lowercase`);
      if (c.trim().length === 0) throw new Error(`mode ${m.id}: empty cue`);
    }
    if (m.source.trim().length === 0) throw new Error(`mode ${m.id}: no provenance`);
  }
}

function cueMatches(cue: string, hay: string): boolean {
  const esc = cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^\w/.test(cue) ? "\\b" : "";
  const right = /\w$/.test(cue) ? "\\b" : "";
  return new RegExp(`${left}${esc}${right}`).test(hay);
}

export function selectModes(
  action: string,
  registry: readonly BehaviourMode[],
  opts: ModeSelectOptions,
): ModeSelection {
  const hay = action.toLowerCase();
  const matched = registry.filter((m) => m.cues.some((c) => cueMatches(c, hay)));
  const applied: BehaviourMode[] = [];
  const deferred: BehaviourMode[] = [];
  let cost = 0;
  let full = false;
  for (const m of matched) {
    const c = costOf(m);
    if (!full && cost + c <= opts.budgetWords) {
      applied.push(m);
      cost += c;
    } else {
      full = true;
      deferred.push(m);
    }
  }
  return { applied, deferred, costWords: cost, budgetWords: opts.budgetWords };
}

export const DEFAULT_MODES: readonly BehaviourMode[] = [
  {
    id: "hostile-review",
    name: "Hostile review",
    question: "What would make this wrong?",
    cues: ["ship", "commit", "merge", "implement", "build", "fix", "refactor", "release"],
    source: "review practice: three hostile passes, for correctness, integration and specification, before a change ships",
  },
  {
    id: "decide-dont-ask",
    name: "Decide analytically",
    question: "Could I settle this by measuring instead of asking?",
    cues: ["ask", "question", "decide", "choose", "option", "which"],
    source: "decision practice: a question that a measurement can settle is not a question to ask",
  },
  {
    id: "selector-blindness",
    name: "Selector blindness",
    question: "Does my selector filter on the field the defect corrupts?",
    cues: ["audit", "scan", "select", "filter", "census", "grep", "probe", "instrument"],
    source: "measurement practice: a selector that filters on the corrupted field reports a false all-clear",
  },
  {
    id: "known-positive",
    name: "Known-positive first",
    question: "Have I seen this instrument fail on a case I know is positive?",
    cues: ["measure", "probe", "test", "gate", "verify", "control", "null", "instrument"],
    source: "measurement practice: trust an instrument only after it has failed on a planted positive",
  },
  {
    id: "denominator",
    name: "Denominator",
    question: "What is my n, and is it independent draws rather than printed rows?",
    cues: ["measure", "rate", "correlation", "percent", "recall@", "precision", "n=", "average"],
    source: "measurement practice: repeated rows from one source are not independent samples",
  },
  {
    id: "stale-value",
    name: "Staleness with authority",
    question: "Is this a stored value where it should be a pointer to a measurement?",
    cues: ["version", "status", "state", "head", "sha", "count", "resume", "claim"],
    source: "memory practice: a stored value goes stale; a pointer to its measurement does not",
  },
  {
    id: "fail-open",
    name: "Fail-open check",
    question: "If this check is misconfigured, does it fail closed or fail open?",
    cues: ["policy", "guard", "deny", "refuse", "allow", "security", "boundary", "validate"],
    source: "configuration practice: a check that fails open on a configuration error passes every test nobody wrote",
  },
  {
    id: "reader-predicate",
    name: "Writer gated on the reader",
    question: "Is the writer gated on the reader's own predicate, or merely tested against it?",
    cues: ["write", "append", "emit", "serialize", "send", "share", "publish"],
    source: "data practice: a writer gated on the reader's own predicate cannot store what the reader refuses",
  },
  {
    id: "index-budget",
    name: "Index budget",
    question: "Will this append push the always-loaded index past its silent-truncation point?",
    cues: ["memory.md", "index", "append", "remember", "memory file"],
    source: "memory practice: an always-loaded index cut at its size limit loses its last entries without warning",
  },
  {
    id: "cost-of-compliance",
    name: "Cost of compliance",
    question: "Am I judging this proactive feature on firing rate instead of what it costs to obey?",
    cues: ["proactive", "inject", "surface", "remind", "render", "hook", "firing"],
    source: "measurement practice: judge a proactive feature by what obeying it costs, not by how often it fires",
  },
];
