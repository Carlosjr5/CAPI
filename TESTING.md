End-to-end test: webhook -> dashboard -> Bitget

This document explains how to run the included test script `scripts/test_webhook_and_bitget.py`.

Prerequisites
- Python 3.8+ installed
- Install Python requirements (recommended):
   ```powershell
   pip install -r requirements.txt
   ```
- Backend server running (default http://127.0.0.1:8000) or set `API_BASE` to your deployed URL
- `TRADINGVIEW_SECRET` environment variable must be set to the same value configured in the backend
- If you want the test to actually place and query live/demo Bitget orders, ensure the backend has:
  - `BITGET_DRY_RUN=0`
  - `BITGET_BASE` set to the correct Bitget demo or prod endpoint
  - `BITGET_API_KEY`, `BITGET_SECRET`, `BITGET_PASSPHRASE` set to matching credentials for that base

How to run (PowerShell)

# Run locally against the dev server
2. Run the test (example; defaults to the Railway URL unless you override API_BASE):
   ```powershell
   # By default the script targets https://capi-production-7bf3.up.railway.app
   $env:TRADINGVIEW_SECRET = 'SUPERSECRET23'
   $env:SYMBOL = 'BTCUSDT'
   $env:SIZE_USD = '10'
   python .\scripts\test_webhook_and_bitget.py

   # Or explicitly target a local backend:
   $env:API_BASE = 'http://127.0.0.1:8000'
   python .\scripts\test_webhook_and_bitget.py
   ```

Notes
- The script posts a TradingView-like JSON to `/webhook` (header-based secret). The backend creates a trade record and attempts to place an order.
- The script then polls `/trades` and attempts to extract an `orderId` from the API response or the stored trade record. If found, it calls `/debug/order-status` to query Bitget and prints the result.
- Exit codes:
  0 - success (order found and query returned 200)
  2 - missing TRADINGVIEW_SECRET env
  3 - webhook returned HTTP >= 400
  4 - order query failed (non-200)
  5 - no orderId found in responses (likely dry-run)

If something doesn't work, copy the printed responses (webhook response, /trades row and /debug/order-status output) and paste them into an issue here so I can help interpret them.