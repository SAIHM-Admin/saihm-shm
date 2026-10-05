export {
  ProactiveInjector,
  DEFAULT_INJECTION_BUDGET,
  defaultCueDeriver,
  estimateTokens,
} from "./proactive_injector.js";
export type {
  TokenEstimate,
  InjectionBudget,
  InjectedMemory,
  InjectionDrop,
  InjectionResult,
  CueDeriver,
} from "./proactive_injector.js";

export { selectNovel } from "./novelty.js";
export type {
  InjectionCandidate,
  InjectionHistory,
  NoveltyDecision,
  SuppressedCandidate,
  SuppressionReason,
} from "./novelty.js";

export { injectionWindowId } from "./window.js";
export type { InjectionWindowParts } from "./window.js";

export { classifyInjection, injectionFiringRate } from "./outcome.js";

export { deriveActionCue, DEFAULT_ACTION_CUE } from "./action_cue.js";
export type { ActionCueOptions, PendingAction } from "./action_cue.js";
export type { InjectionStage, InjectionCounts, InjectionOutcome } from "./outcome.js";
