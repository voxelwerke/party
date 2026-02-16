import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { addHistory } from "./db";

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
    parameters: any;
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

// --- Tools ---

const tools: ToolDef[] = [];

// --- Groq chat call ---

type GroqChoice = {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  };
};

async function groqChat(messages: Message[]) {
  const body: any = {
    model: MODEL,
    messages,
    temperature: 0,
  };
  if (tools.length) {
    body.tools = tools;
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
    const tc = reply?.tool_calls?.map((t) => t.function.name).join(", ") ?? "";
    console.error(chalk.grey(`< ${txt}${tc ? ` [tools: ${tc}]` : ""}`));
  }
  totalTokens += json.usage?.total_tokens ?? 0;
  return json.choices[0].message;
}

// --- System prompt ---

const system: Message = {
  role: "system",
  content:
    "You are a helpful irc assistant. use lowercase. do not use emotion. think deeply. reply with '...' unless directly asked. use yup instead yes",
};

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
      const msg = await groqChat(history);
      const text = (msg.content ?? "").trim();
      history.push({ role: "assistant", content: text });
      await addHistory("assistant", text);
      console.log(chalk.white(text));
    } catch (e: any) {
      console.error(e?.message ?? e);
    }

    prompt();
  });
}

console.log(chalk.cyan(`Groq model: ${MODEL}`));
console.log(chalk.dim("Type /exit to quit."));
prompt();
