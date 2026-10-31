import { describe, expect, it } from "vitest";
import {
  firstEnabled,
  keyAction,
  lastEnabled,
  NO_TYPEAHEAD,
  openingIndex,
  pageEnabled,
  placeList,
  stepEnabled,
  typeahead,
  TYPEAHEAD_RESET_MS,
} from "./select-logic";

const options = [
  { label: "Queued", disabled: true },
  { label: "Planning" },
  { label: "Running" },
  { label: "Held", disabled: true },
  { label: "Finished" },
  { label: "Failed" },
  { label: "Cancelled", disabled: true },
];

describe("moving through options", () => {
  it("skips disabled options", () => {
    expect(stepEnabled(options, 2, 1)).toBe(4);
    expect(stepEnabled(options, 4, -1)).toBe(2);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(stepEnabled(options, 5, 1)).toBe(5);
    expect(stepEnabled(options, 1, -1)).toBe(1);
  });

  it("finds the first and last that can be chosen", () => {
    expect(firstEnabled(options)).toBe(1);
    expect(lastEnabled(options)).toBe(5);
  });

  it("returns -1 when nothing can be chosen", () => {
    const none = [{ label: "One", disabled: true }];
    expect(firstEnabled(none)).toBe(-1);
    expect(lastEnabled(none)).toBe(-1);
    expect(openingIndex(none, 0)).toBe(-1);
  });

  it("pages by several enabled options and stops at the end", () => {
    expect(pageEnabled(options, 1, 1, 2)).toBe(4);
    expect(pageEnabled(options, 1, 1)).toBe(5);
    expect(pageEnabled(options, 5, -1)).toBe(1);
  });

  it("opens on the chosen option unless it cannot be chosen", () => {
    expect(openingIndex(options, 4)).toBe(4);
    expect(openingIndex(options, 3)).toBe(1);
    expect(openingIndex(options, -1)).toBe(1);
  });
});

describe("typeahead", () => {
  const list = [
    { label: "All statuses" },
    { label: "Running" },
    { label: "Finished" },
    { label: "Failed" },
    { label: "Foreign", disabled: true },
    { label: "Security admin" },
  ];

  it("jumps to the next option starting with the letter", () => {
    expect(typeahead(list, NO_TYPEAHEAD, "r", 10_000, 0).index).toBe(1);
  });

  it("builds a word when typed quickly", () => {
    const first = typeahead(list, NO_TYPEAHEAD, "f", 10_000, 0);
    expect(first.index).toBe(2);
    const second = typeahead(list, first.state, "a", 10_000 + 100, first.index);
    expect(second.index).toBe(3);
  });

  it("cycles when the same letter is repeated", () => {
    const first = typeahead(list, NO_TYPEAHEAD, "f", 10_000, 0);
    const second = typeahead(list, first.state, "f", 10_100, first.index);
    expect(second.index).toBe(3);
    const third = typeahead(list, second.state, "f", 10_200, second.index);
    expect(third.index).toBe(2);
  });

  it("wraps around, and never lands on a disabled option", () => {
    const from = typeahead(list, NO_TYPEAHEAD, "f", 10_000, 3);
    expect(from.index).toBe(2);
  });

  it("forgets the word after a pause", () => {
    const first = typeahead(list, NO_TYPEAHEAD, "f", 10_000, 0);
    const later = typeahead(list, first.state, "r", 10_000 + TYPEAHEAD_RESET_MS + 1, first.index);
    expect(later.index).toBe(1);
  });

  it("matches labels with a space in them", () => {
    const one = typeahead(list, NO_TYPEAHEAD, "s", 10_000, 0);
    const two = typeahead(list, one.state, "e", 10_050, one.index);
    const three = typeahead(list, two.state, "c", 10_100, two.index);
    expect(three.index).toBe(5);
  });

  it("says when nothing matches", () => {
    expect(typeahead(list, NO_TYPEAHEAD, "z", 10_000, 0).index).toBe(-1);
  });
});

