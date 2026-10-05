#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runHostHook, type HostHookTarget } from "./client.js";

async function main(): Promise<void> {
  let values: { port?: string; socket?: string; "off-file"?: string; "timeout-ms"?: string; path?: string; "project-dir"?: string };
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        socket: { type: "string" },
        "off-file": { type: "string" },
        "timeout-ms": { type: "string" },
        path: { type: "string" },
        "project-dir": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    return;
  }
  if ((values.socket === undefined) === (values.port === undefined)) return;
  if (values["project-dir"] === undefined || values["project-dir"] === "") return;
  const target: HostHookTarget = values.socket !== undefined ? { socketPath: values.socket } : { port: Number(values.port) };
  await runHostHook({
    target,
    projectDir: values["project-dir"],
    input: process.stdin,
    output: process.stdout,
    ...(values["off-file"] !== undefined ? { offFile: values["off-file"] } : {}),
    ...(values["timeout-ms"] !== undefined ? { timeoutMs: Number(values["timeout-ms"]) } : {}),
    ...(values.path !== undefined ? { path: values.path } : {}),
  });
  process.stdin.destroy();
}

main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
