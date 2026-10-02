import { expect, test } from "bun:test";
import { OutputMuter } from "../src/output.ts";

/** A fake wpctl whose default sink and failures the test controls. */
function pipewire(muted = false) {
  const state = {
    sink: "59",
    muted: new Map([["59", muted]]),
    failSetMute: 0,
    calls: [] as string[],
  };
  const run = async (args: string[]) => {
    state.calls.push(args.join(" "));
    const [verb, id, value] = args;
    if (verb === "inspect") return `id ${state.sink}, type PipeWire:Interface:Node\n`;
    if (verb === "get-volume") return `Volume: 0.75${state.muted.get(id!) ? " [MUTED]" : ""}\n`;
    if (verb === "set-mute") {
      if (state.failSetMute > 0) {
        state.failSetMute--;
        throw new Error("wpctl is unavailable.");
      }
      state.muted.set(id!, value === "1");
      return "";
    }
    throw new Error(`Unexpected wpctl ${args.join(" ")}`);
  };
  return { state, muter: new OutputMuter(run, [5, 5, 5]) };
}

test("mutes the default sink for a take and restores it by node, even if the default changed", async () => {
  const { state, muter } = pipewire();
  await muter.mute();
  expect(state.muted.get("59")).toBe(true);
  state.sink = "60";
  state.muted.set("60", false);
  await muter.restore();
  expect(state.muted.get("59")).toBe(false);
  expect(state.muted.get("60")).toBe(false);
});

test("an output the user had already muted stays muted", async () => {
  const { state, muter } = pipewire(true);
  await muter.mute();
  await muter.restore();
  expect(state.muted.get("59")).toBe(true);
  expect(state.calls.filter((call) => call.startsWith("set-mute"))).toEqual([]);
});

test("a failed restore is retried, and quitting waits for it", async () => {
  const { state, muter } = pipewire();
  await muter.mute();
  state.failSetMute = 1;
  await muter.restore();
  expect(state.muted.get("59")).toBe(true);
  await Bun.sleep(20);
  expect(state.muted.get("59")).toBe(false);

  await muter.mute();
  state.failSetMute = 2;
  await muter.finish();
  expect(state.muted.get("59")).toBe(false);
});

test("a new take suspends retries so they cannot unmute it", async () => {
  const { state, muter } = pipewire();
  await muter.mute();
  state.failSetMute = 1;
  await muter.restore();
  await muter.mute();
  await Bun.sleep(30);
  expect(state.muted.get("59")).toBe(true);
  await muter.restore();
  expect(state.muted.get("59")).toBe(false);
});
