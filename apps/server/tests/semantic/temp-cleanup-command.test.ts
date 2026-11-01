import { describe, expect, it } from "vitest";
import { isHighConsequenceCommand } from "../../src/intent-controller.js";

describe("rm -rf on a folder this command made with mktemp", () => {
  it.each([
    // Both of these are from a real run.
    `/usr/bin/bash -lc 'tmpdir=$(mktemp -d)\nTODO_FILE="$tmpdir/todos.json" node todo.js add "Debug todo"\nTODO_FILE="$tmpdir/todos.json" node todo.js list\nrm -rf "$tmpdir"'`,
    `/usr/bin/bash -lc 'set -e\ntmpdir=$(mktemp -d)\ntrap '"'rm -rf \\""'$tmpdir"'"' EXIT\nexport TODO_FILE=\\""'$tmpdir/todos.json"\nnode todo.js add "Verify todo app"'`,
    `d=$(mktemp -d); ls "$d"; rm -rf "$d"`,
    `d=$(mktemp -d -t x); cat a && rm -rf \${d} && echo done`,
  ])("does not ask for %s", (command) => {
    expect(isHighConsequenceCommand(command)).toBe(false);
  });

  it.each([
    "rm -rf /",
    "rm -rf .",
    `rm -rf "$d"`,
    `d=/etc; rm -rf "$d"`,
    `d=$(mktemp -d); d=/; rm -rf "$d"`,
    `d=$(mktemp -d); d+=/x; rm -rf "$d"`,
    `d=$(mktemp -d); for d in /etc; do rm -rf "$d"; done`,
    `d=$(mktemp -d); read d; rm -rf "$d"`,
    `d=$(mktemp -d); rm -rf "$d" /etc`,
    `d=$(mktemp -d); rm -rf "$d"/../..`,
    `d=$(mktemp -d); rm -rf "$d/.."`,
    `d=$(mktemp -d); rm -rf "$other"`,
    `d=$(mktemp -d); rm -rf "$d"; rm -rf /workspace`,
    `d=$(mktemp -d); rm -rf "$d"; git push`,
  ])("still asks for %s", (command) => {
    expect(isHighConsequenceCommand(command)).toBe(true);
  });
});
