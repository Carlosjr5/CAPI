# TradingView Webhook Forwarder

This simple forwarder accepts POST requests from TradingView and forwards them to your app's `/webhook` endpoint while injecting a `Tradingview-Secret` header.

Environment variables
- `TARGET_URL` - full URL to forward to (default: `http://localhost:8000/webhook`).
- `TRADINGVIEW_SECRET` - secret string that will be added to the forwarded request as header `Tradingview-Secret`.
- `PORT` - port for the forwarder (defaults to `3000`).

Usage
1. Set the environment variables (Railway: Environment tab).
2. Deploy the `forwarder` directory as a separate service (Railway supports subdirectory deploys).
3. In TradingView, set the webhook URL to the forwarder URL (e.g. `https://your-forwarder.up.railway.app/`) and send JSON in the Message field.

Security
- Use a long random `TRADINGVIEW_SECRET` and configure the main app to require that header. Do not commit secrets to the repository.

Example forwarder deployment envs
- `TARGET_URL`: `https://your-app.up.railway.app/webhook`
- `TRADINGVIEW_SECRET`: `a-very-long-random-secret`

The `package.json` contains a `start` script (`node index.js`) so Railway can start the service.
# TradingView Webhook Forwarder

This Node.js forwarder receives TradingView alerts and forwards them to your FastAPI webhook endpoint with proper authentication.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set environment variables:
   ```bash
   export TARGET_URL="http://localhost:8000/webhook"
   export TRADINGVIEW_SECRET="SUPERSECRET23"
   # For TradingView: PORT=80 (default)
   # For testing: PORT=3000
   export PORT=80
   ```

3. Start the forwarder:
   ```bash
   # For production (port 80 for TradingView):
   npm run start:port80
   # For testing (port 3000):
   npm start
   ```

**Important:** TradingView only allows webhooks on port 80 (HTTP). Use port 80 for production alerts.

## TradingView Alert Configuration

### Alert Setup in TradingView
1. Go to TradingView chart
2. Create or edit an alert
3. Set the following:

**Alert Name:** `TV Signal`

**Webhook URL:** `http://localhost:3000/` (or your deployed URL)

**Message Format (JSON):**
```json
{
  "action": "{{strategy.order.action}}",
  "ticker": "{{ticker}}",
  "size": "{{strategy.order.contracts}}"
}
```

### Alternative Message Format
You can also use:
```json
{
  "signal": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": "{{strategy.order.price}}",
  "size": "{{strategy.order.contracts}}"
}
```

## Testing

Test the forwarder directly:
```bash
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"action":"SELL","ticker":"ETHUSDT","size":0.1}'
```

The forwarder will:
1. Add the `Tradingview-Secret` header
2. Forward to your FastAPI endpoint at `/webhook`
3. Log the request/response
