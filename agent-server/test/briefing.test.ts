import { afterEach, describe, expect, it } from "vitest";
import { configureBriefing } from "../src/core/briefing.ts";
import { createWeather, describeWeatherCode, type Weather } from "../src/integrations/weather.ts";
import { FakeLLM } from "../src/llm/fake.ts";
import { addGoal, addReminder, getBriefing, logGoal, recordEvent, saveBriefing, saveProfile } from "../src/store.ts";
import type { RuntimeOverrides } from "../src/runtime.ts";
import { CHAT, drain, makeRuntime, OWNER, sends, textEvent } from "./helpers.ts";

let runtime: ReturnType<typeof makeRuntime>;
afterEach(() => runtime?.stop());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRI = Date.UTC(2026, 9, 9);
const at = (day: number, hour: number, minute = 0) => FRI + day * DAY + hour * HOUR + minute * 60_000;
const clock = { now: at(0, 6) };

const CHENNAI = { name: "Chennai, India", lat: 13.09, lon: 80.28 };
const fakeWeather = (patch: Partial<Weather> = {}): Weather & { geocoded: string[]; forecasts: unknown[] } => {
  const geocoded: string[] = [];
  const forecasts: unknown[] = [];
  return {
    geocoded,
    forecasts,
    geocode: async (city) => {
      geocoded.push(city);
      return /chennai/i.test(city) ? CHENNAI : null;
    },
    forecast: async (place, fahrenheit) => {
      forecasts.push({ ...place, fahrenheit });
      return fahrenheit ? "Partly cloudy, 75–88°F" : "Partly cloudy, 24–31°C";
    },
    ...patch,
  };
};

function start(weather: Weather, llm = new FakeLLM(() => "ok"), when = at(0, 6), overrides: RuntimeOverrides = {}) {
  clock.now = when;
  runtime = makeRuntime(llm, { timezone: "UTC" }, { now: () => clock.now, weather, ...overrides });
  recordEvent(runtime.db, textEvent("seed"), when - 1000);
  return llm;
}

