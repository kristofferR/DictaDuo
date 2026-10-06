export type TextInsertionMethod = "automatic" | "unicodeTyping";

/** Input-method commits carry literal text. Leave room in Wayland's 4096-byte
 * message for its headers; keep graphemes together unless one exceeds the bound. */
export function literalTextChunks(text: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  const append = (part: string) => {
    const size = encoder.encode(part).length;
    if (bytes + size > 3000) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += part;
    bytes += size;
  };
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    if (encoder.encode(segment).length <= 3000) append(segment);
    else for (const scalar of segment) append(scalar);
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

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
