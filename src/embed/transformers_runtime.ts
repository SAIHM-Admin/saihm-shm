import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureStateDir } from "../store/state_dir.js";

export type OrtRuntime = "native" | "wasm";

export interface LoadedTransformers {
  readonly lib: typeof import("@huggingface/transformers");
  readonly runtime: OrtRuntime;
  readonly modelOptions: Record<string, unknown>;
}

export type NativeProbe = (requireFromLib: NodeJS.Require) => void;

const probeNative: NativeProbe = (requireFromLib) => {
  requireFromLib("onnxruntime-node");
};

let decided: { readonly runtime: OrtRuntime; readonly nativeError?: unknown } | undefined;
let loading: Promise<LoadedTransformers> | undefined;

export function ortRuntime(probe: NativeProbe = probeNative): OrtRuntime {
  if (!decided) {
    try {
      probe(libRequire());
      decided = { runtime: "native" };
    } catch (nativeError) {
      decided = { runtime: "wasm", nativeError };
    }
  }
  return decided.runtime;
}

export function loadTransformers(): Promise<LoadedTransformers> {
  loading ??= load();
  return loading;
}

function libRequire(): NodeJS.Require {
  return createRequire(createRequire(import.meta.url).resolve("@huggingface/transformers"));
}

export async function chooseModelCacheDir(
  current: string | null | undefined,
  xdgCacheHome: string | undefined,
  home: string,
  writable: (dir: string) => Promise<boolean>,
): Promise<string | null | undefined> {
  if (typeof current !== "string" || !current.split(/[\\/]/).includes("node_modules")) return current;
  const base = xdgCacheHome && isAbsolute(xdgCacheHome) ? xdgCacheHome : home ? join(home, ".cache") : "";
  if (!base) return current;
  const dir = join(base, "shm", "models") + sep;
  return (await writable(dir)) ? dir : current;
}

async function writableDir(dir: string): Promise<boolean> {
  try {
    let d = dir.replace(/[\\/]+$/, "");
    while (!existsSync(d)) {
      if (dirname(d) === d) return false;
      d = dirname(d);
    }
    accessSync(d, constants.W_OK);
    await ensureStateDir("the model cache", dir);
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function placeModelCache(lib: typeof import("@huggingface/transformers")): Promise<void> {
  lib.env.cacheDir = (await chooseModelCacheDir(lib.env.cacheDir, process.env.XDG_CACHE_HOME, homedir(), writableDir)) ?? null;
}

async function load(): Promise<LoadedTransformers> {
  if (ortRuntime() === "native") {
    const lib = await import("@huggingface/transformers");
    await placeModelCache(lib);
    return { lib, runtime: "native", modelOptions: {} };
  }
  const requireFromLib = libRequire();
  const nativeError = decided?.nativeError;
  const ORT = Symbol.for("onnxruntime");
  const g = globalThis as Record<symbol, unknown>;
  if (!(ORT in g)) {
    const ort = requireFromLib("onnxruntime-web") as { env: { wasm: { wasmPaths?: unknown } } };
    ort.env.wasm.wasmPaths = pathToFileURL(dirname(requireFromLib.resolve("onnxruntime-web")) + "/").href;
    g[ORT] = ort;
    const nodePath = requireFromLib.resolve("onnxruntime-node");
    const Module = requireFromLib("node:module") as new (id: string) => NodeJS.Module;
    const m = new Module(nodePath);
    m.filename = nodePath;
    m.loaded = true;
    m.exports = ort;
    requireFromLib.cache[nodePath] = m;
  }
  const reason = nativeError instanceof Error ? nativeError.message.split("\n")[0] : String(nativeError);
  process.emitWarning(
    `SHM: the native ONNX runtime cannot load on ${process.platform}/${process.arch} (${reason}); ` +
      "using its WebAssembly build, which is slower and keeps its own index.",
    { code: "SHM_ORT_WASM" },
  );
  const lib = await import("@huggingface/transformers");
  await placeModelCache(lib);
  return {
    lib,
    runtime: "wasm",
    modelOptions: { device: "auto", session_options: { executionProviders: ["wasm"] } },
  };
}
