export const MAX_SOCKET_PATH_BYTES = 103;

export function socketPathProblem(path: string): string | undefined {
  const nul = path.indexOf("\0");
  if (nul !== -1) {
    const at = Buffer.byteLength(path.slice(0, nul), "utf8");
    return `socketPath contains a NUL byte at byte ${at} of ${Buffer.byteLength(path, "utf8")} bytes — the runtime would cut the path there`;
  }
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    return `socketPath is ${bytes} bytes; a unix socket path may hold at most ${MAX_SOCKET_PATH_BYTES} — the runtime can cut a longer one short without an error`;
  }
  return undefined;
}
