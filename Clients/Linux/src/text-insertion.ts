export type TextInsertionMethod = "automatic" | "unicodeTyping";

/** Wayland keyboard text maps line breaks and tabs to action keys. Refuse the
 * entire payload before typing so a chat cannot submit or change focus. */
export function typingChunks(text: string): string[] | undefined {
  if (
    /[\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(
      text,
    )
  )
    return undefined;
  const chunks: string[] = [];
  let chunk = "";
  const append = (part: string) => {
    if (chunk.length + part.length > 16) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += part;
  };
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    if (segment.length <= 16) append(segment);
    else for (const scalar of segment) append(scalar);
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
