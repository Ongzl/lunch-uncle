/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

// CT Hub 2, 114 Lavender Street. The default when the user sets no location.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };
export const DEFAULT_LOCATION = { ...CT_HUB_2, label: "CT Hub 2, 114 Lavender Street" };

// A box around mainland Singapore and Sentosa; locations outside it are rejected.
const SINGAPORE_BOUNDS = {
  low: { latitude: 1.15, longitude: 103.59 },
  high: { latitude: 1.48, longitude: 104.1 },
};

// Bus stops on Lavender Street closest to CT Hub 2.
export const NEARBY_BUS_STOPS = [
  { code: "07361", name: "Bef Kallang Bahru (CT Hub 2 side)", distance_m: 48 },
  { code: "07369", name: "Aft Kallang Bahru (opposite side)", distance_m: 98 },
];

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES_FETCHED = 10;
const MAX_PLACES_RETURNED = 5;
const FORECAST_AREA = "Kallang";
const NEARBY_STOP_COUNT = 2;
const MAX_LOCATION_LABEL_CHARS = 80;
const MAX_GEOCODE_RESULTS = 5;
const TOOL_TIMEOUT_MS = 8_000;

// How long each tool's results are reused before fetching again.
const PLACES_TTL_MS = 10 * 60_000;
const FORECAST_TTL_MS = 5 * 60_000;
const BUS_TTL_MS = 20_000;
const BUS_STOPS_TTL_MS = 24 * 60 * 60_000;
const GEOCODE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 200;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";
const BUS_STOPS_URL = "https://data.busrouter.sg/v1/stops.min.json";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        `Search for places to eat within ${SEARCH_RADIUS_METRES} m of the user's location, nearest first. ` +
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
        "Get the current two-hour weather forecast for the area nearest the user's location. " +
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
        "The stops nearest the user are listed in their message.",
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
export async function executeTool(name, args, env, origin = CT_HUB_2) {
  const invalid = validateToolArgs(name, args);
  if (invalid) {
    return JSON.stringify({ error: invalid });
  }
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(await findLunchPlaces(args, env, origin));
      case "get_rain_forecast":
        return JSON.stringify(await getRainForecast(origin));
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

async function findLunchPlaces({ query, open_now = false }, env, origin) {
  if (!env.GOOGLE_PLACES_API_KEY) {
    return { error: "Place search is not set up on this server." };
  }
  const where = `${origin.latitude.toFixed(4)},${origin.longitude.toFixed(4)}`;
  const key = `places:${where}:${query.trim().toLowerCase()}:${open_now}`;
  return cached(key, PLACES_TTL_MS, async () => {
    const body = {
      textQuery: query,
      openNow: open_now,
      pageSize: MAX_PLACES_FETCHED,
      locationRestriction: {
        rectangle: boundingBox(origin, SEARCH_RADIUS_METRES),
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
      places: formatPlaces(res.data?.places ?? [], origin, {
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

async function getRainForecast(origin) {
  const res = await cached("forecast", FORECAST_TTL_MS, async () => {
    const r = await fetchJson(FORECAST_URL);
    return r.ok ? { payload: r.data } : { error: `Forecast API returned ${r.status}` };
  });
  if (res.error) {
    return res;
  }
  const area = nearestForecastArea(res.payload?.data?.area_metadata, origin) ?? FORECAST_AREA;
  return formatForecast(res.payload, area);
}

/**
 * The name of the forecast area whose label point is closest to origin,
 * or null if the metadata has no usable areas.
 */
export function nearestForecastArea(areaMetadata, origin) {
  if (!Array.isArray(areaMetadata)) {
    return null;
  }
  let best = null;
  for (const a of areaMetadata) {
    if (typeof a?.name !== "string" || !hasCoordinates(a.label_location)) continue;
    const d = haversineMetres(origin, a.label_location);
    if (!best || d < best.d) best = { name: a.name, d };
  }
  return best?.name ?? null;
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

// ---------------------------------------------------------------------------
// User location
// ---------------------------------------------------------------------------

/**
 * True if point is inside the Singapore bounding box.
 */
export function isInSingapore(point) {
  return (
    hasCoordinates(point) &&
    point.latitude >= SINGAPORE_BOUNDS.low.latitude &&
    point.latitude <= SINGAPORE_BOUNDS.high.latitude &&
    point.longitude >= SINGAPORE_BOUNDS.low.longitude &&
    point.longitude <= SINGAPORE_BOUNDS.high.longitude
  );
}

/**
 * Validate a location sent by the browser. Returns {location} with a cleaned
 * label, or {error}. A missing location means the default, CT Hub 2.
 */
export function parseUserLocation(raw) {
  if (raw === undefined || raw === null) {
    return { location: DEFAULT_LOCATION };
  }
  if (typeof raw !== "object" || !hasCoordinates(raw)) {
    return { error: "location must have numeric latitude and longitude." };
  }
  if (!isInSingapore(raw)) {
    return { error: "Uncle only knows Singapore. Pick a location in Singapore." };
  }
  // The label goes into the prompt, so keep it short and plain.
  const label =
    typeof raw.label === "string"
      ? raw.label
          .replace(/[^\p{L}\p{N} ,.'#&()\/-]/gu, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_LOCATION_LABEL_CHARS)
      : "";
  return {
    location: {
      latitude: raw.latitude,
      longitude: raw.longitude,
      label: label || "The user's chosen location",
    },
  };
}

/**
 * The bus stops nearest to origin.
 * stops is the busrouter map: { code: [longitude, latitude, name, road] }.
 */
export function nearestBusStops(stops, origin, count = NEARBY_STOP_COUNT) {
  if (!stops || typeof stops !== "object") {
    return [];
  }
  return Object.entries(stops)
    .filter(([, v]) => Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number")
    .map(([code, [longitude, latitude, name, road]]) => ({
      code,
      name: [name, road].filter(Boolean).join(", "),
      distance_m: Math.round(haversineMetres(origin, { latitude, longitude })),
    }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, count);
}

/**
 * The bus stops nearest to a location. Never throws; returns [] on failure.
 */
export async function findNearbyBusStops(location) {
  if (location.latitude === CT_HUB_2.latitude && location.longitude === CT_HUB_2.longitude) {
    return NEARBY_BUS_STOPS;
  }
  try {
    const res = await cached("bus-stops", BUS_STOPS_TTL_MS, async () => {
      const r = await fetchJson(BUS_STOPS_URL);
      return r.ok ? { stops: r.data } : { error: `Bus stop list returned ${r.status}` };
    });
    return res.error ? [] : nearestBusStops(res.stops, location);
  } catch (err) {
    console.error("bus stop lookup failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Address search for the location picker
// ---------------------------------------------------------------------------

/**
 * Look up a Singapore address, postal code or place name.
 * Returns {results} or {error}.
 */
export async function geocode(query, env) {
  if (!env.GOOGLE_PLACES_API_KEY) {
    return { error: "Address search is not set up on this server." };
  }
  const key = `geocode:${query.trim().toLowerCase()}`;
  return cached(key, GEOCODE_TTL_MS, async () => {
    const res = await fetchJson(PLACES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({
        textQuery: query,
        regionCode: "SG",
        pageSize: MAX_GEOCODE_RESULTS,
        locationRestriction: { rectangle: SINGAPORE_BOUNDS },
      }),
    });
    if (!res.ok) {
      return { error: `Address search returned ${res.status}` };
    }
    return { results: formatGeocodeResults(res.data?.places) };
  });
}

/**
 * Shape Places results into location choices inside Singapore.
 */
export function formatGeocodeResults(places) {
  if (!Array.isArray(places)) {
    return [];
  }
  return places
    .filter((p) => p && isInSingapore(p.location))
    .slice(0, MAX_GEOCODE_RESULTS)
    .map((p) => ({
      label: p.displayName?.text ?? p.formattedAddress ?? "Unnamed place",
      address: p.formattedAddress ?? "",
      latitude: p.location.latitude,
      longitude: p.location.longitude,
    }));
}
