import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buttonPress } from "../src/capture/dji-button.ts";

test("button IPC accepts Unix timestamps and rejects stale, future and malformed events", () => {
  const now = Date.now();
  expect(buttonPress(`press 1 ${now}`, now)).toBe(1);
  expect(buttonPress(`press 2 ${now - 250}`, now)).toBe(2);
  expect(buttonPress(`press 3 ${now - 251}`, now)).toBeUndefined();
  expect(buttonPress(`press 4 ${now + 1}`, now)).toBeUndefined();
  expect(buttonPress("press 5 192086160", now)).toBeUndefined();
  expect(buttonPress(`press 9007199254740992 ${now}`, now)).toBeUndefined();
  expect(buttonPress(`release 6 ${now}`, now)).toBeUndefined();
});

test.skipIf(process.platform !== "linux" || !Bun.which("cc"))(
  "native event conversion and Bun agree on the IPC clock without opening a device",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "dictaduo-button-clock-"));
    try {
      const source = join(directory, "clock.c"),
        binary = join(directory, "clock");
      // Compile the production conversion itself; no receiver access or input injection.
      await writeFile(
        source,
        `#define main receiver_main\n#include ${JSON.stringify(resolve(import.meta.dir, "../capture/button.c"))}\n#undef main\nint main(void) {\n  struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);\n  struct input_event event = {0}; event.time.tv_sec = now.tv_sec; event.time.tv_usec = now.tv_nsec / 1000;\n  long long timestamp = event_timestamp(&event);\n  event.time.tv_sec -= 1;\n  if (event_timestamp(&event) != -1) return 2;\n  printf("press 1 %lld\\n", timestamp);\n  return 0;\n}\n`,
      );
      const compiler = Bun.spawn(
        ["cc", "-std=gnu11", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(await compiler.exited, await new Response(compiler.stderr).text()).toBe(0);
      const child = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
      const line = (await new Response(child.stdout).text()).trim();
      expect(await child.exited).toBe(0);
      expect(buttonPress(line)).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
