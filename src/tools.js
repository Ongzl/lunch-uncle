/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

// Bus stops on Lavender Street closest to CT Hub 2.
export const NEARBY_BUS_STOPS = [
  { code: "07361", name: "Bef Kallang Bahru (CT Hub 2 side)", distance_m: 48 },
  { code: "07369", name: "Aft Kallang Bahru (opposite side)", distance_m: 98 },
];

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES_FETCHED = 10;
const MAX_PLACES_RETURNED = 5;
const FORECAST_AREA = "Kallang";
const TOOL_TIMEOUT_MS = 8_000;

// How long each tool's results are reused before fetching again.
const PLACES_TTL_MS = 10 * 60_000;
const FORECAST_TTL_MS = 5 * 60_000;
const BUS_TTL_MS = 20_000;
const CACHE_MAX_ENTRIES = 200;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        `Search for places to eat within ${SEARCH_RADIUS_METRES} m of CT Hub 2, nearest first. ` +
        "Returns name, rating, walking distance in metres, and open_now (true, false, or null when unknown).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "hawker centre".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the current two-hour weather forecast for the Kallang area, which covers CT Hub 2. " +
        "It only covers the period in valid_period, not later in the day.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code. " +
        `Stops next to CT Hub 2: ${NEARBY_BUS_STOPS.map((s) => `${s.code} (${s.name})`).join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07361".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Check a tool call's arguments. Returns an error message, or null if valid.
 */
export function validateToolArgs(name, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "Arguments must be a JSON object.";
  }
  switch (name) {
    case "find_lunch_places":
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return "query is required and must be a non-empty string.";
      }
      if (args.open_now !== undefined && typeof args.open_now !== "boolean") {
        return "open_now must be true or false.";
      }
      return null;
    case "get_rain_forecast":
      return null;
    case "get_bus_arrivals":
      if (typeof args.stop_code !== "string" || !/^\d{5}$/.test(args.stop_code)) {
        return "stop_code must be a five-digit string, e.g. \"07361\".";
      }
      return null;
    default:
      return `Unknown tool: ${name}`;
  }
}

/**
 * Run one tool call requested by the model and return the result as a string.
 * Never throws: failures come back as {error} so the model can work around them.
 */
export async function executeTool(name, args, env) {
  const invalid = validateToolArgs(name, args);
  if (invalid) {
    return JSON.stringify({ error: invalid });
  }
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast());
      case "get_bus_arrivals":
        return JSON.stringify(await getBusArrivals(args));
    }
  } catch (err) {
    console.error(`tool ${name} failed:`, err);
    const reason = err?.name === "TimeoutError" ? "timed out" : "failed";
    return JSON.stringify({ error: `The ${name} service ${reason}. Tell the user you could not check.` });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (IO)
// ---------------------------------------------------------------------------

const cache = new Map();

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.value;
  }
  const value = await load();
  if (!value?.error) {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    if (cache.size > CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }
  return value;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  if (!res.ok) {
    return { ok: false, status: res.status };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, status: res.status, notJson: true };
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env) {
  if (!env.GOOGLE_PLACES_API_KEY) {
    return { error: "Place search is not set up on this server." };
  }
  const key = `places:${query.trim().toLowerCase()}:${open_now}`;
  return cached(key, PLACES_TTL_MS, async () => {
    const body = {
      textQuery: query,
      openNow: open_now,
      pageSize: MAX_PLACES_FETCHED,
      locationRestriction: {
        rectangle: boundingBox(CT_HUB_2, SEARCH_RADIUS_METRES),
      },
    };

    const res = await fetchJson(PLACES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.location,places.rating,places.currentOpeningHours.openNow",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return { error: `Places API returned ${res.status}` };
    }
    return {
      places: formatPlaces(res.data?.places ?? [], CT_HUB_2, {
        maxDistance: SEARCH_RADIUS_METRES,
        limit: MAX_PLACES_RETURNED,
      }),
    };
  });
}

/**
 * The rectangle that contains a circle of radiusMetres around centre.
 */
export function boundingBox(centre, radiusMetres) {
  const dLat = radiusMetres / 111_320;
  const dLng = radiusMetres / (111_320 * Math.cos((centre.latitude * Math.PI) / 180));
  return {
    low: { latitude: centre.latitude - dLat, longitude: centre.longitude - dLng },
    high: { latitude: centre.latitude + dLat, longitude: centre.longitude + dLng },
  };
}

/**
 * Shape Places API results into the fields Uncle needs: within maxDistance of
 * origin, nearest first, at most limit places.
 */
export function formatPlaces(places, origin, { maxDistance = Infinity, limit = Infinity } = {}) {
  if (!Array.isArray(places)) {
    return [];
  }
  return places
    .filter((p) => p && hasCoordinates(p.location))
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: typeof rating === "number" ? rating : null,
      distance_m: Math.round(haversineMetres(origin, location)),
      open_now:
        typeof currentOpeningHours?.openNow === "boolean"
          ? currentOpeningHours.openNow
          : null,
    }))
    .filter((p) => p.distance_m <= maxDistance)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

function hasCoordinates(point) {
  return typeof point?.latitude === "number" && typeof point?.longitude === "number";
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  return cached("forecast", FORECAST_TTL_MS, async () => {
    const res = await fetchJson(FORECAST_URL);
    if (!res.ok) {
      return { error: `Forecast API returned ${res.status}` };
    }
    return formatForecast(res.data, FORECAST_AREA);
  });
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item || !Array.isArray(item.forecasts)) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find((f) => f?.area === area);
  return {
    area,
    forecast: typeof entry?.forecast === "string" ? entry.forecast : "Unknown",
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

async function getBusArrivals({ stop_code }) {
  return cached(`bus:${stop_code}`, BUS_TTL_MS, async () => {
    const res = await fetchJson(`${BUS_URL}?id=${encodeURIComponent(stop_code)}`);
    if (!res.ok) {
      return { error: `Bus API returned ${res.status}` };
    }
    return formatBusArrivals(res.data, stop_code);
  });
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  return {
    stop_code: stopCode,
    services: services
      .filter((s) => s && s.no != null)
      .map((s) => ({
        service: String(s.no),
        next_min: minutesFromNow(s.next),
        subsequent_min: minutesFromNow(s.subsequent),
      })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