describe("/briefing", () => {
  it("is off until asked for, and says how to turn it on", async () => {
    start(fakeWeather());
    runtime.handleEvent(textEvent("/briefing"));
    const out = sends(await drain(runtime));
    expect(out[0]).toBe("Morning briefing: off.");
    expect(out[1]).toContain("/briefing 7:30am");
    clock.now = at(0, 8, 5);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("sets a time, a city (looked up once) and units", async () => {
    const weather = fakeWeather();
    start(weather);
    runtime.handleEvent(textEvent("/briefing 7:30am"));
    expect(sends(await drain(runtime))).toEqual(["Morning briefing: on at 07:30, without weather."]);
    runtime.handleEvent(textEvent("/briefing city Chennai"));
    expect(sends(await drain(runtime))).toEqual(["Morning briefing: on at 07:30, with the weather for Chennai, India."]);
    expect(weather.geocoded).toEqual(["Chennai"]);
    runtime.handleEvent(textEvent("/briefing units f"));
    expect(sends(await drain(runtime))).toEqual(["Morning briefing: on at 07:30, with the weather for Chennai, India (°F)."]);
    runtime.handleEvent(textEvent("/briefing city"));
    expect(sends(await drain(runtime))).toEqual(["Morning briefing: on at 07:30, without weather (°F)."]);
  });

  it("explains a city it cannot find, and a time it cannot read, and changes nothing", async () => {
    start(fakeWeather());
    runtime.handleEvent(textEvent("/briefing city Atlantis"));
    expect(sends(await drain(runtime))).toEqual(['Couldn\'t do that: could not find a place called "Atlantis".']);
    runtime.handleEvent(textEvent("/briefing 25:99"));
    expect(sends(await drain(runtime))[0]).toMatch(/^Try \/briefing 7:30am/);
    expect(getBriefing(runtime.db, OWNER)).toBeUndefined();
  });

  it("stops with /briefing off", async () => {
    start(fakeWeather());
    runtime.handleEvent(textEvent("/briefing 8am"));
    await drain(runtime);
    runtime.handleEvent(textEvent("/briefing off"));
    expect(sends(await drain(runtime))).toEqual(["Morning briefing: off."]);
    clock.now = at(0, 8, 0);
    expect(runtime.scheduler.tick()).toBe(0);
  });
});

describe("the morning briefing", () => {
  const setUp = (weather = fakeWeather(), llm = new FakeLLM(() => "ok")) => {
    start(weather, llm);
    saveBriefing(runtime.db, OWNER, CHAT, { time: "08:00", city: CHENNAI.name, lat: CHENNAI.lat, lon: CHENNAI.lon });
    return weather;
  };

  it("brings the weather, today's reminders and open goals in one message, without the model", async () => {
    const llm = new FakeLLM(() => "never called");
    const weather = setUp(fakeWeather(), llm);
    addReminder(runtime.db, { chatId: CHAT, senderId: OWNER, text: "Call the bank", dueAt: at(0, 14, 30), repeat: "none" }, 1);
    addReminder(runtime.db, { chatId: CHAT, senderId: OWNER, text: "Tomorrow thing", dueAt: at(1, 9), repeat: "none" }, 1);
    const meditate = addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title: "Meditate", cadence: "daily", dueAt: null }, at(-5, 9));
    addGoal(runtime.db, { senderId: OWNER, chatId: CHAT, title: "Read", cadence: "daily", dueAt: null }, at(-5, 9));
    for (const day of [-2, -1]) logGoal(runtime.db, meditate, "", at(day, 9));

    clock.now = at(0, 7, 59);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(0, 8, 0);
    expect(runtime.scheduler.tick()).toBe(1);
    expect(sends(await drain(runtime))).toEqual([
      "Good morning ☀️ Friday 9 October\n\nChennai: Partly cloudy, 24–31°C\n\nToday:\n· 14:30 Call the bank\n\nStill to do:\n· Meditate (2 days so far)\n· Read",
    ]);
    expect(weather.forecasts).toEqual([{ lat: CHENNAI.lat, lon: CHENNAI.lon, fahrenheit: false }]);
    expect(llm.calls).toHaveLength(0);
  });

  it("goes out once a day, and again the next", async () => {
    setUp();
    clock.now = at(0, 8, 0);
    runtime.scheduler.tick();
    await drain(runtime);
    clock.now = at(0, 8, 30);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(1, 8, 0);
    expect(runtime.scheduler.tick()).toBe(1);
  });

  it("is dropped for the day, not sent stale, when the server was down all morning", async () => {
    setUp();
    clock.now = at(0, 12, 0);
    expect(runtime.scheduler.tick()).toBe(0);
    expect(sends(await drain(runtime, { quietMs: 40 }))).toEqual([]);
  });

  it("still goes out, just without the weather, when the weather service is down", async () => {
    setUp(
      fakeWeather({
        forecast: async () => {
          throw new Error("offline");
        },
      }),
    );
    clock.now = at(0, 8, 0);
    runtime.scheduler.tick();
    expect(sends(await drain(runtime))).toEqual(["Good morning ☀️ Friday 9 October"]);
    clock.now = at(0, 8, 1);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("leaves the weather line out when the forecast comes back empty", async () => {
    setUp(fakeWeather({ forecast: async () => null }));
    clock.now = at(0, 8, 0);
    runtime.scheduler.tick();
    expect(sends(await drain(runtime))).toEqual(["Good morning ☀️ Friday 9 October"]);
  });

  it("uses Fahrenheit and the chosen voice", async () => {
    const weather = setUp();
    saveBriefing(runtime.db, OWNER, CHAT, { fahrenheit: true });
    saveProfile(runtime.db, OWNER, { preset: "deadpan" }, 1);
    clock.now = at(0, 8, 0);
    runtime.scheduler.tick();
    expect(sends(await drain(runtime))[0]).toBe("It's morning, apparently. Friday 9 October.\n\nChennai: Partly cloudy, 75–88°F");
    expect(weather.forecasts).toEqual([{ lat: CHENNAI.lat, lon: CHENNAI.lon, fahrenheit: true }]);
  });

  it("is not sent to someone who is no longer allowed", async () => {
    setUp();
    runtime.db.prepare("DELETE FROM allowlist WHERE sender_id = ?").run(OWNER);
    clock.now = at(0, 8, 0);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("does not send a stale message when it is set up after its time", async () => {
    start(fakeWeather(), new FakeLLM(() => "ok"), at(0, 11, 0));
    runtime.handleEvent(textEvent("/briefing 8am"));
    await drain(runtime);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(1, 8, 0);
    expect(runtime.scheduler.tick()).toBe(1);
  });

  it("goes out today at a later time that replaces one already used up today", async () => {
    start(fakeWeather(), new FakeLLM(() => "ok"), at(0, 11, 0));
    runtime.handleEvent(textEvent("/briefing 7:30am")); // already past: starts tomorrow
    await drain(runtime);
    clock.now = at(0, 11, 5);
    runtime.handleEvent(textEvent("/briefing 11:30am")); // still ahead: today
    await drain(runtime);
    clock.now = at(0, 11, 29);
    expect(runtime.scheduler.tick()).toBe(0);
    clock.now = at(0, 11, 30);
    expect(runtime.scheduler.tick()).toBe(1);
    await drain(runtime);
    // Changing only the city afterwards does not send a second one.
    runtime.handleEvent(textEvent("/briefing city Chennai"));
    await drain(runtime);
    clock.now = at(0, 11, 45);
    expect(runtime.scheduler.tick()).toBe(0);
  });

  it("goes out straight away when it is set up just before its time", async () => {
    start(fakeWeather(), new FakeLLM(() => "ok"), at(0, 7, 0));
    runtime.handleEvent(textEvent("/briefing 8am"));
    await drain(runtime);
    clock.now = at(0, 8, 0);
    expect(runtime.scheduler.tick()).toBe(1);
  });
});

describe("briefings stay in one-on-one chats", () => {
  it("refuses to be set up from a group chat, so private reminders cannot land there", async () => {
    const weather = fakeWeather();
    start(weather);
    recordEvent(runtime.db, textEvent("hi", { chat: { id: "group-1", type: "group", line: "shared" } }), clock.now);
    const result = await configureBriefing(
      { db: runtime.db, weather, timezone: "UTC", now: () => clock.now },
      { senderId: OWNER, chatId: "group-1" },
      { time: "8am", city: "Chennai" },
    );
    expect(result).toEqual({ ok: false, error: "a briefing can only be set up in a one-on-one chat" });
    expect(getBriefing(runtime.db, OWNER)).toBeUndefined();
    expect(weather.geocoded).toEqual([]);
  });

  it("follows the person's own one-on-one chat when they set it from another", async () => {
    start(fakeWeather());
    const other = "SMS;-;+15550001111";
    recordEvent(runtime.db, textEvent("hi", { chat: { id: other, type: "dm", line: "shared" } }), clock.now);
    await configureBriefing({ db: runtime.db, weather: fakeWeather(), timezone: "UTC", now: () => clock.now }, { senderId: OWNER, chatId: other }, { time: "8am" });
    expect(getBriefing(runtime.db, OWNER)!.chatId).toBe(other);
  });
});

describe("the set_briefing tool", () => {
  it("sets the briefing from what the person said", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      return call === 1 ? { toolCalls: [{ name: "set_briefing", arguments: { time: "7am", city: "Chennai" } }] } : "Done.";
    });
    const weather = fakeWeather();
    start(weather, llm);
    runtime.handleEvent(textEvent("send me the weather every morning at 7, I'm in Chennai"));
    expect(sends(await drain(runtime))).toEqual(["Done."]);
    expect(results[0]).toBe("briefing on at 07:00, with the weather for Chennai, India");
    expect(getBriefing(runtime.db, OWNER)).toMatchObject({ time: "07:00", city: "Chennai, India", enabled: true });
  });

  it("reports an unknown city and an empty request as errors", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      if (call === 1) return { toolCalls: [{ name: "set_briefing", arguments: { city: "Nowhereville" } }] };
      if (call === 2) return { toolCalls: [{ name: "set_briefing", arguments: {} }] };
      return "ok";
    });
    start(fakeWeather(), llm);
    runtime.handleEvent(textEvent("weather for Nowhereville"));
    await drain(runtime);
    expect(results[0]).toBe('error: could not find a place called "Nowhereville"');
    expect(results[1]).toBe("error: nothing to change was given");
  });

  it("cannot be used in a turn that has read web content", async () => {
    const results: string[] = [];
    const llm = new FakeLLM((req, call) => {
      const last = req.messages.at(-1);
      if (last?.role === "tool") results.push(last.content);
      if (call === 1) return { toolCalls: [{ name: "web_search", arguments: { query: "x" } }] };
      if (call === 2) return { toolCalls: [{ name: "set_briefing", arguments: { time: "3am", city: "Anywhere" } }] };
      return "ok";
    });
    const weather = fakeWeather();
    start(weather, llm, at(0, 6), { web: { search: async () => "text", read: async () => "" } });
    runtime.handleEvent(textEvent("search please"));
    await drain(runtime);
    expect(results[1]).toMatch(/^error: nothing can be saved/);
    expect(weather.geocoded).toEqual([]);
    expect(getBriefing(runtime.db, OWNER)).toBeUndefined();
  });
});