describe("what a key means", () => {
  it("opens from the arrows, Enter and Space, and at the ends from Home and End", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " "]) {
      expect(keyAction({ key }, false, false)).toEqual({ type: "open", at: "chosen" });
    }
    expect(keyAction({ key: "Home" }, false, false)).toEqual({ type: "open", at: "first" });
    expect(keyAction({ key: "End" }, false, false)).toEqual({ type: "open", at: "last" });
  });

  it("moves when open", () => {
    expect(keyAction({ key: "ArrowDown" }, true, false)).toEqual({ type: "move", to: "next" });
    expect(keyAction({ key: "ArrowUp" }, true, false)).toEqual({ type: "move", to: "previous" });
    expect(keyAction({ key: "Home" }, true, false)).toEqual({ type: "move", to: "first" });
    expect(keyAction({ key: "End" }, true, false)).toEqual({ type: "move", to: "last" });
    expect(keyAction({ key: "PageDown" }, true, false)).toEqual({ type: "move", to: "page-next" });
  });

  it("commits on Enter, Space and Tab, and dismisses on Escape", () => {
    expect(keyAction({ key: "Enter" }, true, false)).toEqual({ type: "commit", thenTab: false });
    expect(keyAction({ key: " " }, true, false)).toEqual({ type: "commit", thenTab: false });
    expect(keyAction({ key: "Tab" }, true, false)).toEqual({ type: "commit", thenTab: true });
    expect(keyAction({ key: "Escape" }, true, false)).toEqual({ type: "dismiss" });
  });

  it("commits on Alt + Up", () => {
    expect(keyAction({ key: "ArrowUp", altKey: true }, true, false)).toEqual({ type: "commit", thenTab: false });
  });

  it("treats Space as a letter while a word is being typed", () => {
    expect(keyAction({ key: " " }, true, true)).toEqual({ type: "type", char: " " });
  });

  it("types printable characters, open or closed", () => {
    expect(keyAction({ key: "f" }, true, false)).toEqual({ type: "type", char: "f" });
    expect(keyAction({ key: "f" }, false, false)).toEqual({ type: "type", char: "f" });
  });

  it("leaves shortcuts and other keys alone", () => {
    expect(keyAction({ key: "r", metaKey: true }, false, false)).toEqual({ type: "none" });
    expect(keyAction({ key: "c", ctrlKey: true }, true, false)).toEqual({ type: "none" });
    expect(keyAction({ key: "Tab" }, false, false)).toEqual({ type: "none" });
    expect(keyAction({ key: "F5" }, true, false)).toEqual({ type: "none" });
  });
});

describe("where the list goes", () => {
  const viewport = { width: 1000, height: 800 };
  const anchor = { top: 100, bottom: 136, left: 200, right: 400 };

  it("sits below the trigger when it fits", () => {
    expect(placeList(anchor, { width: 200, height: 200 }, viewport)).toEqual({ top: 142, left: 200, maxHeight: 650, side: "below" });
  });

  it("flips above near the bottom of the window", () => {
    const low = { top: 700, bottom: 736, left: 200, right: 400 };
    const placed = placeList(low, { width: 200, height: 300 }, viewport);
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(700 - 6 - 300);
    expect(placed.top).toBeGreaterThanOrEqual(8);
  });

  it("caps the height to the room on the larger side", () => {
    const placed = placeList(anchor, { width: 200, height: 2000 }, viewport);
    expect(placed.side).toBe("below");
    expect(placed.maxHeight).toBe(800 - 136 - 6 - 8);
  });

  it("keeps a tall list on screen when it opens above", () => {
    const low = { top: 700, bottom: 736, left: 200, right: 400 };
    const placed = placeList(low, { width: 200, height: 2000 }, viewport);
    expect(placed.side).toBe("above");
    expect(placed.top).toBe(8);
    expect(placed.maxHeight).toBe(686);
  });

  it("pulls back in from the right edge", () => {
    const right = { top: 10, bottom: 46, left: 900, right: 990 };
    expect(placeList(right, { width: 300, height: 100 }, viewport).left).toBe(692);
  });

  it("never starts off the left edge, even when wider than the window", () => {
    const narrow = { width: 360, height: 800 };
    expect(placeList(anchor, { width: 600, height: 100 }, narrow).left).toBe(8);
  });
});
