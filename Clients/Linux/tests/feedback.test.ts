import { expect, test } from "bun:test";
import { RecordingFeedback } from "../src/feedback.ts";

test("feedback distinguishes silence from absent or stale levels and freezes the actual recording clock", () => {
  const feedback = new RecordingFeedback();
  feedback.begin(2000);
  expect(feedback.snapshot(2000).levels).toEqual([]);
  feedback.update(0, "Hello", "receiving", 2000);
  expect(feedback.snapshot(2000).levels).toEqual([0]);
  for (let n = 0; n < 12; n++) feedback.update(0.5, "Hello", "receiving", 2200);
  expect(feedback.snapshot(2300).levels).toHaveLength(9);
  expect(feedback.snapshot(4000).levels).toEqual([]);
  // Recording sessions have no duration limit or countdown.
  expect(feedback.snapshot(3_602_000)).toMatchObject({ elapsedSeconds: 3600 });
  feedback.finish(3_602_000);
  feedback.update(0.8, "Hello world", "transcribing", 3_603_000);
  expect(feedback.snapshot(3_700_000)).toMatchObject({
    levels: [],
    elapsedSeconds: 3600,
    partialText: "Hello world",
    processingStage: "transcribing",
  });
  feedback.unavailable();
  expect(feedback.snapshot(3_700_000)).toMatchObject({
    levels: [],
    partialText: "",
    streamAvailable: false,
  });
});
