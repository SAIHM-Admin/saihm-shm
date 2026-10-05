import { performance } from "node:perf_hooks";
import type { Answerer, AnswerContext, AnswerRequest, RawAnswer } from "./types.js";

export type CompleteFn = (prompt: string) => Promise<string>;

export type AnswerOutcome = "answered" | "abstained" | "malformed-parse" | "backend-error";

export interface AnswerTiming {
  readonly outcome: AnswerOutcome;
  readonly completeMs: number;
  readonly parseMs: number;
  readonly totalMs: number;
}

export interface StructuredAnswererConfig {
  readonly modelId: string;
  readonly onTiming?: (t: AnswerTiming) => void;
}

const MALFORMED: RawAnswer = Object.freeze({
  text: "",
  abstained: false,
  confidence: Number.NaN,
  citedCellIds: Object.freeze<string[]>([]),
});

const JSON_INSTRUCTION =
  "\n\nRespond with ONLY a single JSON object and nothing else — no prose, no " +
  "markdown, no code fence. It must have EXACTLY these keys:\n" +
  '{"text": string, "abstained": boolean, "confidence": number, "citedCellIds": string[]}\n' +
  '- "text": the answer grounded in the retrieved memory, or "" if you abstain.\n' +
  '- "abstained": true iff the retrieved memory does not answer the question.\n' +
  '- "confidence": your calibrated confidence as a number in [0,1].\n' +
  '- "citedCellIds": the cell ids you used, each copied VERBATIM from a cell=... ' +
  "marker above; cite only ids shown there, or [] if abstaining.";

export function formatAnswerPrompt(ctx: AnswerContext): string {
  return ctx.prompt + JSON_INSTRUCTION;
}

export class StructuredAnswerer implements Answerer {
  constructor(
    private readonly complete: CompleteFn,
    private readonly cfg: StructuredAnswererConfig,
  ) {}

  get modelId(): string {
    return this.cfg.modelId;
  }

  async answer(req: AnswerRequest): Promise<RawAnswer> {
    const prompt = formatAnswerPrompt(req.context);
    const t0 = performance.now();
    let completion: string;
    try {
      completion = await this.complete(prompt);
    } catch {
      const t = performance.now();
      this.emit({ outcome: "backend-error", completeMs: t - t0, parseMs: 0, totalMs: t - t0 });
      return MALFORMED;
    }
    const t1 = performance.now();
    const { raw, outcome } = parseStructured(completion);
    const t2 = performance.now();
    this.emit({ outcome, completeMs: t1 - t0, parseMs: t2 - t1, totalMs: t2 - t0 });
    return raw;
  }

  private emit(t: AnswerTiming): void {
    this.cfg.onTiming?.(t);
  }
}

interface Parsed {
  readonly raw: RawAnswer;
  readonly outcome: AnswerOutcome;
}
const MALFORMED_PARSED: Parsed = { raw: MALFORMED, outcome: "malformed-parse" };

function parseStructured(s: unknown): Parsed {
  if (typeof s !== "string") return MALFORMED_PARSED;
  const obj = extractJsonObject(s);
  if (obj === undefined) return MALFORMED_PARSED;

  const { text, abstained, confidence, citedCellIds } = obj as Record<string, unknown>;
  if (typeof text !== "string") return MALFORMED_PARSED;
  if (typeof abstained !== "boolean") return MALFORMED_PARSED;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return MALFORMED_PARSED;
  }
  if (!Array.isArray(citedCellIds) || !citedCellIds.every((c) => typeof c === "string")) {
    return MALFORMED_PARSED;
  }
  const raw: RawAnswer = { text, abstained, confidence, citedCellIds: citedCellIds as string[] };
  return { raw, outcome: abstained ? "abstained" : "answered" };
}

function extractJsonObject(s: string): object | undefined {
  const trimmed = s.trim();
  for (const cand of [trimmed, stripFence(trimmed), braceSpan(trimmed)]) {
    if (cand === undefined) continue;
    const v = tryParse(cand);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v;
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function stripFence(s: string): string | undefined {
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  return m ? m[1]! : undefined;
}

function braceSpan(s: string): string | undefined {
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  return i >= 0 && j > i ? s.slice(i, j + 1) : undefined;
}
