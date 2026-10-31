import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import type { Agent, SystemInfo } from "./types";
import { emptyForm, type PlaygroundState } from "./usePlayground";

const SYSTEM: SystemInfo = {
  modelProvider: "anthropic",
  arkConfigured: true,
  arkBaseUrl: "https://api.anthropic.com",
  arkModel: "claude-opus-5-5",
  codexAvailable: false,
  codexSandboxMode: "workspace-write",
  runtimeProvider: "container",
  containerEngine: "docker",
  runtime: "Claude on Runs only; the Playground needs Codex",
};

const AGENT = {
  id: "agent-1",
  name: "Builder",
  description: "",
  instructions: "",
  status: "ready",
  reflections: [],
} as unknown as Agent;

function render(system: SystemInfo): string {
  const state = {
    agents: [AGENT],
    selectedId: AGENT.id,
    selected: AGENT,
    messages: [],
    system,
    form: emptyForm,
    prompt: "",
    activeRun: null,
    steps: [],
    traceRecords: [],
    traceRedactions: 0,
    busy: false,
    error: null,
    showCreate: false,
    showSettings: false,
    showSafetyPanel: false,
    showWorkspace: false,
  } as unknown as PlaygroundState;
  return renderToStaticMarkup(<Playground state={state} />);
}

describe("the Playground under each provider", () => {
  it("says plainly that it needs Codex under Claude, and closes the composer", () => {
    const html = render(SYSTEM);

    expect(html).toContain("The Playground is unavailable with Claude");
    expect(html).toContain("MODEL_PROVIDER=anthropic");
    expect(html).toContain('href="/runs/new"');
    expect(html).toMatch(/<textarea[^>]*disabled/);
    // Not the Codex setup advice, which would send someone the wrong way.
    expect(html).not.toContain("The runtime needs configuring");
  });

  it("is unchanged under a Codex provider", () => {
    const html = render({ ...SYSTEM, modelProvider: "openai", codexAvailable: true, runtime: "Codex CLI in docker Runtime" });

    expect(html).not.toContain("unavailable with Claude");
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });
});
