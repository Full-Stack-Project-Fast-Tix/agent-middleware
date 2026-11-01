import { describe, expect, it } from "vitest";
import { isKnownSafeRead, isPlainRead } from "../../src/read-only-command.js";

describe("isKnownSafeRead", () => {
  it.each([
    "cat README.md",
    "ls -la",
    "sed -n '1,300p' app.js",
    "find . -maxdepth 3 -type f -print | sort | sed -n '1,300p'; git status --short --branch 2>&1",
    "cat a.js && wc -l a.js || true",
    "rg --files 2>/dev/null | sort | uniq -c | head -5",
    `/usr/bin/bash -lc "find . -maxdepth 3 -type f -print | sort | sed -n '1,300p'; git status --short --branch 2>&1"`,
    `/usr/bin/bash -lc "rg --files -g '"'!node_modules'"' | sed -n '1,160p'"`,
    "bash -c 'cd src && grep -rn todo .'",
  ])("allows %s", (command) => {
    expect(isKnownSafeRead(command)).toBe(true);
  });

  it.each([
    // Programs that are not on the list, alone or hiding in a chain.
    "npm test",
    "cat a.js; rm -rf .",
    "cat a.js && npm run build",
    "ls | xargs rm",
    "FOO=bar cat a.js",
    `/usr/bin/bash -lc "ls; touch x"`,
    // Writing through a redirect.
    "echo hi > x",
    "cat a >> b",
    "ls 2> errors.txt",
    "ls &> x",
    `/usr/bin/bash -lc "git status > x"`,
    // Running something through expansion.
    "cat $(rm -rf .)",
    "cat `rm x`",
    `echo "$(rm x)"`,
    "echo $HOME",
    "(rm x)",
    "cat <(rm x)",
    "ls & rm x",
    "ls\nrm x",
    "cat a\;b",
    // Read tools with a writing or executing flag.
    "sed -i 's/a/b/' x",
    "sed 's/a/b/w out' x",
    "sed -n '1p' x -i",
    "sed -n '1w out' x",
    "awk '{print}' x",
    "find . -delete",
    "find . -exec rm {} ;",
    "find . -fprint out",
    "rg --pre ./run x",
    "rg --pre=./run x",
    "sort -o out x",
    "sort -uo out x",
    "sort --output=out x",
    "uniq in out",
    "file -C -m x",
    "git push",
    "git config core.pager x",
    "git -c core.pager=x log",
    "git diff --output=x",
    "git diff --ext-diff",
    // A shell wrapper that is not exactly one script.
    "bash -lc 'ls' extra",
    "bash ./script.sh",
    "bash -lc",
    "",
    "'unterminated",
  ])("refuses %s", (command) => {
    expect(isKnownSafeRead(command)).toBe(false);
  });
});

describe("isPlainRead", () => {
  it("allows only one plain read for an agent without a shell", () => {
    expect(isPlainRead("cat README.md")).toBe(true);
    for (const command of ["git status", "cat a | wc -l", "cat a; cat b", "ls 2>&1", "bash -c 'ls'", "sed -i 's/a/b/' x"]) {
      expect(isPlainRead(command), command).toBe(false);
    }
  });
});
