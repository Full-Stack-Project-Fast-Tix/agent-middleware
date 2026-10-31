// What the Select decides, without a DOM: which option a key lands on, what a
// typed letter matches, and where the list fits in the window.

export interface SelectableOption {
  label: string;
  disabled?: boolean | undefined;
}

/** The nearest enabled option in a direction, or `from` when there is none. Stops at the ends, as a native select does. */
export function stepEnabled(options: readonly SelectableOption[], from: number, direction: 1 | -1): number {
  for (let index = from + direction; index >= 0 && index < options.length; index += direction) {
    if (!options[index]!.disabled) return index;
  }
  return from;
}

export function firstEnabled(options: readonly SelectableOption[]): number {
  return stepEnabled(options, -1, 1);
}

export function lastEnabled(options: readonly SelectableOption[]): number {
  const last = stepEnabled(options, options.length, -1);
  return last === options.length ? -1 : last;
}

/** Up to `amount` enabled options away, for Page Up and Page Down. */
export function pageEnabled(options: readonly SelectableOption[], from: number, direction: 1 | -1, amount = 8): number {
  let at = from;
  for (let moved = 0; moved < amount; moved += 1) {
    const next = stepEnabled(options, at, direction);
    if (next === at) break;
    at = next;
  }
  return at;
}

/** Where the list opens: on the chosen option, or on the first that can be chosen. */
export function openingIndex(options: readonly SelectableOption[], selected: number): number {
  return selected >= 0 && !options[selected]?.disabled ? selected : firstEnabled(options);
}

export interface TypeaheadState {
  query: string;
  at: number;
}

export const TYPEAHEAD_RESET_MS = 600;
export const NO_TYPEAHEAD: TypeaheadState = { query: "", at: 0 };

const normalise = (text: string) => text.trim().toLocaleLowerCase();

/**
 * What a typed character selects. Typing quickly builds a word; pressing the same
 * letter again moves on to the next option that starts with it. Matching is on the
 * option's visible label. `index` is -1 when nothing matches.
 */
export function typeahead(
  options: readonly SelectableOption[],
  state: TypeaheadState,
  char: string,
  now: number,
  active: number,
): { index: number; state: TypeaheadState } {
  const fresh = now - state.at > TYPEAHEAD_RESET_MS;
  const typed = (fresh ? "" : state.query) + char.toLocaleLowerCase();
  const repeating = typed.length > 1 && [...typed].every((letter) => letter === typed[0]);
  const query = repeating ? typed[0]! : typed;
  // A new or repeated search starts after the current option; a longer word may stay on it.
  const start = query.length === 1 ? active + 1 : Math.max(active, 0);
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset) % options.length;
    const option = options[index]!;
    if (!option.disabled && normalise(option.label).startsWith(query)) {
      return { index, state: { query: typed, at: now } };
    }
  }
  return { index: -1, state: { query: typed, at: now } };
}

export type SelectKeyAction =
  | { type: "open"; at: "chosen" | "first" | "last" }
  | { type: "move"; to: "next" | "previous" | "first" | "last" | "page-next" | "page-previous" }
  | { type: "commit"; thenTab: boolean }
  | { type: "dismiss" }
  | { type: "type"; char: string }
  | { type: "none" };

/** What a key means. `typing` is true while a typed word is still being built, when Space is one of its letters. */
export function keyAction(
  event: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  open: boolean,
  typing: boolean,
): SelectKeyAction {
  const { key, altKey = false, ctrlKey = false, metaKey = false } = event;
  if (ctrlKey || metaKey) return { type: "none" };
  const printable = key.length === 1 && !altKey;

  if (!open) {
    switch (key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Enter":
      case " ":
        return { type: "open", at: "chosen" };
      case "Home":
        return { type: "open", at: "first" };
      case "End":
        return { type: "open", at: "last" };
      default:
        return printable ? { type: "type", char: key } : { type: "none" };
    }
  }

  if (key === " " && typing) return { type: "type", char: " " };
  switch (key) {
    case "ArrowDown":
      return { type: "move", to: "next" };
    case "ArrowUp":
      return altKey ? { type: "commit", thenTab: false } : { type: "move", to: "previous" };
    case "Home":
      return { type: "move", to: "first" };
    case "End":
      return { type: "move", to: "last" };
    case "PageDown":
      return { type: "move", to: "page-next" };
    case "PageUp":
      return { type: "move", to: "page-previous" };
    case "Enter":
    case " ":
      return { type: "commit", thenTab: false };
    case "Tab":
      return { type: "commit", thenTab: true };
    case "Escape":
      return { type: "dismiss" };
    default:
      return printable ? { type: "type", char: key } : { type: "none" };
  }
}

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Placement {
  top: number;
  left: number;
  maxHeight: number;
  side: "below" | "above";
}

const GAP = 6;
const EDGE = 8;

/**
 * Where a list goes beside its trigger. Below when it fits, otherwise on whichever
 * side has more room, with a height cap so it scrolls rather than leaving the
 * window. Aligned to the trigger's left edge, and pulled back in at the window's edge.
 */
export function placeList(
  anchor: Box,
  content: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const below = viewport.height - anchor.bottom - GAP - EDGE;
  const above = anchor.top - GAP - EDGE;
  const side = content.height <= below || below >= above ? "below" : "above";
  const maxHeight = Math.max(0, side === "below" ? below : above);
  const height = Math.min(content.height, maxHeight);
  const top = side === "below" ? anchor.bottom + GAP : anchor.top - GAP - height;
  const widest = viewport.width - 2 * EDGE;
  const width = Math.min(content.width, widest);
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - EDGE - width));
  return { top, left, maxHeight, side };
}
