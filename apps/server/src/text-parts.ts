/**
 * Split text into parts of at most `maximum` characters, at line ends where
 * possible. Every character lands in exactly one part, in order; when no line
 * is longer than the limit, joining the parts with "\n" gives back the text.
 * A single line longer than the limit is cut into pieces rather than dropped.
 */
export function splitAtLines(text: string, maximum: number): string[] {
  if (text.length <= maximum) return [text];
  const parts: string[] = [];
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const pieces = line.length <= maximum
      ? [line]
      : Array.from({ length: Math.ceil(line.length / maximum) }, (_, index) => line.slice(index * maximum, (index + 1) * maximum));
    pieces.forEach((piece, index) => {
      if (current === null) {
        current = piece;
      } else if (index === 0 && current.length + 1 + piece.length <= maximum) {
        current = `${current}\n${piece}`;
      } else {
        parts.push(current);
        current = piece;
      }
    });
  }
  if (current !== null) parts.push(current);
  return parts;
}
