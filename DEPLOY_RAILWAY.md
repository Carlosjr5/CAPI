Railway deploy checklist for CAPI
=================================

This project serves a React frontend (Vite) and a FastAPI backend. The frontend source is in `frontend/` and the backend serves the production build from `static/`.

Goal: ensure Railway builds the frontend during deploy, copies the build into `static/`, and starts the FastAPI server so the UI and the `/trades` table work in production.

Recommended Railway settings
---------------------------

1) Repository and service
- Link your GitHub repo (this repository) to a Railway project and create a service.

2) Build Command (set in Project > Settings > Build or in the Railway UI where it asks for a build command)
- Preferred (uses provided script):
  bash build_frontend_and_copy.sh
- Equivalent single-line (if you don't want to use the script):
  npm ci --prefix frontend; npm run build --prefix frontend; cp -r frontend/dist/* static/

Notes: Railway runs on Linux so the `bash` script will work. The commands install frontend deps, build the Vite app, and copy `frontend/dist/*` into `static/` so FastAPI serves the built app.

3) Start Command
- Railway will use the `Procfile` by default. If it asks explicitly, use:
  uvicorn app.main:app --host 0.0.0.0 --port $PORT

4) Environment variables (set in Railway > Variables)
- Required for safe testing:
  BITGET_DRY_RUN=1
  TRADINGVIEW_SECRET=<a-secret-string-for-tradingview-and-place-test>

- Optional (only set when you want to call Bitget live):
  BITGET_API_KEY=
  BITGET_SECRET=
  BITGET_PASSPHRASE=
  BITGET_BASE=https://api.bitget.com

- Optional: override allowed CORS origins
  FRONTEND_ORIGINS=https://your-deploy-host.example.com

5) Database / persistence note
- The app uses SQLite (`trades.db`) by default. Railway filesystem is ephemeral across some deploy events; for production persistence, attach a managed database (Postgres) and update the backend to use that instead of SQLite. For quick demo/testing on Railway `trades.db` will persist for the lifetime of the instance but can be lost on rebuilds.

6) Health & verification
- After deploying:
  - Open the public URL. Confirm `/` returns HTML (200).
  - Confirm `/assets/index-*.js` and `/assets/index-*.css` return 200.
  - Confirm `/trades` returns an array of trades (200). If empty, trigger a demo trade.
  - Check Console / Network to see WebSocket connect to `/ws`.

7) Quick manual test on deployed URL
- Use the Manual Demo Order card in the UI (enter the `TRADINGVIEW_SECRET` and click "Place demo order").
- Or call the debug endpoint:
  POST https://<your-app>/debug/place-test
  Body: { "secret": "<TRADINGVIEW_SECRET>" }
  This will create a simulated trade when `BITGET_DRY_RUN=1` and broadcast the event to connected clients.

Troubleshooting tips
--------------------
- If the page is white on Railway but index is 200: check Network tab for 404s on `/assets/...`. If you see 404, verify the Build Command copied files into `static/assets`.
- If WS doesn't connect: ensure the browser is connecting to the same origin; the app builds the WS URL from location.host and `/ws` so it should work.
- If `/debug/place-test` returns 403: the request must include the `TRADINGVIEW_SECRET` either in the `Tradingview-Secret` header or in JSON `secret` field.

CI note
-------
There is a GitHub Actions workflow `.github/workflows/build-and-validate.yml` that builds the frontend and performs a smoke check. This validates that the frontend build and backend startup succeed on pushes to `main`, but Railway still needs to run the Build Command during deploy (or you can commit `static/` if you prefer to ship built assets directly).

If you want me to configure Railway for you, tell me whether you want me to:
- Prepare the exact Build/Start/Env settings text for you to paste into the Railway UI (I can produce it now), or
- Force-add `static/` and push the built assets so Railway doesn't need a build step (not recommended long-term).

That's it — follow the steps above and the UI table should show trades and live updates after deploy.
