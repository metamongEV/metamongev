# metamongEV — Beezie EV Pulse

Live mirror of [beezie-giyu.vercel.app](https://beezie-giyu.vercel.app/) with extras: per-pack progress bar, top-10 grail drill-down, alarm-on-+EV, color-coded EV columns.

## Architecture

- `index.html`, `styles.css`, `script.js` — static, served from Vercel CDN
- `api/claws.mjs` — Edge function that proxies `https://beezie-giyu.vercel.app/api/claws` (CORS bypass)
- `vercel.json` — `Cache-Control: no-store` + permissive CORS on `/api/*`
- `server.py` — local-only Python proxy (mirrors the same endpoint)

## Local development

```bash
python3 server.py
```

Then open <http://127.0.0.1:8000>. Stop with `Ctrl+C` (or `kill $(lsof -ti:8000)`).

## Deploy to Vercel

1. Push this repo to GitHub.
2. Vercel dashboard → **Add New… → Project** → import the repo.
3. Framework preset: **Other**. Leave build command, output directory, and root directory blank.
4. **Deploy**.

Vercel auto-discovers `api/claws.mjs` as an Edge function at `/api/claws`. Static files are served from the CDN. Each `git push` to `main` triggers a fresh deploy.

## Verify production

```bash
curl -s -o /dev/null -w "page=%{http_code}\n"  https://YOUR-PROJECT.vercel.app/
curl -s -o /dev/null -w "claws=%{http_code}\n" https://YOUR-PROJECT.vercel.app/api/claws
```

Both should return `200`.

## Updating

```bash
# edit files...
git add -A
git commit -m "describe the change"
git push
```

Vercel rebuilds automatically. Each push also creates a unique preview URL.

## Customizing

- **Logo** → save your image to `assets/logo.png` (twitter-circle crop, 96 × 96 or larger).
- **BEP thresholds** → edit `BEP_TABLE` in `script.js`.
- **Refresh cadence** → edit `REFRESH_INTERVAL_MS` in `script.js`.
- **Header links** → `<nav class="topbar__links">` block in `index.html`.
