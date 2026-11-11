import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { toolDefinitions, executeTool, findNearbyBusStops, DEFAULT_LOCATION } from "./tools.js";

// OpenCode Go endpoint and model (OpenAI-compatible).
const LLM_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const LLM_MODEL = "glm-5.3";

const LLM_TIMEOUT_MS = 20_000;
// Hard limit for one whole turn, across every model and tool call.
const TURN_DEADLINE_MS = 45_000;
const MAX_ROUNDS = 8;
const MAX_OUTPUT_TOKENS = 1024;

// Limits on the conversation history the browser sends.
const MAX_HISTORY_MESSAGES = 16;
const MAX_HISTORY_CHARS = 1500;

const EMPTY_REPLY = "Uncle blur already. Ask again?";
const TOO_MANY_ROUNDS = "Uncle tried too many times already. Ask something simpler.";
const TOO_SLOW = "Uncle took too long to check. Try again.";

/** Thrown when the server is missing configuration, such as an API key. */
export class ConfigError extends Error {
  name = "ConfigError";
}

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages;
 * pass it through sanitizeHistory first. sessionId should stay the same for
 * the whole conversation so the LLM endpoint can reuse its prompt cache.
 * location is {latitude, longitude, label} from parseUserLocation.
 */
export async function runLoop(
  history,
  message,
  env,
  sessionId = crypto.randomUUID(),
  location = DEFAULT_LOCATION,
) {
  if (!env.OPENCODE_API_KEY) {
    throw new ConfigError("OPENCODE_API_KEY is not set");
  }

  const stops = await findNearbyBusStops(location);
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    {
      role: "user",
      content: buildUserMessage(message, new Date(), { label: location.label, stops }),
    },
  ];
  const origin = { latitude: location.latitude, longitude: location.longitude };

  const deadline = Date.now() + TURN_DEADLINE_MS;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return TOO_SLOW;
    }

    const assistant = await callModel(
      messages,
      env,
      sessionId,
      Math.min(LLM_TIMEOUT_MS, remaining),
    );
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];

    // Keep only the fields the API expects back; drop reasoning text and
    // provider-specific extras so they are not re-sent every round.
    messages.push({
      role: "assistant",
      content: typeof assistant.content === "string" ? assistant.content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      const text = typeof assistant.content === "string" ? assistant.content.trim() : "";
      return text || EMPTY_REPLY;
    }

    // Independent tool calls run in parallel; results keep their call order.
    const results = await Promise.all(
      toolCalls.map(async (call, i) => {
        const name = call?.function?.name;
        const parsed = parseArgs(call?.function?.arguments);
        console.log(`round ${round}: ${name}`, parsed.args ?? parsed.error);
        const content = !name
          ? JSON.stringify({ error: "Tool call had no function name." })
          : parsed.error
            ? JSON.stringify({ error: parsed.error })
            : await executeTool(name, parsed.args, env, origin);
        return { role: "tool", tool_call_id: call?.id ?? `call_${i}`, content };
      }),
    );
    messages.push(...results);
  }

  return TOO_MANY_ROUNDS;
}

async function callModel(messages, env, sessionId, timeoutMs) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "lunch-uncle/1.0",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
      max_tokens: MAX_OUTPUT_TOKENS,
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status === 401 || res.status === 403) {
    throw new ConfigError(`LLM rejected the API key (${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("LLM returned a body that is not JSON");
  }
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new Error(`LLM response had no message: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return message;
}

/**
 * Parse a tool call's JSON arguments. Returns {args} or {error}.
 */
export function parseArgs(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { args: {} };
  }
  let args;
  try {
    args = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { error: "Tool arguments were not valid JSON. Call the tool again with valid arguments." };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { error: "Tool arguments must be a JSON object." };
  }
  return { args };
}

/**
 * Keep only user and assistant messages with text content, trim each one,
 * and keep only the most recent messages.
 */
export function sanitizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim() !== "",
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
}
