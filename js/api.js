// Data sources. Everything is fetched straight from the browser (all of these allow CORS).
// Internal units: °C, km/h, mm, hPa, metres, epoch milliseconds.
import { idbGet, idbSet } from './store.js';

export const MODELS = [
  { id: 'ecmwf_ifs025', name: 'ECMWF', full: 'ECMWF IFS (Europe)', w: 1.25, color: '#5ac8fa' },
  { id: 'icon_seamless', name: 'ICON', full: 'DWD ICON (Germany)', w: 1.05, color: '#30d158' },
  { id: 'gfs_seamless', name: 'GFS', full: 'NOAA GFS (USA)', w: 0.95, color: '#ff9f0a' },
  { id: 'ukmo_seamless', name: 'UK Met Office', full: 'UK Met Office', w: 1.05, color: '#ffd60a' },
  { id: 'meteofrance_seamless', name: 'Météo-France', full: 'Météo-France ARPEGE/AROME', w: 0.95, color: '#bf5af2' },
  { id: 'gem_seamless', name: 'GEM', full: 'Environment Canada GEM', w: 0.85, color: '#ff453a' },
  { id: 'jma_seamless', name: 'JMA', full: 'Japan Meteorological Agency', w: 0.75, color: '#ff6482' },
];
export const EXTRA = {
  metno: { id: 'metno', name: 'MET Norway', full: 'MET Norway Locationforecast', w: 1.1, color: '#64d2ff' },
  nws: { id: 'nws', name: 'NWS', full: 'US National Weather Service', w: 1.1, color: '#c8a27a' },
  owm: { id: 'owm', name: 'OpenWeather', full: 'OpenWeather (your key)', w: 0.8, color: '#eb6e4b' },
  wapi: { id: 'wapi', name: 'WeatherAPI', full: 'WeatherAPI.com (your key)', w: 0.8, color: '#a0a7b4' },
};
export const SOURCE_META = Object.fromEntries([...MODELS.map(m => [m.id, m]), ...Object.entries(EXTRA)]);
export const BLEND = { id: 'blend', name: 'Open-Meteo blend', full: 'Open-Meteo best-match blend', w: 0.8, color: '#e5e5ea' };
SOURCE_META.blend = BLEND;

async function jget(url, { timeout = 12000 } = {}) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) { const e = new Error(String(r.status)); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(to); }
}
const ms = a => (a || []).map(x => (x == null ? null : x * 1000));
const round4 = n => (+n).toFixed(4);

// ---------- Open-Meteo: full forecast (best match) ----------
export async function fetchMain(lat, lon) {
  const q = new URLSearchParams({
    latitude: round4(lat), longitude: round4(lon), timezone: 'auto', timeformat: 'unixtime',
    past_days: 2, forecast_days: 10,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,relative_humidity_2m,dew_point_2m,uv_index,visibility,is_day,cloud_cover,pressure_msl',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,daylight_duration',
    minutely_15: 'precipitation', forecast_minutely_15: 12, past_minutely_15: 0,
  });
  const j = await jget('https://api.open-meteo.com/v1/forecast?' + q);
  const c = j.current || {}, h = j.hourly || {}, d = j.daily || {}, m = j.minutely_15 || {};
  return {
    tz: j.timezone || 'UTC', offset: j.utc_offset_seconds || 0, lat: j.latitude, lon: j.longitude, elevation: j.elevation,
    current: {
      t: (c.time || 0) * 1000, temp: c.temperature_2m, feels: c.apparent_temperature, hum: c.relative_humidity_2m,
      isDay: c.is_day === 1, precip: c.precipitation, code: c.weather_code, cloud: c.cloud_cover, pressure: c.pressure_msl,
      wind: c.wind_speed_10m, windDir: c.wind_direction_10m, gust: c.wind_gusts_10m,
    },
    hourly: {
      t: ms(h.time), temp: h.temperature_2m, feels: h.apparent_temperature, pop: h.precipitation_probability, precip: h.precipitation,
      code: h.weather_code, wind: h.wind_speed_10m, windDir: h.wind_direction_10m, gust: h.wind_gusts_10m, hum: h.relative_humidity_2m,
      dew: h.dew_point_2m, uv: h.uv_index, vis: h.visibility, isDay: h.is_day, cloud: h.cloud_cover, pressure: h.pressure_msl,
    },
    daily: {
      t: ms(d.time), code: d.weather_code, max: d.temperature_2m_max, min: d.temperature_2m_min, sunrise: ms(d.sunrise), sunset: ms(d.sunset),
      uvMax: d.uv_index_max, precipSum: d.precipitation_sum, popMax: d.precipitation_probability_max, windMax: d.wind_speed_10m_max,
      gustMax: d.wind_gusts_10m_max, daylight: d.daylight_duration,
    },
    minutely: { t: ms(m.time), precip: m.precipitation || [] },
  };
}

// ---------- Open-Meteo: several weather models in one call ----------
export async function fetchModels(lat, lon, ids) {
  const run = async list => {
    const q = new URLSearchParams({
      latitude: round4(lat), longitude: round4(lon), timezone: 'auto', timeformat: 'unixtime', forecast_days: 7,
      models: list.join(','), hourly: 'temperature_2m,precipitation,wind_speed_10m',
    });
    return { j: await jget('https://api.open-meteo.com/v1/forecast?' + q), list };
  };
  let res;
  try { res = await run(ids); }
  catch (e) {
    // A single unsupported model name makes the API reject the whole request: retry with the safest set.
    if (e.status === 400 || e.status === 422) res = await run(['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless']);
    else throw e;
  }
  const { j, list } = res;
  const h = j.hourly || {}, t = ms(h.time);
  return list.map(id => {
    const temp = h['temperature_2m_' + id] ?? (list.length === 1 ? h.temperature_2m : null);
    if (!temp || temp.filter(v => v != null).length < 24) return null;
    return { id, t, temp, precip: h['precipitation_' + id] || null, wind: h['wind_speed_10m_' + id] || null };
  }).filter(Boolean);
}