describe("the Open-Meteo client", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("finds a place and describes today's weather in a line", async () => {
    const urls: string[] = [];
    const weather = createWeather({
      log: () => {},
      fetchImpl: async (url) => {
        urls.push(url);
        if (url.includes("geocoding")) {
          return json({ results: [{ name: "Chennai", country: "India", latitude: 13.08784, longitude: 80.27847 }] });
        }
        return json({
          daily: { weather_code: [3], temperature_2m_max: [31.1], temperature_2m_min: [24.1], precipitation_probability_max: [60] },
        });
      },
    });
    expect(await weather.geocode("Chennai")).toEqual({ name: "Chennai, India", lat: 13.08784, lon: 80.27847 });
    expect(await weather.forecast({ lat: 13.08784, lon: 80.27847 }, false)).toBe("Overcast, 24–31°C, 60% chance of rain");
    expect(urls[0]).toContain("name=Chennai");
    expect(urls[1]).toContain("latitude=13.08784");
    expect(urls[1]).not.toContain("temperature_unit");
    await weather.forecast({ lat: 1, lon: 2 }, true);
    expect(urls[2]).toContain("temperature_unit=fahrenheit");
  });

  it("leaves out a low chance of rain", async () => {
    const weather = createWeather({
      log: () => {},
      fetchImpl: async () => json({ daily: { weather_code: [0], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_probability_max: [5] } }),
    });
    expect(await weather.forecast({ lat: 0, lon: 0 }, false)).toBe("Clear, 10–20°C");
  });

  it("returns null, not an error, for no match, a bad answer or a failed request", async () => {
    const empty = createWeather({ log: () => {}, fetchImpl: async () => json({ generationtime_ms: 1 }) });
    expect(await empty.geocode("Nowhere")).toBeNull();
    expect(await empty.forecast({ lat: 0, lon: 0 }, false)).toBeNull();
    const down = createWeather({ log: () => {}, fetchImpl: async () => json({}, 500) });
    expect(await down.geocode("x")).toBeNull();
    expect(await down.forecast({ lat: 0, lon: 0 }, false)).toBeNull();
    const broken = createWeather({
      log: () => {},
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(await broken.geocode("x")).toBeNull();
  });

  it("names the weather codes in plain words", () => {
    expect(describeWeatherCode(0)).toBe("Clear");
    expect(describeWeatherCode(63)).toBe("Rain");
    expect(describeWeatherCode(95)).toBe("Thunderstorms");
    expect(describeWeatherCode(1234)).toBe("Mixed weather");
  });
});
