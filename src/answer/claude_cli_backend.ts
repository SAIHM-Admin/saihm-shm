import { spawn } from "node:child_process";
import type { CompleteFn } from "./structured_answerer.js";

export interface ClaudeCliConfig {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly maxBufferBytes?: number;
}

export function claudeCliComplete(cfg: ClaudeCliConfig = {}): CompleteFn {
  const command = cfg.command ?? "claude";
  const prefix = cfg.commandArgs ?? [];
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  const maxBuffer = cfg.maxBufferBytes ?? 4_000_000;
  const modelArgs = cfg.model ? ["--model", cfg.model] : [];

  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const args = [...prefix, ...modelArgs, "--print", "--output-format", "text"];
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });

      const { stdin, stdout, stderr } = child;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      timer = setTimeout(
        () =>
          settle(() => {
            child.kill("SIGKILL");
            reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
          }),
        timeoutMs,
      );

      if (!stdin || !stdout || !stderr) {
        settle(() => {
          child.kill("SIGKILL");
          reject(new Error("claude CLI: missing stdio pipes"));
        });
        return;
      }

      let out = "";
      let err = "";
      let outBytes = 0;
      child.on("error", (e) =>
        settle(() => reject(new Error(`claude CLI spawn failed: ${String(e)}`))),
      );
      stdout.on("data", (d: Buffer) => {
        outBytes += d.length;
        if (outBytes > maxBuffer) {
          settle(() => {
            child.kill("SIGKILL");
            reject(new Error("claude CLI output exceeded maxBuffer"));
          });
          return;
        }
        out += d.toString("utf8");
      });
      stderr.on("data", (d: Buffer) => {
        err += d.toString("utf8");
      });
      child.on("close", (code) =>
        settle(() => {
          if (code === 0) resolve(out.trim());
          else reject(new Error(`claude CLI exited ${String(code)}: ${err.slice(0, 500)}`));
        }),
      );

      stdin.on("error", () => {});
      stdin.end(prompt, "utf8");
    });
}
