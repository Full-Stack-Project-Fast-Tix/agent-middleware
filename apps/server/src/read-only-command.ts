// Whether a command only reads, for an agent whose profile cannot write. A
// command may be reported as `/usr/bin/bash -lc "..."`, and agents chain commands,
// so this parses that shell text. Anything it does not fully understand is not a
// read: expansions, substitutions, redirects and unknown programs all fail closed.

/** Programs that cannot write or execute anything, whatever their arguments. */
const PLAIN_READS = new Set([
  "basename", "cat", "cd", "cut", "dirname", "echo", "grep", "head", "ls", "nl",
  "printf", "pwd", "stat", "tail", "tr", "true", "wc", "which",
]);

/** Splits shell text into commands of words, or null if it uses anything beyond words and chaining. */
function parseCommands(text: string): string[][] | null {
  const commands: string[][] = [[]];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) commands.at(-1)!.push(word);
    word = "";
    inWord = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) return null;
      word += text.slice(index + 1, close);
      inWord = true;
      index = close;
    } else if (char === '"') {
      const close = text.indexOf('"', index + 1);
      if (close < 0) return null;
      const quoted = text.slice(index + 1, close);
      if (/[$`\\]/.test(quoted)) return null;
      word += quoted;
      inWord = true;
      index = close;
    } else if (char === " " || char === "\t") {
      endWord();
    } else if (char === ";" || char === "|") {
      endWord();
      if (text[index + 1] === "|") index += 1;
      commands.push([]);
    } else if (char === "&") {
      if (text[index + 1] !== "&") return null;
      endWord();
      index += 1;
      commands.push([]);
    } else if (char === ">") {
      // Only the harmless redirects agents add to quieten or merge stderr.
      const redirect = /^>(?:&1|\s*\/dev\/null)(?=[\s;&|]|$)/.exec(text.slice(index));
      if (word !== "2" || redirect === null) return null;
      word = "";
      inWord = false;
      index += redirect[0].length - 1;
    } else if (/[$`\\()<\n\r]/.test(char)) {
      return null;
    } else {
      word += char;
      inWord = true;
    }
  }
  endWord();
  return commands;
}

function isReadOnlyWords([program, ...args]: string[]): boolean {
  if (program === undefined) return false;
  if (PLAIN_READS.has(program)) return true;
  switch (program) {
    case "find":
      return !args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg));
    case "rg":
      return !args.some((arg) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg));
    case "file":
      return !args.some((arg) => arg === "--compile" || /^-[a-zA-Z]*C/.test(arg));
    case "sort":
      return !args.some((arg) => /^-[a-zA-Z]*o/.test(arg) || /^--(?:output|compress-program)/.test(arg));
    case "uniq":
      // A second file operand is where uniq writes.
      return args.filter((arg) => !arg.startsWith("-")).length <= 1;
    case "sed":
      // sed is a language: only printing a line range is a read, and nothing may follow the one file.
      return args[0] === "-n" && /^\d+(?:,(?:\d+|\$))?p$/.test(args[1] ?? "") && args.length <= 3 && !args[2]?.startsWith("-");
    // No git: even `git status` runs programs named in repo config or attributes
    // (core.fsmonitor, diff.external, textconv and clean filters), and a Run's
    // copy holds no .git unless an agent made one, so any repo there is agent-written.
    default:
      return false;
  }
}

/** What an agent without the shell capability may run: one plain read, no shell. */
export function isPlainRead(command: string): boolean {
  if (/[;&|<>]/.test(command)) return false;
  const commands = parseCommands(command);
  return commands?.length === 1 && isReadOnlyWords(commands[0]!);
}

/** What an agent with the shell capability but no write capability may run. */
export function isKnownSafeRead(command: string): boolean {
  const outer = parseCommands(command);
  if (outer === null || outer.length === 0) return false;
  const [only] = outer;
  const wrapped = outer.length === 1 && only !== undefined && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh$/.test(only[0] ?? "") && /^-l?c$/.test(only[1] ?? "");
  if (wrapped && only.length !== 3) return false;
  const commands = wrapped ? parseCommands(only[2]!) : outer;
  return commands !== null && commands.every(isReadOnlyWords);
}
