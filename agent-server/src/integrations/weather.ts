// Weather and place lookup from Open-Meteo: free, no key, no account. Only a
// city name or a pair of coordinates leaves this server, and only for someone
// who asked for a morning briefing with the weather in it.
import type { FetchLike } from "../llm/openai.ts";

export type Place = { name: string; lat: number; lon: number };

export type Weather = {
  /** The best match for a city name, or null when there is none. */
  geocode: (city: string, signal?: AbortSignal) => Promise<Place | null>;
  /** One line for today, e.g. "Partly cloudy, 24–31°C, 10% chance of rain". Null when unavailable. */
  forecast: (place: { lat: number; lon: number }, fahrenheit: boolean, signal?: AbortSignal) => Promise<string | null>;
};

const TIMEOUT_MS = 8000;

// WMO weather interpretation codes, grouped to the words a person would use.
const CODES: [number[], string][] = [
  [[0], "Clear"],
  [[1], "Mostly clear"],
  [[2], "Partly cloudy"],
  [[3], "Overcast"],
  [[45, 48], "Foggy"],
  [[51, 53, 55, 56, 57], "Drizzle"],
  [[61, 63, 65, 66, 67], "Rain"],
  [[71, 73, 75, 77], "Snow"],
  [[80, 81, 82], "Showers"],
  [[85, 86], "Snow showers"],
  [[95, 96, 99], "Thunderstorms"],
];

export const describeWeatherCode = (code: number): string => CODES.find(([codes]) => codes.includes(code))?.[1] ?? "Mixed weather";

export function createWeather(deps: { fetchImpl?: FetchLike; log: (message: string) => void }): Weather {
  const doFetch: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  async function getJson(url: string, signal?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await doFetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  return {
    async geocode(city, signal) {
      try {
        const data = await getJson(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
          signal,
        );
        const hit = data?.results?.[0];
        if (!hit || typeof hit.latitude !== "number" || typeof hit.longitude !== "number") return null;
        return { name: [hit.name, hit.country].filter(Boolean).join(", "), lat: hit.latitude, lon: hit.longitude };
      } catch (err) {
        if (signal?.aborted) throw err;
        deps.log(`place lookup failed: ${err}`);
        return null;
      }
    },

    async forecast(place, fahrenheit, signal) {
      try {
        const unit = fahrenheit ? "&temperature_unit=fahrenheit" : "";
        const data = await getJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1${unit}`,
          signal,
        );
        const day = data?.daily;
        const [code, high, low, rain] = [day?.weather_code?.[0], day?.temperature_2m_max?.[0], day?.temperature_2m_min?.[0], day?.precipitation_probability_max?.[0]];
        if (typeof code !== "number" || typeof high !== "number" || typeof low !== "number") return null;
        const symbol = fahrenheit ? "°F" : "°C";
        const chance = typeof rain === "number" && rain >= 20 ? `, ${Math.round(rain)}% chance of rain` : "";
        return `${describeWeatherCode(code)}, ${Math.round(low)}–${Math.round(high)}${symbol}${chance}`;
      } catch (err) {
        if (signal?.aborted) throw err;
        deps.log(`forecast failed: ${err}`);
        return null;
      }
    },
  };
}

/** Used when nothing can reach the network (tests, offline): every lookup comes back empty. */
export const noWeather: Weather = { geocode: async () => null, forecast: async () => null };
