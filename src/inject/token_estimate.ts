export type TokenEstimate = (text: string) => number;

export const estimateTokens: TokenEstimate = (text) => Math.ceil(text.length / 4);
