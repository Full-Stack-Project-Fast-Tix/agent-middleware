import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GateRow, openRow } from "./GateLine";

afterEach(() => vi.unstubAllGlobals());

class FakeElement {
  constructor(private readonly control: boolean) {}
  closest() {
    return this.control ? this : null;
  }
}

function clickRow({ selected = "", control = false }: { selected?: string; control?: boolean }) {
  vi.stubGlobal("window", { getSelection: () => ({ toString: () => selected }) });
  vi.stubGlobal("Element", FakeElement);
  const open = vi.fn();
  openRow(new FakeElement(control) as unknown as EventTarget, open);
  return open;
}

describe("a selectable gate row", () => {
  it("keeps the proposal outside its button, so the text can be selected", () => {
    const html = renderToStaticMarkup(<GateRow decision="allow" proposal="npm test" onSelect={() => {}} selectLabel="Show task: Build" />);
    expect(html).toContain('<button type="button" class="gate-open" aria-label="Show task: Build">Show task</button>');
    expect(html).not.toMatch(/<button[^>]*>[^<]*npm test/);
  });

  it("offers nothing once what it opens is already showing", () => {
    const html = renderToStaticMarkup(<GateRow decision="allow" proposal="npm test" onSelect={() => {}} selected />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("gate-row-open");
  });

  it("opens on a plain click, but not after selecting text or on a control", () => {
    expect(clickRow({})).toHaveBeenCalledOnce();
    expect(clickRow({ selected: "npm" })).not.toHaveBeenCalled();
    expect(clickRow({ control: true })).not.toHaveBeenCalled();
  });
});
