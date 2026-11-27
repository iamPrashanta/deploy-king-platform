import readline from "node:readline";

// Colours of the Night theme in the artboard (DeskTerminal): green, blue, muted, bright, amber, frame.
const TRUE = /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const ON = !process.env.NO_COLOR && process.stdout.isTTY;
const rgb = (hex: string, fallback: number) => (s: string) => {
  if (!ON) return s;
  if (!TRUE) return `\x1b[${fallback}m${s}\x1b[39m`;
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${s}\x1b[39m`;
};
export const c = {
  green: rgb("#3FB950", 32),
  blue: rgb("#86AAFF", 94),
  muted: rgb("#8A94B0", 90),
  bright: rgb("#F1F4FB", 97),
  amber: rgb("#F5B83D", 33),
  red: rgb("#F85149", 31),
  frame: rgb("#3A4768", 90),
  bold: (s: string) => (ON ? `\x1b[1m${s}\x1b[22m` : s),
};

const ANSI = /\x1b\[[0-9;]*m/g;
export const visible = (s: string) => s.replace(ANSI, "");
const width = () => Math.max(40, Math.min(process.stdout.columns || 80, 100));

export const out = (s = "") => process.stdout.write(s + "\n");

/** ╭───╮ box with lines inside, like the artboard's header. */
export function box(lines: string[]) {
  const inner = Math.max(...lines.map((l) => visible(l).length), 40);
  const w = Math.min(inner, width() - 4);
  out(c.frame(`╭${"─".repeat(w + 2)}╮`));
  for (const l of lines) {
    const v = visible(l);
    const text = v.length > w ? v.slice(0, w - 1) + "…" : l;
    out(`${c.frame("│ ")}${text}${" ".repeat(Math.max(0, w - visible(text).length))}${c.frame(" │")}`);
  }
  out(c.frame(`╰${"─".repeat(w + 2)}╯`));
}

/** "● text" status line. */
export const status = (text: string, ok = true) => out(`${ok ? c.green("●") : c.red("●")} ${text}`);
/** "  ✓ text      12 s" step line, with the time right-aligned. */
export function step(text: string, ok: boolean, ms?: number) {
  const left = `  ${ok ? c.green("✓") : c.red("✗")} ${text}`;
  if (ms === undefined) return out(left);
  const t = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
  const pad = Math.max(2, Math.min(width(), 72) - visible(left).length - t.length);
  out(left + " ".repeat(pad) + c.muted(t));
}

export function footer() {
  out(c.muted("? for shortcuts   /help · /apps · /logs · /undo · /quit"));
}

// ─── spinner ─────────────────────────────────────────────────────────────────
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private i = 0;
  private text = "";
  get active() {
    return !!this.timer;
  }
  start(text: string) {
    this.text = text;
    if (!process.stdout.isTTY) return;
    if (this.timer) return;
    this.draw();
    this.timer = setInterval(() => this.draw(), 90);
  }
  private draw() {
    const line = `  ${c.amber(FRAMES[this.i++ % FRAMES.length]!)} ${c.muted(this.text)}`;
    process.stdout.write(`\r\x1b[2K${line.slice(0, width() + 20)}`);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write("\r\x1b[2K");
  }
}

// ─── input ───────────────────────────────────────────────────────────────────
const history: string[] = [];

/**
 * Without a terminal (input piped in), one reader takes every line, so lines that arrive together are not lost
 * between prompts; each is echoed after its prompt, which keeps a transcript readable.
 */
type Pipe = { lines: string[]; waiters: Array<(l: string | null) => void>; closed: boolean };
let pipe: Pipe | null = null;
function pipedLine(prompt: string, show = true): Promise<string | null> {
  if (!pipe) {
    const p: Pipe = { lines: [], waiters: [], closed: false };
    pipe = p;
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (l) => {
      const w = p.waiters.shift();
      if (w) w(l);
      else p.lines.push(l);
    });
    rl.on("close", () => {
      p.closed = true;
      for (const w of p.waiters.splice(0)) w(null);
    });
  }
  const p = pipe;
  process.stdout.write(prompt);
  const echo = (l: string | null) => (process.stdout.write(l === null || !show ? "\n" : `${l}\n`), l);
  if (p.lines.length) return Promise.resolve(echo(p.lines.shift()!));
  if (p.closed) return Promise.resolve(echo(null));
  return new Promise((resolve) => p.waiters.push((l) => resolve(echo(l))));
}

/** One line from the user. Resolves null on Ctrl+D / Ctrl+C. */
export function readLine(prompt: string, opts: { hidden?: boolean; history?: boolean } = {}): Promise<string | null> {
  if (!process.stdin.isTTY) return pipedLine(prompt, !opts.hidden);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, history: opts.history ? history : [], historySize: 200, removeHistoryDuplicates: true } as any);
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(v);
    };
    if (opts.hidden && process.stdin.isTTY) {
      // Print the prompt, then echo nothing the user types.
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes(prompt)) process.stdout.write(prompt);
        else if (s === "\r\n" || s === "\n") process.stdout.write(s);
      };
    }
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish(null);
    });
    rl.on("close", () => finish(null));
    // readline keeps adding to the shared history array, so the arrows work across prompts.
    rl.question(prompt, (answer) => finish(answer));
  });
}

/**
 * `? Apply this plan?  ❯ Yes   Yes, and don't ask again   No, change it` — arrows and Enter, or the first
 * letter. Without a terminal it reads a number. Resolves the chosen index, or -1 on Ctrl+C.
 */
export function select(question: string, options: string[]): Promise<number> {
  const label = `${c.amber("?")} ${c.bright(question)}`;
  if (!process.stdin.isTTY) {
    out(label);
    options.forEach((o, i) => out(`  ${i + 1}. ${o}`));
    return readLine("> ").then((a) => {
      const n = Number(a);
      return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : -1;
    });
  }
  return new Promise((resolve) => {
    let at = 0;
    const render = () => {
      const opts = options.map((o, i) => (i === at ? c.green(`❯ ${o}`) : c.muted(`  ${o}`))).join(" ");
      process.stdout.write(`\r\x1b[2K${label}  ${opts}`);
    };
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const done = (i: number) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      resolve(i);
    };
    const onKey = (_s: string, key: readline.Key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") return done(-1);
      if (key.name === "left" || key.name === "up" || (key.shift && key.name === "tab")) at = (at + options.length - 1) % options.length;
      else if (key.name === "right" || key.name === "down" || key.name === "tab") at = (at + 1) % options.length;
      else if (key.name === "return" || key.name === "enter") return done(at);
      else if (key.name === "escape") return done(-1);
      else if (key.sequence && /^[1-9]$/.test(key.sequence) && Number(key.sequence) <= options.length) return done(Number(key.sequence) - 1);
      else if (key.name && key.name.length === 1) {
        const hit = options.findIndex((o) => o.toLowerCase().startsWith(key.name!));
        if (hit >= 0) return done(hit);
      }
      render();
    };
    stdin.on("keypress", onKey);
    render();
  });
}

/** Wraps model text to the terminal without breaking words. */
export function wrap(text: string, indent = "") {
  const w = width() - indent.length;
  return text
    .split("\n")
    .map((line) => {
      if (visible(line).length <= w) return indent + line;
      const words = line.split(" ");
      const lines: string[] = [];
      let cur = "";
      for (const word of words) {
        if (visible(cur + " " + word).length > w && cur) {
          lines.push(cur);
          cur = word;
        } else cur = cur ? `${cur} ${word}` : word;
      }
      if (cur) lines.push(cur);
      return lines.map((l) => indent + l).join("\n");
    })
    .join("\n");
}
