import { addHistory } from "./db";
import { addMessage, setTyping, startChat } from "./chat";

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

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq error ${res.status}: ${t}`);
  }

  const json = (await res.json()) as {
    choices: GroqChoice[];
    usage?: { total_tokens: number };
  };
  return json.choices[0].message;
}

// --- System prompt ---

const system: Message = {
  role: "system",
  content:
    "You are a helpful irc assistant. use lowercase. do not use emotion. think deeply. reply with '...' unless directly asked. use yup instead yes",
};

// --- Chat UI ---

const history: Message[] = [system];

startChat(async (text) => {
  history.push({ role: "user", content: text });
  await addHistory("user", text);

  setTyping(true);
  try {
    const msg = await groqChat(history);
    const reply = (msg.content ?? "").trim();
    history.push({ role: "assistant", content: reply });
    await addHistory("assistant", reply);
    setTyping(false);
    addMessage("them", reply);
  } catch (e: any) {
    setTyping(false);
    addMessage("system", e?.message ?? "error");
  }
});
