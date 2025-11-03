# Railway deployment checklist (app + forwarder)

This file lists the exact copy/paste steps to deploy both services on Railway and test the webhook flow.

1) App service (FastAPI)

- Deploy root: `app`
- Runtime: Railway will use `app/runtime.txt` (set to `python-3.11.4`).
- Start command (Procfile present at `app/Procfile`):
  web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
- Environment variables (Railway > Variables for this service):
  - BITGET_API_KEY = <your-bitget-api-key>
  - BITGET_SECRET = <your-bitget-secret>
  - BITGET_PASSPHRASE = <your-bitget-passphrase>
  - TRADINGVIEW_SECRET = <long-random-secret>
  - PAPTRADING = 1

After deploy you will get an app URL, e.g.:

  https://your-app.up.railway.app

The webhook endpoint will be:

  https://your-app.up.railway.app/webhook

2) Forwarder service (Node)

- Deploy root: `forwarder`
- Railway will run `npm install` and start with `npm start` (package.json has `start: node index.js`).
- Environment variables (Railway > Variables for this service):
  - TARGET_URL = https://your-app.up.railway.app/webhook
  - TRADINGVIEW_SECRET = <same-secret-as-app>

After deploy you will get a forwarder URL, e.g.:

  https://your-forwarder.up.railway.app/

Set TradingView webhook URL to the forwarder URL and use the JSON message (example in `forwarder/README.md`) — the forwarder will inject the header and forward to the app.

3) Quick verification commands (PowerShell)

Replace `your-forwarder.up.railway.app` and `your-app.up.railway.app` with the actual URLs.

```powershell
# Simulate TradingView -> Forwarder -> App
$body = '{"signal":"BUY","symbol":"BTCUSDT","price":42000,"size_usd":50}'
Invoke-RestMethod -Uri 'https://your-forwarder.up.railway.app/' -Method Post -Body $body -ContentType 'application/json'

# Simulate forwarder -> App (manual header)
Invoke-RestMethod -Uri 'https://your-app.up.railway.app/webhook' -Method Post -Body $body -ContentType 'application/json' -Headers @{'Tradingview-Secret'='your-secret-value'}
```

4) Notes & troubleshooting

- Make sure the Railway service for the app uses `app` as the deploy root; otherwise Railpack will not find `app/Procfile`.
- Use a long random `TRADINGVIEW_SECRET` and do not commit it anywhere.
- If an alert fails, inspect logs in Railway for the forwarder (incoming body and forward response) and the app (webhook handling / signature rejection).
- If you prefer not to use the forwarder, set TradingView webhook to `https://your-app.up.railway.app/webhook` and use the JSON payload containing the `secret` field (less secure).
