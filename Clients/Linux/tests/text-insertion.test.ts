import { expect, test } from "bun:test";
import { literalTextChunks, typingChunks } from "../src/text-insertion.ts";

test("literal packets preserve paragraphs, tabs and Unicode within Wayland's byte bound", () => {
  const text = "\n\t👨‍👩‍👧‍👦 æøå\n".repeat(400) + "e" + "\u0301".repeat(2000);
  const chunks = literalTextChunks(text);
  expect(chunks.join("")).toBe(text);
  expect(
    chunks.every((value) => value.length > 0 && new TextEncoder().encode(value).length <= 3000),
  ).toBe(true);
  expect(literalTextChunks("")).toEqual([]);
});

test("typing packets preserve Unicode and ordinary graphemes within the size bound", () => {
  const text = "Hei æøå 👋🏽 e\u0301 👨‍👩‍👧‍👦 中文 " + "a" + "\u0301".repeat(40);
  const chunks = typingChunks(text)!;
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => chunk.length <= 16 && chunk.length > 0)).toBe(true);
  expect(chunks.some((chunk) => chunk.includes("👨‍👩‍👧‍👦"))).toBe(true);
  for (const chunk of chunks) expect(typingChunks(chunk)).toBeDefined();
});

test("keyboard actions and malformed Unicode reject the whole payload before typing", () => {
  for (const text of [
    "safe\nsubmit",
    "safe\tother",
    "safe\r",
    "safe\x1b",
    "safe\0",
    "safe\x7f",
    "safe\ud800",
    "safe\udc00",
  ])
    expect(typingChunks(text)).toBeUndefined();
  expect(typingChunks("")).toEqual([]);
});
