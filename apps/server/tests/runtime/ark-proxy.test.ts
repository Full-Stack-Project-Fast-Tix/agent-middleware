import { describe, expect, it } from "vitest";
import { arkEventRepair, repairArkEventLine, repairArkInput } from "../../src/ark-proxy.js";

describe("repairArkEventLine", () => {
  const completed = (usage: object) => "data: " + JSON.stringify({ type: "response.completed", response: { id: "r", usage } });

  it("fills in the usage counters Codex refuses to parse without", () => {
    const repaired = JSON.parse(repairArkEventLine(completed({ input_tokens: 1, input_tokens_details: {}, output_tokens: 2 })).slice(5));
    expect(repaired.response.usage).toEqual({
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("keeps counters the provider did send", () => {
    const line = completed({ input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 3 } });
    expect(JSON.parse(repairArkEventLine(line).slice(5)).response.usage).toEqual({
      input_tokens_details: { cached_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 3 },
    });
  });

  it("passes other lines and broken JSON through unchanged", () => {
    for (const line of ["event: response.completed", 'data: {"type":"response.created"}', 'data: {"response.completed"', ""]) {
      expect(repairArkEventLine(line)).toBe(line);
    }
  });

  it("repairs a line split across chunks and keeps the rest of the stream intact", async () => {
    const line = completed({ input_tokens_details: {} });
    const stream = arkEventRepair();
    stream.write("event: response.completed\n" + line.slice(0, 20));
    stream.end(line.slice(20) + "\n\n");
    let out = "";
    for await (const chunk of stream) out += String(chunk);
    expect(out).toContain('"cached_tokens":0');
    expect(out.startsWith("event: response.completed\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(true);
  });
});

describe("repairArkInput", () => {
  it("adds status to prior-turn items Ark validates", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "reasoning", summary: [], content: [], encrypted_content: "x" },
        { type: "function_call", name: "shell", arguments: "{}", call_id: "c1" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };

    expect(repairArkInput(body)).toBe(4);
    expect(body.input.every((item) => (item as { status?: string }).status === "completed")).toBe(
      true,
    );
  });

  it("never adds status inside nested content parts", () => {
    // Ark REQUIRES status on the item and REJECTS it inside content:
    // "input.content: unknown field \"status\"". Recursing breaks every request.
    const body = {
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello" }],
        },
      ],
    };

    repairArkInput(body);

    const content = (body.input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).not.toHaveProperty("status");
  });

  it("leaves an existing status alone", () => {
    const body = { input: [{ type: "function_call", status: "in_progress", call_id: "c1" }] };
    expect(repairArkInput(body)).toBe(0);
    expect((body.input[0] as { status: string }).status).toBe("in_progress");
  });

  it("ignores item types Ark does not validate", () => {
    const body = { input: [{ type: "item_reference", id: "x" }] };
    expect(repairArkInput(body)).toBe(0);
    expect(body.input[0]).not.toHaveProperty("status");
  });

  it("tolerates bodies without an input array", () => {
    expect(repairArkInput({})).toBe(0);
    expect(repairArkInput({ input: "not-an-array" as unknown as unknown[] })).toBe(0);
  });
});
