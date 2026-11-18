import { describe, expect, it, vi } from "vitest";
import { archiveFailure, archiveNote, downloadRunArchive, downloadTextPreview, manifestFromHeaders, type FileActionsApi } from "./run-file-actions";

const RUN = "00000000-0000-4000-8000-0000000000b1";

function api(overrides: Partial<FileActionsApi> = {}): FileActionsApi {
  return {
    file: async (_runId, filePath) => ({ path: filePath, content: "x".repeat(10), size: 10, truncated: false }),
    archive: async () => ({ blob: new Blob(["zip"]), manifest: { files: 12, excludedDirectories: 2, credentialEntries: 1, skippedEntries: 0 } }),
    ...overrides,
  };
}

describe("downloading a file", () => {
  it("calls it a text preview, and says when only the start was saved", async () => {
    const save = vi.fn();
    const note = await downloadTextPreview(
      api({ file: async (_runId, filePath) => ({ path: filePath, content: "start", size: 3_000_000, truncated: true }) }),
      save,
      RUN,
      "data/large.csv",
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toBe("large.csv.preview.txt");
    expect(await (save.mock.calls[0]![0] as Blob).text()).toBe("start");
    expect(note).toBe("Saved a text preview of data/large.csv: only its first 256 KB of 2.9 MB, with credential-shaped values redacted. Download the ZIP for the full file.");
  });

  it("never calls a whole-file preview the original bytes", async () => {
    const note = await downloadTextPreview(api(), vi.fn(), RUN, "src/a.ts");
    expect(note).toContain("It is text, not the original bytes");
  });

  it("does not save anything when the preview request fails", async () => {
    const save = vi.fn();
    await expect(downloadTextPreview(api({ file: async () => { throw new Error("No such file in this run"); } }), save, RUN, "gone.txt"))
      .rejects.toThrow("No such file");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("downloading the Run ZIP", () => {
  it("says what the archive deliberately left out", async () => {
    const save = vi.fn();
    const note = await downloadRunArchive(api(), save, RUN);
    expect(save.mock.calls[0]![1]).toBe(`agentguard-run-${RUN}.zip`);
    expect(note).toBe("Saved the Run ZIP with 12 files. Left out on purpose: 2 dependency, VCS or build folders, 1 credential-named file or folder.");
  });

  it("explains a refused archive, with nothing saved", async () => {
    const save = vi.fn();
    const failing = api({ archive: async () => { throw new Error("The workspace contains more than 500 files; the archive is limited to 500."); } });
    await expect(downloadRunArchive(failing, save, RUN)).rejects.toThrow("more than 500 files");
    expect(save).not.toHaveBeenCalled();
    expect(archiveFailure("The workspace exceeds the 100 MB archive limit")).toBe("No ZIP was downloaded: The workspace exceeds the 100 MB archive limit Nothing partial was saved.");
  });

  it("reads the omission counts from the response, treating missing ones as unknown", () => {
    const headers = new Headers({ "x-archive-files": "3", "x-archive-excluded-directories": "0", "x-archive-credential-entries": "0", "x-archive-skipped-entries": "1" });
    expect(manifestFromHeaders(headers)).toEqual({ files: 3, excludedDirectories: 0, credentialEntries: 0, skippedEntries: 1 });
    expect(archiveNote(manifestFromHeaders(new Headers()))).toContain("The server did not say what it left out");
    expect(archiveNote({ files: 1, excludedDirectories: 0, credentialEntries: 0, skippedEntries: 0 })).toBe("Saved the Run ZIP with 1 file. Nothing was left out.");
  });
});
