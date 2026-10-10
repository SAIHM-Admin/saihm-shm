import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

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

async function load(): Promise<LoadedTransformers> {
  if (ortRuntime() === "native") {
    return { lib: await import("@huggingface/transformers"), runtime: "native", modelOptions: {} };
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
  return {
    lib: await import("@huggingface/transformers"),
    runtime: "wasm",
    modelOptions: { device: "auto", session_options: { executionProviders: ["wasm"] } },
  };
}
