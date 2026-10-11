# Quorum — weather that cross-checks every forecast

Static PWA (HTML + CSS + JS modules). No build step, no backend, no API keys. Works offline.

## Deploy on GitHub Pages
1. Create a repo and upload **everything in this folder** (keep the folder structure, including `.nojekyll`).
2. Repo → Settings → Pages → "Deploy from a branch" → `main` / root → Save.
3. Open `https://<you>.github.io/<repo>/` on your iPhone/iPad in Safari → Share → **Add to Home Screen**.

All paths are relative, so it works from a sub-path like `/repo/`. HTTPS (which Pages provides) is required for the service worker and location.

## What's inside
- `index.html`, `css/styles.css`, `js/*.js` — the app
- `sw.js` — offline app shell (cache-first, revalidated in the background) + basemap tile cache
- `manifest.json`, `icons/`, `splash/` — install-to-Home-Screen assets
- `make_icons.py` — regenerates icons and iOS launch screens (needs Pillow)

## How the "best temperature" works
Sources: 7 Open-Meteo models (ECMWF, ICON, GFS, UK Met Office, Météo-France, GEM, JMA), MET Norway, NWS (US only), plus OpenWeather / WeatherAPI if you paste your own free keys in Settings.
Each source is interpolated to the same timestamps, far-off outliers are dropped (when 4+ sources exist), and the result is a smooth weighted median. Weights = base trust × recent accuracy at that location.
Accuracy learning: every refresh logs what each source predicted for the next 3–36 h; later it scores those predictions against Open-Meteo's observation-based hourly analysis and re-weights. It needs about a day of use before it affects the result.

## Storage
- Cookies: units/theme/last city, scoped to the app path (backup if Safari clears localStorage).
- localStorage: preferences and city list.
- IndexedDB: cached forecasts (for offline), prediction log, accuracy stats.
Add the app to the Home Screen so iOS doesn't purge storage after ~7 days of non-use.

## Updating after you change files
Bump `VERSION` in `sw.js` (and add any new files to `ASSETS`). Users get a "new version" prompt.

## Known limits
- No push notifications or background refresh (iOS web apps can't do either without a server). Alerts show when the app is open.
- NWS alerts are US-only. MET Norway may block some browser requests; it's treated as best-effort.
- Radar needs a connection (RainViewer free tiers cap zoom). Basemap tiles you've viewed are cached.
- Accuracy is measured against an analysis dataset, not physical stations.
