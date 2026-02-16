import blessed from "blessed";
import crypto from "node:crypto";

type Sender = "me" | "them" | "system";
type Msg = { id: string; sender: Sender; text: string; ts: number };

const screen = blessed.screen({
  smartCSR: true,
  fullUnicode: true,
  title: "iMessage-ish CLI",
});

const header = blessed.box({
  top: 0,
  left: 0,
  height: 1,
  width: "100%",
  tags: true,
  style: { fg: "green", bg: "black" },
  content: "  Messages  (Esc/Ctrl+C to quit)  ",
});

const chatBox = blessed.box({
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-4",
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    ch: " ",
    inverse: true,
  },
  style: { bg: "black" },
});

const inputBox = blessed.textbox({
  bottom: 0,
  left: 0,
  height: 3,
  width: "100%",
  inputOnFocus: true,
  keys: true,
  mouse: true,
  padding: { left: 1, right: 1 },
  border: { type: "line" },
  style: {
    border: { fg: "green" },
    fg: "green",
    bg: "black",
    focus: { border: { fg: "cyan" } },
  },
});

screen.append(header);
screen.append(chatBox);
screen.append(inputBox);

const state = {
  messages: [] as Msg[],
  typing: false,
  typingAnim: null as NodeJS.Timeout | null,
  typingFrame: 0,
};

const timeHHMM = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

const stripTags = (s: string) => s.replace(/\{\/?[^}]+\}/g, "");

function wrapText(text: string, width: number): string[] {
  const paras = text.split("\n");
  const lines: string[] = [];
  for (const p of paras) {
    const words = p.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (next.length <= width) line = next;
      else {
        if (line) lines.push(line);
        if (w.length > width) {
          for (let i = 0; i < w.length; i += width)
            lines.push(w.slice(i, i + width));
          line = "";
        } else {
          line = w;
        }
      }
    }
    if (line) lines.push(line);
    if (p !== paras[paras.length - 1]) lines.push("");
  }
  return lines;
}

function bubbleLines(
  sender: Sender,
  text: string,
  ts: number,
  maxWidth: number
) {
  const innerPadX = 1;
  const maxInner = clamp(maxWidth - 2 - innerPadX * 2, 10, maxWidth);
  const contentLines = wrapText(text, maxInner);
  const contentWidth = Math.min(
    maxInner,
    Math.max(1, ...contentLines.map((l) => stripTags(l).length))
  );

  const w = contentWidth + innerPadX * 2;
  const top = `╭${"─".repeat(w)}╮`;
  const bottom = `╰${"─".repeat(w)}╯`;

  const styleOpen =
    sender === "me"
      ? "{cyan-fg}"
      : sender === "them"
      ? "{light-gray-fg}"
      : "{green-fg}";
  const styleClose = "{/}";

  const middle = contentLines.map((l) => {
    const rawLen = stripTags(l).length;
    const padRight = contentWidth - rawLen;
    return `│${" ".repeat(innerPadX)}${l}${" ".repeat(padRight)}${" ".repeat(
      innerPadX
    )}│`;
  });

  const tsStr = `{gray-fg}${timeHHMM(ts)}{/gray-fg}`;
  return {
    lines: [
      `${styleOpen}${top}${styleClose}`,
      ...middle.map((m) => `${styleOpen}${m}${styleClose}`),
      `${styleOpen}${bottom}${styleClose}`,
      ` ${tsStr}`,
    ],
    width: w + 2,
  };
}

function render() {
  const W = typeof screen.width === "number" ? screen.width : 80;
  const maxBubble = Math.floor(W * 0.7);

  const out: string[] = [];
  for (const m of state.messages) {
    const b = bubbleLines(m.sender, m.text, m.ts, maxBubble);

    const pad = m.sender === "me" ? Math.max(0, W - b.width - 2) : 1;

    for (const line of b.lines) out.push(" ".repeat(pad) + line);
    out.push("");
  }

  if (state.typing) {
    const dots = ["   ", ".  ", ".. ", "..."][state.typingFrame % 4];
    const b = bubbleLines("them", dots, Date.now(), Math.min(18, maxBubble));
    const pad = 1;
    for (const line of b.lines) out.push(" ".repeat(pad) + line);
    out.push("");
  }

  chatBox.setContent(out.join("\n"));
  chatBox.setScrollPerc(100);
  screen.render();
}

export function addMessage(sender: Sender, text: string) {
  state.messages.push({
    id: crypto.randomUUID(),
    sender,
    text,
    ts: Date.now(),
  });
  render();
}

export function setTyping(on: boolean) {
  state.typing = on;
  if (on) {
    if (!state.typingAnim) {
      state.typingAnim = setInterval(() => {
        state.typingFrame++;
        render();
      }, 300);
    }
  } else {
    if (state.typingAnim) clearInterval(state.typingAnim);
    state.typingAnim = null;
    state.typingFrame = 0;
  }
  render();
}

export function startChat(onMessage: (text: string) => Promise<void>) {
  screen.key(["escape", "C-c"], () => process.exit(0));

  inputBox.on("submit", (value: string) => {
    const v = value.trim();
    inputBox.clearValue();
    screen.render();
    inputBox.focus();

    if (!v) return;
    if (v === "/quit") process.exit(0);

    addMessage("me", v);
    onMessage(v);
  });

  inputBox.focus();
  render();
}
