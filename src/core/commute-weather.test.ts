import { describe, expect, it } from 'vitest';
import {
  type OpenMeteoResponse,
  buildForecastUrl,
  distillForecast,
  parseDayOffset,
  parseOpenMeteoResponse,
  round,
} from './commute-weather.js';

describe('round', () => {
  it('rounds numbers and maps undefined to null', () => {
    expect(round(3.4)).toBe(3);
    expect(round(3.6)).toBe(4);
    expect(round(undefined)).toBeNull();
    expect(round(0)).toBe(0);
  });
});

describe('parseDayOffset', () => {
  it('defaults to 0 when absent', () => {
    expect(parseDayOffset(undefined)).toEqual({ ok: true, value: 0 });
  });

  it.each(['0', '1', '6'])('accepts in-range integer %s', (raw) => {
    expect(parseDayOffset(raw)).toEqual({ ok: true, value: Number(raw) });
  });

  it('treats an empty string as 0 (Number("") === 0), matching a bare invocation', () => {
    expect(parseDayOffset('')).toEqual({ ok: true, value: 0 });
  });

  it.each(['-1', '7', '1.5', 'foo'])('rejects out-of-range/non-integer %j', (raw) => {
    const result = parseDayOffset(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dayOffset');
  });
});

describe('buildForecastUrl', () => {
  it('encodes the timezone and sets forecast_days to dayOffset + 1', () => {
    const url = buildForecastUrl('55.6', '12.5', 'Europe/Copenhagen', 1);
    expect(url).toContain('latitude=55.6');
    expect(url).toContain('longitude=12.5');
    expect(url).toContain('timezone=Europe%2FCopenhagen');
    expect(url).toContain('forecast_days=2');
  });
});

describe('distillForecast', () => {
  const response: OpenMeteoResponse = {
    hourly: {
      time: [
        '2026-07-16T06:00',
        '2026-07-16T07:00',
        '2026-07-16T08:00',
        '2026-07-17T07:00',
        '2026-07-17T08:00',
      ],
      temperature_2m: [14, 15, 16, 20, 21],
      apparent_temperature: [13, 14, 15, 19, 20],
      precipitation_probability: [10, 40, 60, 0, 0],
      precipitation: [0, 0.2, 1.5, 0, 0],
      wind_speed_10m: [10, 12, 14, 5, 6],
      wind_gusts_10m: [20, 25, 30, 0, 0],
      weather_code: [1, 2, 3, 0, 0],
    },
  };

  it('extracts the 07:00/08:00 rows for today (dayOffset 0) and builds a worst-case line', () => {
    const result = distillForecast(response, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.day).toBe('2026-07-16');
    expect(result.value.hours.map((h) => h.time)).toEqual(['2026-07-16T07:00', '2026-07-16T08:00']);
    // worst case across the two hours: feels-like 14–15, 60% rain (1.5mm), gusts 30
    expect(result.value.line).toBe('14–15°C feels-like, 60% rain (1.5mm), gusts 30 km/h');
  });

  it('selects the correct day for dayOffset 1 and reports dry/calm conditions', () => {
    const result = distillForecast(response, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.day).toBe('2026-07-17');
    expect(result.value.line).toBe('19–20°C feels-like, dry, calm');
  });

  it('errors (not a fabricated calm morning) when hourly data is missing', () => {
    const result = distillForecast({}, 0);
    expect(result).toEqual({ ok: false, error: 'no hourly data in response' });
  });

  it('errors when the requested day has no forecast', () => {
    const result = distillForecast(response, 3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('dayOffset 3');
  });

  it('errors when the target day lacks 07:00/08:00 rows', () => {
    const sparse: OpenMeteoResponse = {
      hourly: {
        time: ['2026-07-16T09:00', '2026-07-16T10:00'],
        temperature_2m: [18, 19],
      },
    };
    const result = distillForecast(sparse, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('no 07:00/08:00 rows');
  });

  it('renders a null hour from Open-Meteo as null, and leaves it out of the worst case', () => {
    const parsed = parseOpenMeteoResponse({
      hourly: {
        time: ['2026-07-16T07:00', '2026-07-16T08:00'],
        temperature_2m: [null, 12.6],
        precipitation: [null, 0.2],
        precipitation_probability: [null, 30],
        weather_code: [null, 61],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = distillForecast(parsed.value, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hours[0]).toEqual({
      time: '2026-07-16T07:00',
      tempC: null,
      feelsLikeC: null,
      precipProb: null,
      precipMm: null,
      windKmh: null,
      gustKmh: null,
      code: null,
    });
    expect(result.value.hours[1]).toMatchObject({ tempC: 13, precipMm: 0.2, code: 61 });
    expect(JSON.stringify(result.value)).toContain('"precipMm":null');
    expect(result.value.line).toBe('13–13°C feels-like, 30% rain (0.2mm), calm');
  });

  it('falls back to tempC when feels-like is absent', () => {
    const noFeels: OpenMeteoResponse = {
      hourly: {
        time: ['2026-07-16T07:00', '2026-07-16T08:00'],
        temperature_2m: [11, 13],
      },
    };
    const result = distillForecast(noFeels, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.line).toContain('11–13°C feels-like');
  });
});

describe('parseOpenMeteoResponse', () => {
  it('drops fields it does not read, keeping the hourly series it does', () => {
    const parsed = parseOpenMeteoResponse({
      latitude: 55.6,
      hourly_units: { time: 'iso8601' },
      hourly: { time: ['2026-07-16T07:00'], temperature_2m: [15.2], uv_index: [3] },
    });
    expect(parsed).toEqual({
      ok: true,
      value: { hourly: { time: ['2026-07-16T07:00'], temperature_2m: [15.2] } },
    });
  });

  it.each([
    ['missing', {}],
    ['null', { hourly: null }],
  ])('reads a %s hourly block as no data, like an empty response', (_, raw) => {
    const parsed = parseOpenMeteoResponse(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(distillForecast(parsed.value, 0)).toEqual(distillForecast({}, 0));
  });

  it('reads a null series or null time list as absent', () => {
    const parsed = parseOpenMeteoResponse({ hourly: { time: null, precipitation: null } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(distillForecast(parsed.value, 0)).toEqual({
      ok: false,
      error: 'no hourly data in response',
    });
  });

  it('rejects a non-numeric series entry, naming its path', () => {
    expect(
      parseOpenMeteoResponse({ hourly: { time: ['2026-07-16T07:00'], precipitation: ['wet'] } }),
    ).toEqual({
      ok: false,
      error:
        'unexpected Open-Meteo response (hourly.precipitation.0: Expected number, received string)',
    });
  });

  it('rejects a response that is not an object, without a path prefix', () => {
    expect(parseOpenMeteoResponse('down for maintenance')).toEqual({
      ok: false,
      error: 'unexpected Open-Meteo response (Expected object, received string)',
    });
  });
});