// ---------- MET Norway ----------
export async function fetchMetno(lat, lon) {
  const j = await jget(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}`);
  const ts = j.properties.timeseries;
  return { id: 'metno', t: ts.map(x => Date.parse(x.time)), temp: ts.map(x => x.data.instant.details.air_temperature) };
}

// ---------- US National Weather Service ----------
export const inUS = (lat, lon) => lat >= 17 && lat <= 72 && lon >= -180 && lon <= -64;
export async function fetchNws(lat, lon, id) {
  const key = 'nwsgrid:' + id;
  let url = await idbGet(key);
  if (!url) {
    const p = await jget(`https://api.weather.gov/points/${(+lat).toFixed(4)},${(+lon).toFixed(4)}`);
    url = p.properties.forecastHourly;
    idbSet(key, url);
  }
  const j = await jget(url);
  const per = j.properties.periods;
  return {
    id: 'nws', t: per.map(p => Date.parse(p.startTime)),
    temp: per.map(p => (p.temperatureUnit === 'F' ? (p.temperature - 32) * 5 / 9 : p.temperature)),
  };
}
export async function fetchAlerts(lat, lon) {
  const j = await jget(`https://api.weather.gov/alerts/active?point=${(+lat).toFixed(4)},${(+lon).toFixed(4)}`);
  return (j.features || []).slice(0, 6).map(f => {
    const p = f.properties;
    return { event: p.event, severity: p.severity, headline: p.headline, description: p.description, instruction: p.instruction, ends: Date.parse(p.ends || p.expires) || null, sender: p.senderName };
  });
}

// ---------- Optional: user-supplied keys ----------
export async function fetchOwm(lat, lon, key) {
  const j = await jget(`https://api.openweathermap.org/data/2.5/forecast?lat=${round4(lat)}&lon=${round4(lon)}&units=metric&appid=${encodeURIComponent(key)}`);
  return { id: 'owm', t: j.list.map(x => x.dt * 1000), temp: j.list.map(x => x.main.temp) };
}
export async function fetchWapi(lat, lon, key) {
  const j = await jget(`https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(key)}&q=${round4(lat)},${round4(lon)}&days=3&aqi=no&alerts=no`);
  const hrs = j.forecast.forecastday.flatMap(d => d.hour);
  return { id: 'wapi', t: hrs.map(x => x.time_epoch * 1000), temp: hrs.map(x => x.temp_c) };
}

// ---------- Air quality & pollen ----------
export async function fetchAir(lat, lon) {
  const q = new URLSearchParams({
    latitude: round4(lat), longitude: round4(lon), timeformat: 'unixtime',
    current: 'us_aqi,european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide,alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen',
  });
  const j = await jget('https://air-quality-api.open-meteo.com/v1/air-quality?' + q);
  return j.current || null;
}

// ---------- Geocoding ----------
export async function searchPlaces(name) {
  const j = await jget(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`);
  return (j.results || []).map(r => ({ name: r.name, admin: r.admin1 || '', country: r.country || '', lat: r.latitude, lon: r.longitude, tz: r.timezone }));
}
export async function reverseGeocode(lat, lon) {
  try {
    const j = await jget(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, { timeout: 6000 });
    return { name: j.city || j.locality || j.principalSubdivision || 'My location', admin: j.principalSubdivision || '', country: j.countryName || '' };
  } catch { return { name: 'My location', admin: '', country: '' }; }
}

// ---------- Bundle ----------
// Fetches everything for one city. Only the main forecast is required; every other source is best-effort.
export async function fetchBundle(city, prefs) {
  const { lat, lon, id } = city;
  const on = sid => prefs.sources[sid] !== false;
  const modelIds = MODELS.map(m => m.id).filter(on);
  const jobs = {
    main: fetchMain(lat, lon),
    models: modelIds.length ? fetchModels(lat, lon, modelIds) : Promise.resolve([]),
    metno: on('metno') ? fetchMetno(lat, lon) : null,
    nws: on('nws') && inUS(lat, lon) ? fetchNws(lat, lon, id) : null,
    owm: on('owm') && prefs.keys.owm ? fetchOwm(lat, lon, prefs.keys.owm) : null,
    wapi: on('wapi') && prefs.keys.wapi ? fetchWapi(lat, lon, prefs.keys.wapi) : null,
    air: fetchAir(lat, lon),
    alerts: inUS(lat, lon) ? fetchAlerts(lat, lon) : null,
  };
  const names = Object.keys(jobs);
  const settled = await Promise.allSettled(names.map(n => jobs[n] || Promise.resolve(null)));
  const out = Object.fromEntries(names.map((n, i) => [n, settled[i]]));
  if (out.main.status === 'rejected') throw out.main.reason;

  const errors = {};
  const val = n => { const s = out[n]; if (s.status === 'fulfilled') return s.value; errors[n] = String(s.reason?.message || s.reason); return null; };
  const sources = [...(val('models') || []), ...['metno', 'nws', 'owm', 'wapi'].map(val).filter(Boolean)];
  return {
    v: 1, fetchedAt: Date.now(), city: { ...city }, main: out.main.value, sources,
    air: val('air'), alerts: val('alerts') || [], errors,
  };
}
