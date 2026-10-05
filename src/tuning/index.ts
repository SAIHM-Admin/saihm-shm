export { sampleBias, splitHoldout, stratifiedSample } from "./holdout.js";
export type {
  Holdout,
  HoldoutOptions,
  SampleBias,
  SampleResult,
  StratumBalance,
  StratumDeviation,
} from "./holdout.js";
export { pairedCompare } from "./paired.js";
export type { PairedComparison } from "./paired.js";
export { composeLeverStack, DEFAULT_RERANK_BODY_WINDOW } from "./lever_stack.js";
export type { BodyWindowSource, LeverStack, LeverStackDeps } from "./lever_stack.js";
