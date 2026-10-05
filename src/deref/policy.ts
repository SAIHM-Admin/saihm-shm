import { promises as fs } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface DerefRoot {
  readonly name: string;
  readonly path: string;
}

export type RefusalReason =
  | "absolute-path"
  | "bare-name"
  | "ambiguous-name"
  | "no-stem"
  | "extension"
  | "denied-name"
  | "escapes-root"
  | "not-found"
  | "not-a-file"
  | "too-large"
  | "unreadable";

export interface Refusal {
  readonly token: string;
  readonly reason: RefusalReason;
}

export interface ResolvedFile {
  readonly token: string;
  readonly path: string;
  readonly root: string;
  readonly relPath: string;
  readonly bytes: number;
}

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface FileSystemSeam {
  realpath(p: string): Promise<string>;
  sizeOfFile(p: string): Promise<number | undefined>;
  read(p: string): Promise<string>;
  listDir?(p: string): Promise<readonly DirEntry[]>;
}

export const nodeFileSystem: FileSystemSeam = {
  realpath: (p) => fs.realpath(p),
  async sizeOfFile(p) {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : undefined;
  },
  read: (p) => fs.readFile(p, "utf8"),
  async listDir(p) {
    const ents = await fs.readdir(p, { withFileTypes: true });
    return ents.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isSymbolicLink: e.isSymbolicLink(),
    }));
  },
};

export interface PolicyConfig {
  readonly extensions: readonly string[];
  readonly maxFileBytes: number;
  readonly deniedSegments?: readonly string[];
  readonly deniedNamePatterns?: readonly RegExp[];
}

export interface PolicyDescription {
  readonly extensions: readonly string[];
  readonly maxFileBytes: number;
  readonly deniedSegments: {
    readonly builtIn: readonly string[];
    readonly extra: readonly string[];
    readonly effective: readonly string[];
  };
  readonly deniedNamePatterns: {
    readonly builtIn: readonly string[];
    readonly extra: readonly string[];
    readonly effective: readonly string[];
  };
}

export const DEFAULT_POLICY: PolicyConfig = {
  extensions: ["md", "ts", "json"],
  maxFileBytes: 256 * 1024,
};

const DENIED_SEGMENT_PREFIXES: readonly string[] = [".saihm"];

const DENIED_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".gnupg",
  ".aws",
  "node_modules",
  ".shm_store",
]);

const DENIED_NAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /master_secret/i,
  /secret/i,
  /credential/i,
  /\.(pem|key|p12|pfx|crt|keystore)$/i,
  /\.local\.[^./]+$/i,
];

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

function screenToken(token: string, cfg: PolicyConfig): RefusalReason | undefined {
  if (isAbsolute(token) || token.startsWith("/")) return "absolute-path";
  const segments = token.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (name.indexOf(".") <= 0) return "no-stem";
  if (deniedByName(segments, cfg)) return "denied-name";
  if (segments.length === 1) return "bare-name";
  const ext = extensionOf(name);
  if (ext === undefined || !cfg.extensions.includes(ext)) return "extension";
  return undefined;
}

function isDeniedSegment(name: string, cfg: PolicyConfig): boolean {
  const lower = name.toLowerCase();
  if (DENIED_SEGMENTS.has(lower) || DENIED_SEGMENT_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return cfg.deniedSegments?.some((d) => d.toLowerCase() === lower) ?? false;
}

export function isDeniedName(name: string, cfg: PolicyConfig): boolean {
  if (DENIED_NAME_PATTERNS.some((re) => re.test(name))) return true;
  const extra = cfg.deniedNamePatterns;
  if (extra === undefined) return false;
  return extra.some((re) => {
    if (re.flags.includes("g") || re.flags.includes("y")) {
      return new RegExp(re.source, re.flags.replace(/[gy]/g, "")).test(name);
    }
    return re.test(name);
  });
}

function deniedByName(segments: readonly string[], cfg: PolicyConfig): boolean {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (isDeniedSegment(s, cfg)) return true;
    if (i === segments.length - 1 && isDeniedName(s, cfg)) return true;
  }
  return false;
}

export function describePolicy(cfg: PolicyConfig): PolicyDescription {
  const builtInSegs = [...DENIED_SEGMENTS, ...DENIED_SEGMENT_PREFIXES.map((p) => `${p}*`)].sort();
  const extraSegs = [...(cfg.deniedSegments ?? [])].map((s) => s.toLowerCase()).sort();
  const builtInPats = DENIED_NAME_PATTERNS.map((re) => String(re));
  const extraPats = (cfg.deniedNamePatterns ?? []).map((re) => String(re));
  return {
    extensions: [...cfg.extensions],
    maxFileBytes: cfg.maxFileBytes,
    deniedSegments: {
      builtIn: builtInSegs,
      extra: extraSegs,
      effective: [...new Set([...builtInSegs, ...extraSegs])].sort(),
    },
    deniedNamePatterns: {
      builtIn: builtInPats,
      extra: extraPats,
      effective: [...builtInPats, ...extraPats],
    },
  };
}

