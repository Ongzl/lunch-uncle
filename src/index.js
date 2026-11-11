import ui from "./ui.html";
import { runLoop, sanitizeHistory, ConfigError } from "./loop.js";
import { geocode, parseUserLocation } from "./tools.js";

const MAX_MESSAGE_CHARS = 500;
const MAX_BODY_BYTES = 64 * 1024;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_GEOCODE_QUERY_CHARS = 100;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      if (request.method === "GET" || request.method === "HEAD") {
        return new Response(request.method === "HEAD" ? null : ui, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return methodNotAllowed("GET, HEAD");
    }

    if (pathname === "/chat") {
      if (request.method === "POST") {
        return handleChat(request, env);
      }
      return methodNotAllowed("POST");
    }

    if (pathname === "/geocode") {
      if (request.method === "GET") {
        return handleGeocode(request, env);
      }
      return methodNotAllowed("GET");
    }

    return new Response("Not found", { status: 404 });
  },
};

// Look up an address, postal code or place name for the location picker.
async function handleGeocode(request, env) {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2 || q.length > MAX_GEOCODE_QUERY_CHARS) {
    return json({ error: `Type between 2 and ${MAX_GEOCODE_QUERY_CHARS} characters.` }, 400);
  }
  try {
    const result = await geocode(q, env);
    if (result.error) {
      console.error("geocode failed:", result.error);
      return json({ error: "Address search is not working right now. Try again later." }, 502);
    }
    return json(result);
  } catch (err) {
    console.error("geocode failed:", err);
    return json({ error: "Address search is not working right now. Try again later." }, 502);
  }
}

async function handleChat(request, env) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }

  let text;
  try {
    text = await request.text();
  } catch {
    return json({ error: "Could not read the request body." }, 400);
  }
  if (text.length > MAX_BODY_BYTES) {
    return json({ error: "Request is too large." }, 413);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Body must be a JSON object." }, 400);
  }

  const { history = [], message, sessionId, location: rawLocation } = body;
  if (typeof message !== "string" || message.trim() === "") {
    return json({ error: "message is required." }, 400);
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: `Keep your message under ${MAX_MESSAGE_CHARS} characters.` }, 400);
  }
  if (!Array.isArray(history)) {
    return json({ error: "history must be an array." }, 400);
  }

  const { location, error: locationError } = parseUserLocation(rawLocation);
  if (locationError) {
    return json({ error: locationError }, 400);
  }

  const session =
    typeof sessionId === "string" && SESSION_ID.test(sessionId)
      ? sessionId
      : crypto.randomUUID();

  try {
    const reply = await runLoop(sanitizeHistory(history), message.trim(), env, session, location);
    return json({ reply });
  } catch (err) {
    console.error("chat failed:", err);
    if (err instanceof ConfigError) {
      return json({ error: "Uncle is not set up properly. Ask the person running this app to check the API keys." }, 500);
    }
    if (err?.name === "TimeoutError") {
      return json({ error: "Uncle took too long to think. Try again." }, 504);
    }
    return json({ error: "Uncle cannot think right now, try again later." }, 502);
  }
}

function methodNotAllowed(allow) {
  return new Response("Method not allowed", { status: 405, headers: { allow } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
