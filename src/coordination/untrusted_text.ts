const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\\]|(?! )\p{Zs}/gu;

export function escapeUntrusted(s: string): string {
  return s.replace(UNSAFE, (ch) =>
    ch === "\\" ? "\\\\" : `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

export function displayUntrusted(s: string, max = 96): string {
  if (!Number.isInteger(max) || max < 16) throw new RangeError(`displayUntrusted: max must be an integer >= 16, got ${max}`);
  const pieces = [...s].map(escapeUntrusted);
  const full = pieces.join("");
  if (full.length <= max) return full;
  let out = "";
  for (let i = 0; i < pieces.length; i++) {
    if (out.length + pieces[i]!.length + `…(+${pieces.length - i - 1})`.length > max) {
      return `${out}…(+${pieces.length - i})`;
    }
    out += pieces[i]!;
  }
  return out;
}
