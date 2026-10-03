import { spawn } from "node:child_process";

export function captureHelper(path: string, args: string[]) {
  const child = spawn(path, args, {
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
    env: { ...process.env, DICTADUO_CAPTURE_PARENT_PID: String(process.pid) },
  });
  // Failure is reported through completion; no rejected promise can go unobserved during startup.
  const completion = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  child.stdin.on("error", () => {});
  let killing: Promise<void> | undefined;
  return {
    child,
    completion,
    kill: () =>
      (killing ??= (async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 500);
        try {
          await completion;
        } finally {
          clearTimeout(timer);
        }
      })()),
  };
}
