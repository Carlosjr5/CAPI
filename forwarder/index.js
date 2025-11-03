// Simple webhook forwarder
// Usage: set environment variable TARGET_URL (defaults to http://localhost:8000/webhook)
// set TRADINGVIEW_SECRET in env to the secret value to inject.

const express = require('express');
// use undici's fetch (works in Node 16+); prefer global fetch if available
let fetchImpl;
try {
  fetchImpl = globalThis.fetch;
} catch (e) {
  fetchImpl = undefined;
}
if (!fetchImpl) {
  // undici provides a fetch implementation
  const { fetch: undiciFetch } = require('undici');
  fetchImpl = undiciFetch;
}
const app = express();
app.use(express.json({limit: '1mb'}));

const TARGET = process.env.TARGET_URL || 'http://localhost:8000/webhook';
const INJECT_SECRET = process.env.TRADINGVIEW_SECRET || '';
const PORT = process.env.PORT || 3000;

app.post('/', async (req, res) => {
  try {
    const body = req.body;
    const raw = JSON.stringify(body);

    console.log(`Incoming ${req.method} ${req.originalUrl} - body: ${raw}`);

    const headers = {
      'Content-Type': 'application/json',
    };
    if (INJECT_SECRET) headers['Tradingview-Secret'] = INJECT_SECRET;

    // forward
    if (!TARGET) throw new Error('TARGET_URL not configured');
    const resp = await fetchImpl(TARGET, { method: 'POST', headers, body: raw });
    const text = await resp.text();
    console.log(`Forwarded to ${TARGET} -> status ${resp.status} body: ${text}`);

    res.status(resp.status).send(text);
  } catch (err) {
    console.error('forward error', err);
    res.status(500).send({error: err.message});
  }
});

app.get('/', (req, res) => {
  res.send({status: 'forwarder running', target: TARGET});
});

app.listen(PORT, () => {
  console.log(`forwarder listening on port ${PORT} -> forwarding to ${TARGET}`);
  if (!process.env.TARGET_URL) console.log(`TARGET_URL not set — defaulting to ${TARGET}`);
});
