export function requireDir(store: string, dir: unknown): string {
  if (typeof dir !== "string" || dir.length === 0) {
    const got = dir === undefined ? "undefined" : JSON.stringify(dir);
    throw new TypeError(
      `${store}: \`dir\` must be a non-empty path, got ${got} — the store's artifact directory. ` +
        "Without it the first save() would throw on the erasure path instead of here.",
    );
  }
  return dir;
}
