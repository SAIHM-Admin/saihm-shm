import { isDerivedLabel, labelOfDerived } from "../derived/codec.js";

export function retrievalText(label: string): string {
  if (!isDerivedLabel(label)) return label;
  return labelOfDerived(label) ?? label;
}