export function isContained(realRoot: string, realCandidate: string): boolean {
  if (realCandidate === realRoot) return true;
  return realCandidate.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

export interface PreparedRoot {
  readonly name: string;
  readonly realPath: string;
}

export async function resolveRoots(
  roots: readonly DerefRoot[],
  fsSeam: FileSystemSeam,
): Promise<PreparedRoot[]> {
  const out: PreparedRoot[] = [];
  for (const root of roots) {
    try {
      out.push({ name: root.name, realPath: await fsSeam.realpath(resolve(root.path)) });
    } catch {
    }
  }
  return out;
}

export async function resolveToken(
  token: string,
  roots: readonly PreparedRoot[],
  cfg: PolicyConfig,
  fsSeam: FileSystemSeam,
  index?: RootIndex,
): Promise<ResolvedFile | Refusal> {
  const screened = screenToken(token, cfg);
  if (screened === "bare-name" && index !== undefined) {
    return await resolveByIndex(token, cfg, fsSeam, index);
  }
  if (screened !== undefined) return { token, reason: screened };

  let sawExisting = false;
  for (const root of roots) {
    const realRoot = root.realPath;
    const candidate = normalize(join(realRoot, token));
    let realCandidate: string;
    try {
      realCandidate = await fsSeam.realpath(candidate);
    } catch {
      continue;
    }
    sawExisting = true;
    if (!isContained(realRoot, realCandidate)) continue;
    return await admitCandidate(token, root, realCandidate, cfg, fsSeam);
  }
  return { token, reason: sawExisting ? "escapes-root" : "not-found" };
}

async function admitCandidate(
  token: string,
  root: PreparedRoot,
  realCandidate: string,
  cfg: PolicyConfig,
  fsSeam: FileSystemSeam,
): Promise<ResolvedFile | Refusal> {
  const rel = relative(root.realPath, realCandidate);
  if (deniedByName(rel.split(sep), cfg)) return { token, reason: "denied-name" };
  const ext = extensionOf(realCandidate);
  if (ext === undefined || !cfg.extensions.includes(ext)) return { token, reason: "extension" };

  const size = await fsSeam.sizeOfFile(realCandidate);
  if (size === undefined) return { token, reason: "not-a-file" };
  if (size > cfg.maxFileBytes) return { token, reason: "too-large" };

  return { token, path: realCandidate, root: root.name, relPath: rel, bytes: size };
}

async function resolveByIndex(
  token: string,
  cfg: PolicyConfig,
  fsSeam: FileSystemSeam,
  index: RootIndex,
): Promise<ResolvedFile | Refusal> {
  if (index.truncated) return { token, reason: "bare-name" };
  const entries = index.byName.get(token);
  if (entries === undefined || entries.length === 0) {
    const ext = extensionOf(token);
    if (ext === undefined || !cfg.extensions.includes(ext)) return { token, reason: "extension" };
    return { token, reason: "bare-name" };
  }

  if (entries.length === 1) {
    const only = entries[0]!;
    let real: string;
    try {
      real = await fsSeam.realpath(only.path);
    } catch {
      return { token, reason: "not-found" };
    }
    if (!isContained(only.root.realPath, real)) return { token, reason: "escapes-root" };
    return await admitCandidate(token, only.root, real, cfg, fsSeam);
  }

  const distinct = new Map<string, IndexEntry>();
  for (const e of entries) {
    try {
      const real = await fsSeam.realpath(e.path);
      if (!isContained(e.root.realPath, real)) continue;
      if (!distinct.has(real)) distinct.set(real, e);
    } catch {
      continue;
    }
  }
  if (distinct.size === 0) return { token, reason: "not-found" };
  if (distinct.size > 1) return { token, reason: "ambiguous-name" };
  const [real, entry] = [...distinct.entries()][0]!;
  return await admitCandidate(token, entry.root, real, cfg, fsSeam);
}

export function isRefusal(x: ResolvedFile | Refusal): x is Refusal {
  return (x as Refusal).reason !== undefined;
}

export interface IndexEntry {
  readonly path: string;
  readonly root: PreparedRoot;
}

export interface RootIndex {
  readonly byName: ReadonlyMap<string, readonly IndexEntry[]>;
  readonly filesIndexed: number;
  readonly dirsWalked: number;
  readonly truncated: boolean;
}

export interface RootIndexConfig {
  readonly maxDepth: number;
  readonly maxFiles: number;
}

export const DEFAULT_ROOT_INDEX: RootIndexConfig = { maxDepth: 8, maxFiles: 20000 };

export async function buildRootIndex(
  roots: readonly PreparedRoot[],
  cfg: PolicyConfig,
  fsSeam: FileSystemSeam,
  idxCfg: RootIndexConfig = DEFAULT_ROOT_INDEX,
): Promise<RootIndex | undefined> {
  const listDir = fsSeam.listDir;
  if (listDir === undefined) return undefined;

  const byName = new Map<string, IndexEntry[]>();
  const visited = new Set<string>();
  let filesIndexed = 0;
  let dirsWalked = 0;
  let truncated = false;

  const walk = async (root: PreparedRoot, dir: string, depth: number): Promise<void> => {
    if (truncated || depth > idxCfg.maxDepth) return;
    if (visited.has(dir)) return;
    visited.add(dir);
    let ents: readonly DirEntry[];
    try {
      ents = await listDir(dir);
    } catch {
      return;
    }
    dirsWalked++;
    for (const e of ents) {
      if (truncated) return;
      if (isDeniedSegment(e.name, cfg)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory) {
        if (e.isSymbolicLink) {
          let realDir: string;
          try {
            realDir = await fsSeam.realpath(p);
          } catch {
            continue;
          }
          if (!isContained(root.realPath, realDir)) continue;
          if (visited.has(realDir)) continue;
          visited.add(realDir);
        }
        await walk(root, p, depth + 1);
        continue;
      }
      const ext = extensionOf(e.name);
      if (ext === undefined || !cfg.extensions.includes(ext)) continue;
      if (isDeniedName(e.name, cfg)) continue;
      if (filesIndexed >= idxCfg.maxFiles) {
        truncated = true;
        return;
      }
      let list = byName.get(e.name);
      if (list === undefined) {
        list = [];
        byName.set(e.name, list);
      }
      list.push({ path: p, root });
      filesIndexed++;
    }
  };

  for (const root of roots) await walk(root, root.realPath, 0);
  return { byName, filesIndexed, dirsWalked, truncated };
}
