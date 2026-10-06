import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { NativeDestinations } from "../src/native-destination.ts";
// Opt in only in a disposable test display or during an explicitly supervised desktop trial.
const nativeTest = process.env.DICTADUO_TEST_DESKTOP === "1" ? test : test.skip;
async function focusFixture(pid: number) {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  await Bun.spawn(["hyprctl", "dispatch", "focuswindow", `pid:${pid}`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  await Bun.sleep(100);
}
nativeTest(
  "Wayland typing confirms Unicode packets, guards queued edits and refuses action keys",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const entry = Bun.spawn([`${root}/.local/entry-fixture`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const destinations = new NativeDestinations();
    const reader = entry.stdout.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value).trimEnd();
    const send = async (value: string) => {
      entry.stdin.write(value + "\n");
      await entry.stdin.flush();
      await Bun.sleep(150);
      if (value === "reset") await focusFixture(entry.pid);
    };
    const capture = (method: "automatic" | "unicodeTyping" = "unicodeTyping") =>
      destinations.capture(
        `${root}/build/linux-client/dictaduo-destination`,
        String(entry.pid),
        method,
      );
    try {
      expect(await read()).toBe("ready");
      await Bun.sleep(900);
      await focusFixture(entry.pid);
      const text = "Hei æøå 👋🏽 e\u0301 👨‍👩‍👧‍👦 中文 ferdig";
      const first = await capture();
      const next = await capture();
      expect(await first.deliver(text)).toBe("inserted");
      expect(await next.deliver(" neste")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start " + text + " neste");
      for (const text of ["first\nsubmit", "first\tother"]) {
        await send("reset");
        const destination = await capture();
        expect(await destination.deliver(text)).toBe("preview");
        await send("get");
        expect(await read()).toBe("start");
      }
      await send("reset");
      await send("web");
      const web = await capture("automatic");
      expect(await web.deliver("web æøå 👋")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start web æøå 👋");
      for (const method of ["automatic", "unicodeTyping"] as const) {
        await send("reset");
        await send("select");
        const selected = await capture(method);
        expect(await selected.deliver("ny 👋🏽 tekst med flere pakker")).toBe("inserted");
        await send("get");
        expect(await read()).toBe("ny 👋🏽 tekst med flere pakkerart");
      }
      await send("textarea");
      const paragraphs = await capture("automatic");
      expect(await paragraphs.deliver("first\n\nsecond æøå 👋")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start first\n\nsecond æøå 👋");
      await send("reset");
      const stale = await capture();
      await send("other");
      expect(await stale.deliver("must not move")).toBe("preview");
      await send("reset");
      const interrupted = await capture();
      let checks = 0;
      expect(await interrupted.deliver("x".repeat(100), () => ++checks >= 5)).toBe("uncertain");
      await send("get");
      const partial = await read();
      expect(partial.startsWith("start ")).toBe(true);
      expect(partial.length).toBeGreaterThan(6);
      expect(partial.length).toBeLessThan(106);
      expect(await interrupted.deliver("x".repeat(100))).toBe("preview");
      // A backend can exit successfully without sending anything. Readback must
      // report uncertainty and never repeat it through native insertion.
      await send("reset");
      const dir = await mkdtemp(resolve(tmpdir(), "dictaduo-noop-"));
      try {
        await copyFile(
          `${root}/build/linux-client/dictaduo-destination`,
          resolve(dir, "dictaduo-destination"),
        );
        await writeFile(resolve(dir, "dictaduo-type"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", {
          mode: 0o700,
        });
        const silent = await destinations.capture(
          resolve(dir, "dictaduo-destination"),
          String(entry.pid),
          "unicodeTyping",
        );
        expect(await silent.deliver("must not retry")).toBe("uncertain");
        await send("get");
        expect(await read()).toBe("start");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      destinations.invalidate();
      entry.kill();
    }
  },
  20000,
);

nativeTest(
  "queued GTK takes preserve own insertions but reject user edits and focus changes",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const entry = Bun.spawn([`${root}/.local/entry-fixture`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const destinations = new NativeDestinations();
    const reader = entry.stdout.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value).trimEnd();
    const send = async (value: string) => {
      entry.stdin.write(value + "\n");
      await entry.stdin.flush();
      await Bun.sleep(150);
      if (value === "reset") await focusFixture(entry.pid);
    };
    let target = String(entry.pid);
    const capture = () =>
      destinations.capture(`${root}/build/linux-client/dictaduo-destination`, target);
    try {
      expect(await read()).toBe("ready");
      await Bun.sleep(900);
      await focusFixture(entry.pid);
      for (const change of [undefined, "change", "caret", "select", "other", "password"]) {
        await send("reset");
        const first = await capture();
        const second = await capture();
        const third = await capture();
        expect(await first.deliver("Hei æøå 👋 ")).toBe("inserted");
        if (change) await send(change);
        expect(await second.deliver("neste ")).toBe(change ? "preview" : "inserted");
        expect(await third.deliver("siste")).toBe(change ? "preview" : "inserted");
        expect(await first.deliver("duplicate")).toBe("preview");
        await send("get");
        expect(await read()).toBe(
          change === "change"
            ? "changed"
            : change
              ? "start Hei æøå 👋"
              : "start Hei æøå 👋 neste siste",
        );
      }
      await send("reset");
      const first = await capture();
      const cancelled = await capture();
      const last = await capture();
      cancelled.close();
      expect(await first.deliver("one ")).toBe("inserted");
      expect(await last.deliver("two")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start one two");
      // Plasma's focused-object mode shares the same continuation guard.
      target = "focused";
      await send("reset");
      const focused = await capture();
      const next = await capture();
      expect(await focused.deliver("one ")).toBe("inserted");
      expect(await next.deliver("two")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start one two");
      await send("reset");
      const stale = await capture();
      const queued = await capture();
      await send("other");
      await send("reset");
      const fresh = await capture();
      expect(await stale.deliver("stale")).toBe("preview");
      expect(await queued.deliver("stale")).toBe("preview");
      expect(await fresh.deliver("fresh")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start fresh");
      await send("reset");
      const delivering = await capture();
      const insertion = delivering.deliver("one ");
      const joining = await capture();
      expect(await insertion).toBe("inserted");
      expect(await joining.deliver("two")).toBe("inserted");
      await send("get");
      expect(await read()).toBe("start one two");
    } finally {
      destinations.invalidate();
      entry.kill();
    }
  },
  20000,
);

nativeTest(
  "real GTK field: Unicode insertion once; changed text/caret/selection/focus/password reject",
  async () => {
    const root = resolve(import.meta.dir, "../../..");
    const helper = `${root}/build/linux-client/dictaduo-destination`;
    const entry = Bun.spawn([`${root}/.local/entry-fixture`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = entry.stdout.getReader();
    const read = async () => new TextDecoder().decode((await reader.read()).value).trimEnd();
    const send = async (value: string) => {
      entry.stdin.write(value + "\n");
      await entry.stdin.flush();
      await Bun.sleep(150);
      if (value === "reset") await focusFixture(entry.pid);
    };
    try {
      expect(await read()).toBe("ready");
      await Bun.sleep(900);
      await focusFixture(entry.pid);
      for (const change of [undefined, "change", "caret", "select", "other", "password"]) {
        await send("reset");
        const destination = Bun.spawn([helper, String(entry.pid)], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = destination.stdout.getReader();
        const deadline = setTimeout(() => destination.kill(), 4000);
        try {
          expect(new TextDecoder().decode((await output.read()).value).trim()).toBe("ready");
          if (change) await send(change);
          destination.stdin.write(JSON.stringify("Hei æøå 👋") + "\n");
          await destination.stdin.flush();
          const result = new TextDecoder()
            .decode((await output.read()).value)
            .trim()
            .split(":")[0];
          expect(result).toBe(change ? "preview" : "inserted");
          await send("get");
          expect(await read()).toBe(
            change === "change" ? "changed" : change ? "start" : "start Hei æøå 👋",
          );
        } finally {
          clearTimeout(deadline);
          destination.kill();
        }
      }
      await send("reset");
      await send("password");
      const password = Bun.spawn([helper, String(entry.pid)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      expect((await new Response(password.stdout).text()).trim().split(":")[0]).toBe("preview");
    } finally {
      entry.kill();
    }
  },
  20000,
);

nativeTest(
  "Hyprland destination adapter inserts once and rejects a vanished application",
  async () => {
    const { HyprlandDesktop } = await import("../src/desktop.ts");
    const root = resolve(import.meta.dir, "../../..");
    const desktop = new HyprlandDesktop(`${root}/build/linux-client/dictaduo-destination`);
    await desktop.monitorSession(() => {});
    const entry = Bun.spawn([`${root}/.local/entry-fixture`], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = entry.stdout.getReader();
    try {
      await reader.read();
      await Bun.sleep(800);
      await focusFixture(entry.pid);
      expect(await desktop.unlocked()).toBe(true);
      const destination = await desktop.capture();
      expect(await destination.deliver("Norsk æøå")).toBe("inserted");
      expect(await destination.deliver("duplicate")).toBe("preview");
      entry.stdin.write("get\n");
      await entry.stdin.flush();
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe("start Norsk æøå");
      entry.stdin.write("reset\n");
      await entry.stdin.flush();
      await Bun.sleep(100);
      const gone = await desktop.capture();
      entry.kill();
      await entry.exited;
      await Bun.sleep(100);
      expect(await gone.deliver("must not be inserted elsewhere")).toBe("preview");
    } finally {
      entry.kill();
      desktop.close();
    }
  },
  10000,
);
