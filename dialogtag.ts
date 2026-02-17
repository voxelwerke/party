import { AutoTokenizer, env } from "@xenova/transformers";
import * as ort from "onnxruntime-node";
import path from "node:path";
import fs from "node:fs";

// Disable remote model downloads — we use local only
env.allowRemoteModels = false;
env.localModelPath = path.resolve("models");

// --- Label mapping (ported from DialogTag Python) ---

// Maps class index -> short code
const INDEX_TO_CODE: Record<string, string> = {
  "0": "fo_o_fw_\"_by_bc",
  "1": "ft",
  "2": "fc",
  "3": "qw",
  "4": "^g",
  "5": "bh",
  "6": "qy",
  "7": "qrr",
  "8": "fp",
  "9": "qo",
  "10": "bk",
  "11": "h",
  "12": "sv",
  "13": "ba",
  "14": "nn",
  "15": "^h",
  "16": "^2",
  "17": "aap_am",
  "18": "qw^d",
  "19": "qy^d",
  "20": "ng",
  "21": "fa",
  "22": "b",
  "23": "ny",
  "24": "t3",
  "25": "sd",
  "26": "br",
  "27": "oo_co_cc",
  "28": "arp_nd",
  "29": "t1",
  "30": "^q",
  "31": "aa",
  "32": "na",
  "33": "b^m",
  "34": "bd",
  "35": "ad",
  "36": "bf",
  "37": "qh",
};

// Load label_map.txt: maps short code -> human-readable name
function loadLabelMap(filePath: string): Record<string, string> {
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  const map: Record<string, string> = {};
  for (const line of lines) {
    const [name, code] = line.split("|");
    if (name && code) map[code.trim()] = name.trim();
  }
  return map;
}

const MODEL_DIR = path.resolve("models", "distilbert-base-uncased");
const CODE_TO_LABEL = loadLabelMap(path.join(MODEL_DIR, "label_map.txt"));

// Full mapping: index -> human label
function indexToLabel(idx: number): string {
  const code = INDEX_TO_CODE[String(idx)];
  if (!code) return "Unknown";
  return CODE_TO_LABEL[code] ?? code;
}

// --- Question tags (tags that indicate the user is asking something) ---

const QUESTION_TAGS = new Set([
  "Yes-No-Question",
  "Wh-Question",
  "Open-Question",
  "Declarative Yes-No-Question",
  "Declarative Wh-Question",
  "Backchannel in Question Form",
  "Tag-Question",
  "Rhetorical-Question",
  "Or-Clause",
  "Signal-non-understanding",
]);

const REPLY_TAGS = new Set([
  ...QUESTION_TAGS,
  "Action-directive",
  "Conventional-opening",
  "Conventional-closing",
  "Thanking",
  "Apology",
  "Offers, Options Commits",
]);

// --- Model loading ---

let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
let session: ort.InferenceSession | null = null;

async function ensureLoaded() {
  if (!tokenizer) {
    tokenizer = await AutoTokenizer.from_pretrained("distilbert-base-uncased");
  }
  if (!session) {
    const onnxPath = path.join(MODEL_DIR, "onnx", "model.onnx");
    session = await ort.InferenceSession.create(onnxPath);
  }
}

// Softmax over a Float32Array
function softmax(logits: Float32Array): Float32Array {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum) as Float32Array;
}

// --- Public API ---

export type DialogAct = {
  tag: string;
  confidence: number;
  isQuestion: boolean;
  shouldReply: boolean;
};

export async function classifyUtterance(text: string): Promise<DialogAct> {
  await ensureLoaded();

  // Tokenize
  const encoded = await tokenizer!(text, {
    truncation: true,
    padding: true,
    return_tensors: "pt",
  });

  const inputIds = encoded.input_ids.data as BigInt64Array;
  const attentionMask = encoded.attention_mask.data as BigInt64Array;

  // Convert to int64 tensors for ONNX Runtime
  const seqLen = inputIds.length;
  const idsTensor = new ort.Tensor("int64", inputIds, [1, seqLen]);
  const maskTensor = new ort.Tensor("int64", attentionMask, [1, seqLen]);

  // Run inference
  const results = await session!.run({
    input_ids: idsTensor,
    attention_mask: maskTensor,
  });

  const logits = results.logits.data as Float32Array;
  const probs = softmax(logits);

  // Get argmax
  let maxIdx = 0;
  let maxProb = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] > maxProb) {
      maxProb = probs[i];
      maxIdx = i;
    }
  }

  const tag = indexToLabel(maxIdx);
  return {
    tag,
    confidence: maxProb,
    isQuestion: QUESTION_TAGS.has(tag),
    shouldReply: REPLY_TAGS.has(tag),
  };
}
