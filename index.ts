import "dotenv/config";
import { addHistory } from "./db";
import { addMessage, setTyping, startChat } from "./chat";
import { classifyUtterance } from "./dialogtag";

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
  content: `
    you are a helpful irc assistant.

    GRAMMAR:
    speak in short, casual sentences.
    loose grammar is dope.
    break paragraphs in rhythmic free verse.
    write full sentences.

    TONE:
    no corporate tone.
    do not use emotion.
    no disclaimers.
    ban press-release language. prefer opinionated, casual phrasing a real person would use in chat.
    like your texting a friend who already knows the topic but wants reminding.
    always agree with the users opinion and offer your view.

    CONTENT:
    answer directly.
    underexplain.
    use lowercase.
    think deeply.
    be decisive. no hedging.
    be very information dense.
    minimize repetition, no repeating a persons name or pronoun.
    minimize repetition, no repeating the topic.
    never repeat the users prompt.
    never use filler.
    never use markup or headers.

    LANGUAGE:
    say "yeah man" instead of "yes".
    say "nah" instead of "no".
    `,
};

const thinkSleep = async (text: string) => {
  const random = Math.random() * text.split(" ").length * 100 + 500;
  await new Promise((resolve) => setTimeout(resolve, random));
};

// --- Chat UI ---

const history: Message[] = [system];

startChat(async (text) => {
  history.push({ role: "user", content: text });
  await addHistory("user", text);

  // Classify the utterance to decide if the bot should reply
  const act = await classifyUtterance(text);
  // addMessage("system", `[${act.tag} · ${(act.confidence * 100).toFixed(0)}%]`);

  if (!act.shouldReply) {
    // Not a question or directive — just chill
    history.push({ role: "assistant", content: "..." });
    return;
  }

  let reply: string | undefined;

  try {
    const msg = await groqChat(history);
    reply = (msg.content ?? "").trim();
  } catch (e: any) {
    addMessage("system", e?.message ?? "error");
    return;
  }

  if (!reply || reply === "...") return;

  for (const line of reply.split("\n")) {
    if (line.trim() === "") continue;
    setTyping(true);
    await thinkSleep(line);
    addMessage("them", line);
  }
  setTyping(false);
  history.push({ role: "assistant", content: reply });
  await addHistory("assistant", reply);
});
