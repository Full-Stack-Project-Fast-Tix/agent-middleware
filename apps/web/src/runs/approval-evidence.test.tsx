import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Approval } from "@launchpad/shared";
import { ApprovalActions, ApprovalEvidenceView } from "./ApprovalEvidence";
import { approvalEvidence, approvalOutcomeText } from "./approval-evidence";

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    runId: "00000000-0000-4000-8000-0000000000b1",
    taskId: null,
    executionId: null,
    agentId: "00000000-0000-4000-8000-0000000000c1",
    actionType: "file_change",
    actionId: "item_1",
    reason: "semantic_uncertainty",
    summary: "The change bumps the package version, which the request did not ask for.",
    safeDetails: {
      files: [{ path: "package.json", kind: "update", diff: '-  "version": "1.0.0"\n+  "version": "2.0.0"', diffComplete: true }],
      complete: true,
    },
    status: "pending",
    requestedAt: "2026-11-18T00:00:00.000Z",
    expiresAt: "2026-11-18T00:02:00.000Z",
    resolvedAt: null,
    resolvedByUserId: null,
    ...overrides,
  };
}

/** The Approve and Deny buttons ApprovalActions renders, with their props, so a click can be replayed. */
function buttons(element: ReactNode): Array<{ label: string; props: Record<string, unknown> }> {
  const found: Array<{ label: string; props: Record<string, unknown> }> = [];
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const props = (node as ReactElement<Record<string, unknown>>).props;
    if (typeof props.onClick === "function") found.push({ label: String(props.children), props });
    walk(props.children as ReactNode);
  };
  walk(element);
  return found;
}

describe("approval evidence", () => {
  it("shows the hold reason and the exact proposed content", () => {
    const html = renderToStaticMarkup(<ApprovalEvidenceView approval={approval()} />);
    expect(html).toContain("may conflict with the request");
    expect(html).toContain("bumps the package version");
    expect(html).toContain("package.json");
    expect(html).toContain("&quot;version&quot;: &quot;2.0.0&quot;");
    expect(html).toContain("foreign");
  });

  it("refuses Approve when no proposal was saved, while Deny still answers", () => {
    const missing = approval({ safeDetails: null });
    const evidence = approvalEvidence(missing);
    expect(evidence).toMatchObject({ canApprove: false, missing: expect.stringContaining("cannot be approved") });
    expect(renderToStaticMarkup(<ApprovalEvidenceView approval={missing} />)).toContain("The proposal was not saved");

    const onAnswer = vi.fn();
    const html = renderToStaticMarkup(<ApprovalActions approval={missing} busy={false} onAnswer={onAnswer} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Deny<\/button>/);

    // Replay the clicks the buttons would receive: Approve does nothing, Deny answers.
    const rendered = buttons(ApprovalActions({ approval: missing, busy: false, onAnswer }));
    (rendered.find((button) => button.label === "Approve")!.props.onClick as () => void)();
    (rendered.find((button) => button.label === "Deny")!.props.onClick as () => void)();
    expect(onAnswer.mock.calls).toEqual([["deny"]]);
  });

  it("answers Approve when the proposal is visible", () => {
    const onAnswer = vi.fn();
    const rendered = buttons(ApprovalActions({ approval: approval(), busy: false, onAnswer }));
    (rendered.find((button) => button.label === "Approve")!.props.onClick as () => void)();
    expect(onAnswer.mock.calls).toEqual([["approve"]]);
  });

  it("says when only part of the proposal is shown, and that it will not cover extra changes", () => {
    const partial = approval({
      safeDetails: { files: [{ path: "src/big.ts", kind: "add", diff: "+start", diffComplete: false }], complete: false },
    });
    const html = renderToStaticMarkup(<ApprovalEvidenceView approval={partial} />);
    expect(html).toContain("Only part of this proposal is shown");
    expect(html).toContain("Excerpt: the rest is not shown");
    expect(approvalEvidence(partial).canApprove).toBe(true);
  });

  it("describes commands, handoffs and older details honestly", () => {
    expect(approvalEvidence(approval({ actionType: "command", reason: "high_consequence", safeDetails: { command: "npm publish", cwd: null, complete: true } })).parts)
      .toEqual([{ kind: "command", text: "npm publish", cwd: null }]);
    const oldHandoff = approvalEvidence(approval({ actionType: "context_handoff", safeDetails: { fromTaskId: "a", toTaskId: "b", characters: 120 } }));
    expect(oldHandoff).toMatchObject({ canApprove: false, complete: null, parts: [{ kind: "fact", text: expect.stringContaining("not saved") }] });
    expect(approvalEvidence(approval({ safeDetails: { files: [{ path: "a.ts", kind: "update" }] } }))).toMatchObject({ canApprove: true, complete: null });
  });

  it("keeps denied, timed-out and approved outcomes distinct", () => {
    expect(approvalOutcomeText("denied")).toBe("Denied: the action did not run.");
    expect(approvalOutcomeText("timed_out")).toContain("did not run");
    expect(approvalOutcomeText("approved")).toContain("does not approve other changes");
    const html = renderToStaticMarkup(<ApprovalEvidenceView approval={approval({ status: "timed_out" })} />);
    expect(html).toContain("Timed out: nobody answered in time");
  });
});
