// agent.ts
// Minimal CLI "agent" with tool/function calling via Groq + Llama 3.1 70B.
// Dependencies: none (uses Node 18+ built-ins).
//
// Run:
//   GROQ_API_KEY=... node --loader ts-node/esm agent.ts
// or compile with tsc then:
//   GROQ_API_KEY=... node dist/agent.js
//
// Env (optional):
//   GROQ_MODEL=llama-3.1-70b-versatile  (or whatever your Groq account exposes)

import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import MiniSearch from "minisearch";
import {
  setMemory,
  getMemory,
  listMemories,
  addHistory,
  searchHistory,
  getHistoryContext,
} from "./db";

type Role = "system" | "user" | "assistant" | "tool";

type Message =
  | {
      role: "system" | "user" | "assistant";
      content: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; content: string; tool_call_id: string };

type ToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: any; // JSON Schema
  };
};

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("Set GROQ_API_KEY in your environment.");
  process.exit(1);
}

const MODEL = process.env.GROQ_MODEL ?? "llama-3.1-8b-instant";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEBUG = process.env.DEBUG === "1";
let totalTokens = 0;

function nowISO() {
  return new Date().toISOString();
}

function safeJsonParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Tools (functions) the model can call ---

const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current time in ISO format.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calc",
      description: "Evaluate a basic arithmetic expression (no variables).",
      parameters: {
        type: "object",
        properties: {
          expr: { type: "string", description: "e.g. '(2+3)*10/4'" },
        },
        required: ["expr"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Store a small note in memory for this session.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Recall a stored note by key.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description: "List all stored memories.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_history",
      description: "Full-text search across all past conversation messages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history_context",
      description:
        "Get a history message by id plus the 2 messages before and after it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "History row id" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

// --- Tool search index (MiniSearch) ---

const toolIndex = new MiniSearch({
  fields: ["name", "description"],
  storeFields: ["name"],
});
toolIndex.addAll(
  tools.map((t, i) => ({
    id: i,
    name: t.function.name,
    description: t.function.description ?? "",
  }))
);

function findTools(query: string): ToolDef[] {
  const results = toolIndex.search(query, { fuzzy: 0.2, prefix: true });
  if (!results.length) return tools; // fallback: all tools
  const names = new Set(results.map((r: any) => r.name));
  return tools.filter((t) => names.has(t.function.name));
}

async function runTool(name: string, args: any): Promise<string> {
  if (name === "get_time") return nowISO();

  if (name === "calc") {
    const expr = String(args?.expr ?? "");
    if (!/^[0-9+\-*/().\s]+$/.test(expr))
      return "Error: invalid characters in expression.";
    try {
      const val = Function(`"use strict"; return (${expr});`)();
      if (typeof val !== "number" || Number.isNaN(val) || !Number.isFinite(val))
        return "Error: non-finite result.";
      return String(val);
    } catch (e: any) {
      return `Error: ${e?.message ?? "failed to evaluate."}`;
    }
  }

  if (name === "remember") {
    const key = String(args?.key ?? "");
    const value = String(args?.value ?? "");
    if (!key) return "Error: key required.";
    await setMemory(key, value);
    return "ok";
  }

  if (name === "recall") {
    const key = String(args?.key ?? "");
    if (!key) return "Error: key required.";
    return await getMemory(key);
  }

  if (name === "list_memories") {
    const rows = await listMemories();
    if (!rows.length) return "No memories stored.";
    return JSON.stringify(rows);
  }

  if (name === "search_history") {
    const query = String(args?.query ?? "");
    if (!query) return "Error: query required.";
    const rows = await searchHistory(query);
    if (!rows.length) return "No results.";
    return JSON.stringify(rows);
  }

  if (name === "get_history_context") {
    const id = Number(args?.id);
    if (!id) return "Error: id required.";
    const rows = await getHistoryContext(id);
    if (!rows.length) return "No history found.";
    return JSON.stringify(rows);
  }

  return `Error: unknown tool '${name}'.`;
}

// --- Groq chat call ---

type GroqToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type GroqChoice = {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: GroqToolCall[];
  };
};

async function groqChat(messages: Message[], opts?: { tools?: ToolDef[] }) {
  const body: any = {
    model: MODEL,
    messages,
    temperature: 0,
  };
  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (DEBUG) {
    const last = messages[messages.length - 1];
    console.error(
      chalk.gray(
        `> ${last.role}: ${("content" in last ? last.content : "").slice(
          0,
          120
        )}`
      )
    );
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq error ${res.status}: ${t}`);
  }

  const json = (await res.json()) as {
    choices: GroqChoice[];
    usage?: { total_tokens: number };
  };
  if (DEBUG) {
    const reply = json.choices[0]?.message;
    const txt = reply?.content?.slice(0, 120) ?? "";
    const tools =
      reply?.tool_calls?.map((t) => t.function.name).join(", ") ?? "";
    console.error(chalk.grey(`< ${txt}${tools ? ` [tools: ${tools}]` : ""}`));
  }
  totalTokens += json.usage?.total_tokens ?? 0;
  return json.choices[0].message;
}

// --- Minimal agent loop: model may call tools; we execute; feed results back ---

const system: Message = {
  role: "system",
  content:
    "You are a helpful terminal agent. Answer the user directly. " +
    "After every reply, append exactly one line: confidence: N% " +
    "where N reflects how sure you are WITHOUT needing external data. " +
    "High (70-100): you can answer from general knowledge alone. " +
    "Low (0-49): the answer requires real-time info (current time, live data), " +
    "precise computation, stored memories, or past conversation history you don't have. " +
    "Be honest — if you're guessing at something a tool could verify, say so.",
};

function parseConfidence(text: string): number {
  const match = text.match(/confidence:\s*(\d+)%/i);
  return match ? parseInt(match[1], 10) : 100;
}

async function agentTurn(history: Message[]) {
  // Phase 1: No tools — just think and reply with confidence
  const firstMsg = await groqChat(history);
  const firstText = (firstMsg.content ?? "").trim();
  const confidence = parseConfidence(firstText);

  if (DEBUG) {
    console.error(chalk.yellow(`  confidence: ${confidence}%`));
  }

  // High confidence? Ship it.
  if (confidence >= 50) {
    history.push({ role: "assistant", content: firstText });
    return firstText;
  }

  // Phase 2: Low confidence — fuzzy match tools and re-prompt
  const userMsg = [...history].reverse().find((m) => m.role === "user");
  const query = userMsg && "content" in userMsg ? userMsg.content : firstText;
  const matched = findTools(query);

  if (DEBUG) {
    console.error(
      chalk.yellow(
        `  tools matched: ${matched.map((t) => t.function.name).join(", ")}`
      )
    );
  }

  // Push the uncertain response, then nudge with tools
  history.push({ role: "assistant", content: firstText });
  history.push({
    role: "user",
    content:
      "You now have tools available. Use them to provide a precise answer.",
  });

  // Tool loop
  for (let i = 0; i < 6; i++) {
    const msg = await groqChat(history, { tools: matched });

    if (msg.tool_calls && msg.tool_calls.length) {
      history.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls) {
        const args = safeJsonParse(tc.function.arguments) ?? {};
        const out = await runTool(tc.function.name, args);
        history.push({ role: "tool", tool_call_id: tc.id, content: out });
      }
      continue;
    }

    const text = (msg.content ?? "").trim();
    history.push({ role: "assistant", content: text });
    return text;
  }

  return "Tool loop limit reached.";
}

// --- CLI ---

const rl = readline.createInterface({ input, output, terminal: true });

const history: Message[] = [system];

function prompt() {
  rl.question(chalk.green(`[${totalTokens}tok] > `), async (line) => {
    const q = line.trim();
    if (!q) return prompt();
    if (q === "/exit" || q === "/quit") {
      rl.close();
      return;
    }

    history.push({ role: "user", content: q });
    await addHistory("user", q);

    try {
      const out = await agentTurn(history);
      await addHistory("assistant", out);
      console.log(chalk.white(out));
    } catch (e: any) {
      console.error(e?.message ?? e);
    }

    prompt();
  });
}

console.log(chalk.cyan(`Groq model: ${MODEL}`));
console.log(chalk.dim("Type /exit to quit."));
prompt();
