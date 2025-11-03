# app/main.py
import os
import time
import hmac
import hashlib
import base64
import json
import uuid
import asyncio
from typing import List
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import socket
import re
from urllib.parse import urlparse
import httpx
import sqlalchemy
from databases import Database

load_dotenv()

BITGET_API_KEY = os.getenv("BITGET_API_KEY")
BITGET_SECRET = os.getenv("BITGET_SECRET")
BITGET_PASSPHRASE = os.getenv("BITGET_PASSPHRASE")
PAPTRADING = os.getenv("PAPTRADING", "1")
TRADINGVIEW_SECRET = os.getenv("TRADINGVIEW_SECRET")
BITGET_BASE = os.getenv("BITGET_BASE")
BITGET_PRODUCT_TYPE = os.getenv("BITGET_PRODUCT_TYPE")
BITGET_MARGIN_COIN = os.getenv("BITGET_MARGIN_COIN")
BITGET_POSITION_MODE = os.getenv("BITGET_POSITION_MODE")  # optional: e.g. 'single' for unilateral / one-way
BITGET_POSITION_TYPE = os.getenv("BITGET_POSITION_TYPE")  # optional: try values like 'unilateral' or 'one-way' if Bitget expects 'positionType'
BITGET_POSITION_SIDE = os.getenv("BITGET_POSITION_SIDE")  # optional: explicit position side e.g. 'long' or 'short'
BITGET_DRY_RUN = os.getenv("BITGET_DRY_RUN")

# DB (sqlite)
DATABASE_URL = "sqlite:///./trades.db"
database = Database(DATABASE_URL)
metadata = sqlalchemy.MetaData()
trades = sqlalchemy.Table(
    "trades",
    metadata,
    sqlalchemy.Column("id", sqlalchemy.String, primary_key=True),
    sqlalchemy.Column("signal", sqlalchemy.String),
    sqlalchemy.Column("symbol", sqlalchemy.String),
    sqlalchemy.Column("price", sqlalchemy.Float),
    sqlalchemy.Column("status", sqlalchemy.String),  # placed, filled, rejected
    sqlalchemy.Column("response", sqlalchemy.Text),
    sqlalchemy.Column("created_at", sqlalchemy.Float),
)
engine = sqlalchemy.create_engine(
    DATABASE_URL, connect_args={"check_same_thread": False}
)
metadata.create_all(engine)

app = FastAPI()
# Allow CORS from local dev servers (React/Vite) and deployed frontend.
# You can override allowed origins via the FRONTEND_ORIGINS env var (comma-separated).
default_frontend_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    # Railway frontend / deployed origin - adjust if you host frontend elsewhere
    "https://capi-production-7bf3.up.railway.app",
]
env_origins = os.getenv("FRONTEND_ORIGINS")
if env_origins:
    try:
        origins = [o.strip() for o in env_origins.split(",") if o.strip()]
    except Exception:
        origins = default_frontend_origins
else:
    origins = default_frontend_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
connected_websockets: List[WebSocket] = []

# Serve the frontend from the `static` folder. Index is available at '/'.
# Ensure the static directory exists at runtime so the app doesn't crash if the build
# step wasn't run (CI/deploy should generate `static/` before start).
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'static'))
if not os.path.isdir(STATIC_DIR):
    try:
        print(f"[startup] static directory '{STATIC_DIR}' not found; creating empty directory to avoid startup crash.")
        os.makedirs(STATIC_DIR, exist_ok=True)
    except Exception as e:
        print(f"[startup] failed to create static dir: {e}")

app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')

# Some production builds reference assets at '/assets/...' (absolute path).
# Mount the `static/assets` folder at '/assets' so those requests resolve correctly
# and the built `index.html` can find its JS/CSS when served from the root.
assets_dir = os.path.join(STATIC_DIR, 'assets')
try:
    if os.path.isdir(assets_dir):
        app.mount('/assets', StaticFiles(directory=assets_dir), name='assets')
except Exception:
    # non-fatal: if we can't mount assets for some reason, continue and the root
    # handler will still return an informative message when index.html is missing.
    pass


@app.get('/')
async def root_index():
    # Return the dashboard index.html from the static folder if present,
    # otherwise return a small informative JSON so the process doesn't crash.
    index_path = os.path.join(STATIC_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"ok": False, "message": "Static site not built. Run the frontend build to generate static/index.html before starting the server."}

# helper: send message to all connected frontends
async def broadcast(event: dict):
    living = []
    for ws in connected_websockets:
        try:
            await ws.send_text(json.dumps(event))
            living.append(ws)
        except Exception:
            pass
    # refresh list
    connected_websockets[:] = living

# Bitget signature (per docs): timestamp + method + requestPath + [ '?' + queryString ] + body
def build_signature(timestamp: str, method: str, request_path: str, body: str, secret: str):
    payload = f"{timestamp}{method.upper()}{request_path}{body}"
    mac = hmac.new(secret.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256)
    d = mac.digest()
    return base64.b64encode(d).decode()

async def place_demo_order(symbol: str, side: str, price: float = None, size: float = None):
    """
    Place an order on Bitget demo futures (v2 mix order)
    We'll place a market order by default. Modify `orderType` to 'limit' if you want limit.
    """
    # Use Bitget mix v1 place order endpoint (docs show simulated/demo trading on v1 paths)
    request_path = "/api/mix/v1/order/placeOrder"
    url = BITGET_BASE + request_path

    # Attempt to discover the exact Bitget contract symbol for the configured
    # productType to avoid mismatches (e.g. TradingView 'BTCUSDT.P' or differing
    # suffixes). If discovery fails we'll fall back to the simple mapping.
    mapped_symbol = None
    try:
        # Query Bitget's public contracts for the productType
        contracts_url = f"{BITGET_BASE}/api/mix/v1/market/contracts?productType={BITGET_PRODUCT_TYPE}"
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(contracts_url)
            if r.status_code == 200:
                try:
                    j = r.json()
                    data = j.get("data") if isinstance(j, dict) else None
                    if isinstance(data, list):
                        raw = symbol.replace("BINANCE:", "").replace("/", "")
                        raw = re.sub(r"[^A-Za-z0-9_]", "", raw)
                        raw_up = raw.upper()
                        # base coin (e.g. BTC from BTCUSDT)
                        base = raw_up.replace("USDT", "").replace("_", "")
                        for item in data:
                            if not isinstance(item, dict):
                                continue
                            s = (item.get("symbol") or "").upper()
                            display = (item.get("symbolDisplayName") or "").upper()
                            # direct match with symbol or display
                            if raw_up == s or raw_up == display:
                                mapped_symbol = item.get("symbol")
                                break
                            # substring match: raw contained in symbol/display
                            if raw_up in s or raw_up in display:
                                mapped_symbol = item.get("symbol")
                                break
                            # match by base coin presence (handles demo prefixes like 'SBTC')
                            if base and (base in s or base in display):
                                # ensure it's a USDT pair (display contains USDT)
                                if "USDT" in s or "USDT" in display:
                                    mapped_symbol = item.get("symbol")
                                    break
                except Exception:
                    mapped_symbol = None
    except Exception:
        mapped_symbol = None

    # Build the order payload using the shared helper. Prefer discovered symbol.
    use_symbol = mapped_symbol if mapped_symbol else symbol
    body_obj = construct_bitget_payload(symbol=use_symbol, side=side, size=size)

    # Optional: include position mode if set via env. Bitget accounts can be one-way (unilateral)
    # or hedged. If your account is in unilateral mode and Bitget expects a matching order field,
    # set BITGET_POSITION_MODE in Railway (try 'single' or the value shown in Bitget docs) — this
    # will add a "positionMode" key to the order payload.
    if BITGET_POSITION_MODE:
        if BITGET_POSITION_MODE.lower() == "single":
            body_obj["positionMode"] = "one_way"
        else:
            body_obj["positionMode"] = BITGET_POSITION_MODE

    # Map the incoming generic side (buy/sell) to the Bitget API's expected
    # values for the account's hold/position mode. For unilateral (one-way)
    # accounts Bitget expects 'buy' / 'sell' with positionSide 'long'/'short'. For other
    # account modes we keep the original simple mapping (buy/sell) to avoid
    # accidental mismatches.
    side_key = side.lower()
    pm = str(BITGET_POSITION_MODE or "").lower()
    pt = str(BITGET_POSITION_TYPE or "").lower()
    single_indicators = ("single", "single_hold", "unilateral", "one-way", "one_way", "oneway")
    if any(x in pm for x in single_indicators) or any(x in pt for x in ("unilateral", "one-way", "one_way", "oneway")):
        # Use simple buy/sell for unilateral mode
        body_obj["side"] = side_key
    else:
        # default to the simple buy/sell mapping (keeps prior behaviour)
        body_obj["side"] = side_key

    # Include a position side (long/short). Prefer explicit env var, otherwise map from order side.
    if BITGET_POSITION_SIDE:
        body_obj["positionSide"] = BITGET_POSITION_SIDE
    else:
        try:
            inferred = "long" if side_key == "buy" else "short"
            body_obj["positionSide"] = inferred
        except Exception:
            pass

    # Some Bitget APIs accept a 'positionType' field; however some accounts expect
    # 'positionSide' + 'positionMode' instead. Only include positionType when it's
    # explicitly set to a non-unilateral value to avoid sending 'unilateral' which
    # some API versions reject as used here.
    if BITGET_POSITION_TYPE and str(BITGET_POSITION_TYPE).lower() not in ("unilateral", "one-way"):
        body_obj["positionType"] = BITGET_POSITION_TYPE

    body = json.dumps(body_obj, separators=(',', ':'))  # compact body
    # If dry-run is enabled, don't call Bitget — return a simulated successful response
    # before we attempt to build signatures or make network calls. This avoids
    # errors when secrets are intentionally not provided during local testing.
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        try:
            print(f"[bitget] DRY-RUN enabled — would POST {url}")
            print(f"[bitget] DRY-RUN payload: {body}")
        except Exception:
            pass
        fake_resp = {
            "code": "00000",
            "msg": "dry-run: simulated order placed",
            "data": {"orderId": f"DRY-{str(uuid.uuid4())}"}
        }
        return 200, json.dumps(fake_resp)

    # We'll compute the signature and headers for each candidate endpoint below so
    # the requestPath (including query string) used to build the sign matches
    # the actual URL we POST to. Some Bitget endpoints expect the query string
    # to be part of the signed requestPath.

    # (live request path continues below)

    # Ensure required credentials are present before making the live request
    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE):
        err = "Missing Bitget credentials (API key/secret/passphrase) required to send live orders"
        print(f"[bitget][error] {err}")
        return 400, json.dumps({"error": err})

    # Try several candidate endpoints in case the API path varies by environment
    candidates = [
        BITGET_BASE + request_path,
        BITGET_BASE + request_path + f"?productType={BITGET_PRODUCT_TYPE}",
        BITGET_BASE + "/api/v2/mix/order/place-order",
        BITGET_BASE + "/api/mix/v1/order/placeOrder",
    ]

    last_exc = None
    async with httpx.AsyncClient(timeout=10.0) as client:
        for u in candidates:
            try:
                # Recompute the request path (path + optional query) for signing
                parsed = urlparse(u)
                request_path_for_sign = parsed.path
                if parsed.query:
                    request_path_for_sign = request_path_for_sign + "?" + parsed.query

                # Build fresh timestamp and signature for this specific requestPath
                ts = str(int(time.time() * 1000))
                sign = build_signature(ts, "POST", request_path_for_sign, body, BITGET_SECRET)

                headers = {
                    "ACCESS-KEY": BITGET_API_KEY,
                    "ACCESS-SIGN": sign,
                    "ACCESS-TIMESTAMP": ts,
                    "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
                    "Content-Type": "application/json",
                    "paptrading": PAPTRADING,
                    "locale": "en-US",
                }

                # Log the attempt (don't include secret-bearing headers in logs)
                try:
                    print(f"[bitget] trying POST {u}")
                    print(f"[bitget] payload: {body}")
                    safe_headers = {k: v for k, v in headers.items() if k not in ("ACCESS-KEY", "ACCESS-SIGN", "ACCESS-PASSPHRASE")}
                    print(f"[bitget] safe-headers: {safe_headers} request_path_for_sign={request_path_for_sign}")
                except Exception:
                    pass

                resp = await client.post(u, headers=headers, content=body)
                try:
                    print(f"[bitget] response status={resp.status_code} text={resp.text}")
                except Exception:
                    pass

                # If endpoint not found, try next candidate
                if resp.status_code == 404:
                    print(f"[bitget] endpoint {u} returned 404, trying next candidate")
                    continue
                return resp.status_code, resp.text
            except Exception as e:
                last_exc = e
                try:
                    print(f"[bitget][exception] request to {u} failed: {e}")
                except Exception:
                    pass
                # try next candidate

    # If we exhausted candidates, return last exception or a 502
    if last_exc:
        return 502, json.dumps({"error": str(last_exc)})
    return 502, json.dumps({"error": "all candidate endpoints returned 404"})


async def fetch_market_price(symbol: str):
    """Try to fetch a current market price for the given symbol from a public ticker (Binance).
    Returns a float price or None if it couldn't be fetched.
    """
    # Normalize symbol (remove slashes, uppercase). Prefer plain symbol like BTCUSDT
    try:
        s = symbol.replace('/', '').upper()
    except Exception:
        s = symbol

    # Prefer Binance public ticker (reliable public endpoint) then try Bitget
    candidates = []
    candidates.append(f"https://api.binance.com/api/v3/ticker/price?symbol={s}")
    try:
        # e.g. https://api.bitget.com/api/mix/v1/market/ticker?symbol=BTCUSDT
        candidates.append(f"{BITGET_BASE}/api/mix/v1/market/ticker?symbol={s}")
        candidates.append(f"{BITGET_BASE}/api/spot/v1/market/ticker?symbol={s}")
    except Exception:
        pass

    for url in candidates:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                if r.status_code != 200:
                    continue
                try:
                    j = r.json()
                except Exception:
                    # Not JSON, skip
                    continue

                # Try to extract common fields from Bitget mix/spot or Binance responses
                # Bitget mix may return {"code":0,"data":{"last":...}} or {"data":[{"last":...}]}
                # Binance returns {"symbol":"BTCUSDT","price":"12345.67"}
                p = None
                # Binance style
                if isinstance(j, dict) and j.get('price'):
                    p = j.get('price')
                # Bitget style: data may be dict or list
                elif isinstance(j, dict) and j.get('data'):
                    data = j.get('data')
                    if isinstance(data, dict):
                        # e.g., {'last': '12345.6'}
                        if data.get('last'):
                            p = data.get('last')
                        elif data.get('price'):
                            p = data.get('price')
                    elif isinstance(data, list) and len(data) > 0:
                        first = data[0]
                        if isinstance(first, dict):
                            if first.get('last'):
                                p = first.get('last')
                            elif first.get('price'):
                                p = first.get('price')
                # Some APIs nest a 'ticker' or 'tick' object
                elif isinstance(j, dict) and j.get('ticker'):
                    t = j.get('ticker')
                    if isinstance(t, dict):
                        p = t.get('last') or t.get('price')

                if p:
                    try:
                        return float(p)
                    except Exception:
                        continue
        except Exception:
            # network/DNS error for this candidate — try next
            continue

    return None


async def get_market_price_with_retries(symbol: str, attempts: int = 3, backoff: float = 0.5):
    """Try to fetch market price with a few retries and exponential backoff.
    Returns a float price or None if all attempts fail.
    """
    last = None
    for i in range(attempts):
        try:
            p = await fetch_market_price(symbol)
            if p and p != 0:
                return p
            last = p
        except Exception:
            last = None
        # small backoff
        await asyncio.sleep(backoff * (2 ** i))
    return last


def construct_bitget_payload(symbol: str, side: str, size: float = None):
    """Construct the Bitget order payload dictionary without signing/sending.
    This mirrors the logic used by place_demo_order so it can be tested by
    the debug endpoint without making external calls.
    """
    # Map simple symbols (e.g., BTCUSDT) to Bitget's expected symbol format for
    # simulated products. If symbol already contains an underscore (e.g.
    # BTCUSDT_SUMCBL) assume caller provided the correct Bitget symbol and
    # don't append the product type.
    # Normalize incoming symbol from TradingView or other sources.
    # Common forms: 'BTCUSDT', 'BINANCE:BTCUSDT', 'BTCUSDT.P' (perpetual),
    # or already Bitget style 'BTCUSDT_SUMCBL'. Remove prefixes and
    # non-alphanumeric/dot/underscore characters, then construct the
    # Bitget symbol as RAW + '_' + productType when needed.
    raw = symbol.replace("BINANCE:", "").replace("/", "")
    # remove dots and any characters except letters, digits and underscore
    raw = re.sub(r"[^A-Za-z0-9_]", "", raw)
    # If symbol already appears to include the product suffix, keep as-is
    if BITGET_PRODUCT_TYPE and ("_" in raw and raw.upper().endswith(str(BITGET_PRODUCT_TYPE).upper())):
        bitget_symbol = raw
    else:
        # append product type if not present
        if BITGET_PRODUCT_TYPE:
            bitget_symbol = f"{raw}_{BITGET_PRODUCT_TYPE}"
        else:
            bitget_symbol = raw

    body_obj = {
        "productType": BITGET_PRODUCT_TYPE,
        "symbol": bitget_symbol,
        "orderType": "market",
        "size": str(size) if size is not None else "1",
        "marginCoin": BITGET_MARGIN_COIN,
        "marginMode": "crossed",
        "clientOid": str(uuid.uuid4())
    }

    # Map side for single/unilateral accounts when necessary
    side_key = side.lower()
    pm = str(BITGET_POSITION_MODE or "").lower()
    pt = str(BITGET_POSITION_TYPE or "").lower()
    single_indicators = ("single", "single_hold", "unilateral", "one-way", "one_way", "oneway")
    if any(x in pm for x in single_indicators) or any(x in pt for x in ("unilateral", "one-way", "one_way", "oneway")):
        # Use simple buy/sell for unilateral mode
        body_obj["side"] = side_key
    else:
        body_obj["side"] = side_key

    # positionSide inference
    if BITGET_POSITION_SIDE:
        body_obj["positionSide"] = BITGET_POSITION_SIDE
    else:
        try:
            inferred = "long" if side_key == "buy" else "short"
            body_obj["positionSide"] = inferred
        except Exception:
            pass

    # Only include positionType if it's set and not the problematic 'unilateral' literal
    if BITGET_POSITION_TYPE and str(BITGET_POSITION_TYPE).lower() not in ("unilateral", "one-way"):
        body_obj["positionType"] = BITGET_POSITION_TYPE

    # Optionally include positionMode if the environment variable is set
    if BITGET_POSITION_MODE:
        body_obj["positionMode"] = BITGET_POSITION_MODE

    return body_obj


@app.post("/debug/payload")
async def debug_payload(req: Request):
    """Return the Bitget payload that would be sent for a TradingView alert.
    Accepts the same JSON body as `/webhook` (signal, symbol, price, size).
    This endpoint never sends anything to Bitget.
    """
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode())
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    signal = payload.get("signal") or payload.get("action") or ""
    symbol = payload.get("symbol") or payload.get("ticker") or ""
    price = payload.get("price")
    # support both explicit size and USD-based size (mirrors /webhook behavior)
    size = payload.get("size")
    size_usd = payload.get("size_usd") or payload.get("sizeUsd") or payload.get("sizeUSD")
    computed_size = None
    if size is not None:
        try:
            computed_size = float(size)
        except Exception:
            computed_size = None
    elif size_usd is not None:
        try:
            usd = float(size_usd)
            if price:
                p = float(price)
            else:
                # try to fetch a live market price when caller did not provide one
                p = await fetch_market_price(payload.get("symbol") or payload.get("ticker") or "")
            if p and p != 0:
                computed_size = usd / p
            else:
                raise HTTPException(status_code=400, detail="Missing price and unable to fetch market price; include price in payload or try again")
        except HTTPException:
            raise
        except Exception:
            computed_size = None

    # Map signal to side
    if signal and str(signal).upper() in ("BUY", "LONG"):
        side = "buy"
    elif signal and str(signal).upper() in ("SELL", "SHORT"):
        side = "sell"
    else:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    # prefer computed_size (from size_usd) when provided so debug mirrors webhook
    constructed = construct_bitget_payload(symbol=symbol, side=side, size=computed_size if computed_size is not None else size)
    return {"payload": constructed}


@app.post("/debug/place-test")
async def debug_place_test(req: Request):
    """Protected endpoint to place a small test/demo order using configured Bitget credentials.
    Requires TRADINGVIEW_SECRET to be provided either in the Tradingview-Secret header or as `secret` in the JSON body.
    For safety, this endpoint will refuse to place orders if BITGET_DRY_RUN is enabled. It returns the Bitget response.
    """
    # verify secret
    header_secret = req.headers.get("tradingview-secret") or req.headers.get("tradingview_secret")
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode()) if body_text else {}
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    # header secret preferred
    if header_secret:
        if header_secret != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Invalid tradingview secret header")
    else:
        if not payload.get("secret") or payload.get("secret") != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Missing or invalid secret")

    

    # extract order params (defaults useful small test)
    signal = payload.get("signal") or payload.get("action") or "BUY"
    symbol = payload.get("symbol") or payload.get("ticker") or "BTCUSDT"
    price = payload.get("price") or None
    size = payload.get("size")
    size_usd = payload.get("size_usd") or payload.get("sizeUsd") or payload.get("sizeUSD")

    # determine side
    if signal and str(signal).upper() in ("BUY", "LONG"):
        side = "buy"
    elif signal and str(signal).upper() in ("SELL", "SHORT"):
        side = "sell"
    else:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    # compute size from size_usd if provided
    computed_size = None
    fetched_price = None
    if size is not None:
        try:
            computed_size = float(size)
        except Exception:
            computed_size = None
    elif size_usd is not None:
        try:
            usd = float(size_usd)
            if price:
                p = float(price)
                fetched_price = p
            else:
                # try to fetch market price when price not provided
                p = await get_market_price_with_retries(symbol)
                fetched_price = p
            if p and p != 0:
                computed_size = usd / p
            else:
                raise HTTPException(status_code=400, detail="Missing price and unable to fetch market price; include price or try again")
        except Exception:
            computed_size = None

    # If dry-run is enabled, simulate placing an order by inserting a DB row
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        # Construct the payload for reporting and the simulated response
        constructed_payload = construct_bitget_payload(symbol=symbol, side=side, size=computed_size)
        fake_resp = {
            "code": "00000",
            "msg": "dry-run: simulated order placed",
            "data": {"orderId": f"DRY-{str(uuid.uuid4())}"}
        }
        # Persist a simulated trade row so the UI can display it
        trade_id = str(uuid.uuid4())
        now = time.time()
        simulated_status = "placed"
        # If caller did not provide an explicit price, use the fetched_price (if any)
        # or attempt to fetch one now. If we cannot fetch a market price, return an error
        # so the UI doesn't show 0.0 and the caller can retry.
        price_for_db = price
        if not price_for_db:
            if fetched_price:
                price_for_db = fetched_price
            else:
                # attempt to fetch a reliable market price now
                price_for_db = await get_market_price_with_retries(symbol)
                if not price_for_db:
                    raise HTTPException(status_code=502, detail="Unable to fetch market price for symbol; try again")
        try:
            print(f"[debug/place-test] computed market price p={locals().get('p', None)} price={price} price_for_db={price_for_db}")
        except Exception:
            pass
        try:
            await database.execute(trades.insert().values(
                id=trade_id,
                signal=signal,
                symbol=symbol,
                price=float(price_for_db) if price_for_db is not None else 0.0,
                status=simulated_status,
                response=json.dumps(fake_resp),
                created_at=now
            ))
            try:
                print(f"[debug/place-test] inserting trade id={trade_id} price={price_for_db}")
            except Exception:
                pass
            # Broadcast the simulated placed event to connected frontends
            await broadcast({"type": "placed", "id": trade_id, "status_code": 200, "response": fake_resp, "price": float(price_for_db) if price_for_db is not None else None})
        except Exception as e:
            # Fall back to returning simulated response even if DB write failed
            print(f"[debug/place-test] failed to write simulated trade to DB: {e}")

        return {
            "ok": True,
            "dry_run": True,
            "note": "BITGET_DRY_RUN is enabled — simulated order created locally",
            "orderId": fake_resp["data"]["orderId"],
            "trade_id": trade_id,
            "price": float(price_for_db) if price_for_db is not None else None,
            "response": fake_resp,
            "payload": constructed_payload,
        }

    # Place the order using the existing helper
    try:
        # Construct the payload for reporting back to the caller (helps debugging)
        constructed_payload = construct_bitget_payload(symbol=symbol, side=side, size=computed_size)

        status_code, resp_text = await place_demo_order(symbol=symbol, side=side, price=price, size=computed_size)

        # Normalize the Bitget response so the frontend can easily show whether
        # a real order was sent and what the order id is.
        parsed = None
        order_id = None
        sent_to_bitget = True
        try:
            parsed = json.loads(resp_text) if isinstance(resp_text, str) and resp_text else resp_text
        except Exception:
            parsed = resp_text

        # Try to extract common order id locations
        try:
            if isinstance(parsed, dict):
                # Bitget sometimes wraps data under 'data' or returns top-level 'orderId'
                if parsed.get('orderId'):
                    order_id = parsed.get('orderId')
                elif parsed.get('data') and isinstance(parsed.get('data'), dict) and parsed.get('data').get('orderId'):
                    order_id = parsed.get('data').get('orderId')
                elif parsed.get('data') and isinstance(parsed.get('data'), dict) and parsed.get('data').get('order_id'):
                    order_id = parsed.get('data').get('order_id')
        except Exception:
            pass

        result = {
            "ok": True,
            "dry_run": False,
            "sent_to_bitget": sent_to_bitget,
            "status_code": status_code,
            "orderId": order_id,
            "response": parsed,
            "payload": constructed_payload,
        }

        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/debug/order-status")
async def debug_order_status(req: Request):
    """Query Bitget for an order's details by orderId.
    Accepts JSON { secret, orderId, symbol? } and returns Bitget's response.
    The endpoint prefers the Tradingview-Secret header if provided.
    """
    header_secret = req.headers.get("tradingview-secret") or req.headers.get("tradingview_secret")
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode()) if body_text else {}
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    # auth
    if header_secret:
        if header_secret != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Invalid tradingview secret header")
    else:
        if not payload.get("secret") or payload.get("secret") != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Missing or invalid secret")

    order_id = payload.get("orderId") or payload.get("order_id") or payload.get("orderid")
    if not order_id:
        raise HTTPException(status_code=400, detail="Missing required field: 'orderId'")

    symbol = payload.get("symbol")

    # Build query payload (POST) — Bitget's exact order detail path may vary by API version.
    request_path = "/api/v2/mix/order/get-order"
    body_obj = {"orderId": order_id}
    if symbol:
        body_obj["symbol"] = symbol

    body = json.dumps(body_obj, separators=(",", ":"))
    timestamp = str(int(time.time() * 1000))
    sign = build_signature(timestamp, "POST", request_path, body, BITGET_SECRET)

    headers = {
        "ACCESS-KEY": BITGET_API_KEY,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
        "Content-Type": "application/json",
        "paptrading": PAPTRADING,
        "locale": "en-US",
    }

    # If dry-run is enabled, don't query live Bitget — return payload so user can run manually later.
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return {"ok": False, "dry_run": True, "note": "BITGET_DRY_RUN is enabled — not querying live Bitget", "payload": body_obj}

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(BITGET_BASE + request_path, headers=headers, content=body)
        try:
            parsed = resp.json()
        except Exception:
            parsed = resp.text
        return {"ok": True, "status_code": resp.status_code, "response": parsed}


@app.get('/debug/config')
async def debug_config():
    """Return non-sensitive runtime configuration useful for debugging remote deployments.
    Does NOT return secrets. Safe to call remotely when protected by network controls.
    """
    return {
        "bitget_base": BITGET_BASE,
        "bitget_dry_run": str(BITGET_DRY_RUN),
        "bitget_product_type": BITGET_PRODUCT_TYPE,
        "bitget_margin_coin": BITGET_MARGIN_COIN,
        "bitget_position_mode": BITGET_POSITION_MODE,
        "bitget_position_type": BITGET_POSITION_TYPE,
        "paptrading": PAPTRADING,
        # don't return raw secrets; only indicate presence
        "has_api_key": bool(BITGET_API_KEY),
        "has_secret": bool(BITGET_SECRET),
        "has_passphrase": bool(BITGET_PASSPHRASE),
    }


@app.get('/debug/ping-bitget')
async def debug_ping_bitget():
    """Attempt a DNS lookup for the configured BITGET_BASE host and optionally try a simple GET.
    Returns addresses found or an error message. This helps diagnose DNS / network issues
    like the "[Errno -2] Name or service not known" error.
    """
    try:
        parsed = urlparse(BITGET_BASE)
        host = parsed.hostname or BITGET_BASE
    except Exception:
        host = BITGET_BASE

    result = {"host": host}
    try:
        infos = socket.getaddrinfo(host, None)
        addrs = []
        for info in infos:
            addr = info[4][0]
            if addr not in addrs:
                addrs.append(addr)
        result["resolved"] = True
        result["addresses"] = addrs
    except Exception as e:
        result["resolved"] = False
        result["error"] = str(e)

    # Try a very short HEAD request to the base URL to check reachability (no auth)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(BITGET_BASE)
            result["http_status"] = resp.status_code
    except Exception as e:
        result["http_error"] = str(e)

    return result


@app.post('/debug/bitget-positions')
async def debug_bitget_positions(req: Request):
    """Query Bitget for positions for a symbol in simulated/productType mode.
    Accepts JSON { secret, symbol? } or Tradingview-Secret header. Returns Bitget response.
    """
    header_secret = req.headers.get("tradingview-secret") or req.headers.get("tradingview_secret")
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode()) if body_text else {}
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    # auth
    if header_secret:
        if header_secret != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Invalid tradingview secret header")
    else:
        if not payload.get("secret") or payload.get("secret") != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Missing or invalid secret")

    symbol = payload.get("symbol") or payload.get("ticker") or "BTCUSDT"
    # Map to Bitget symbol format
    raw = symbol.replace("BINANCE:", "").replace("/", "")
    if "_" not in raw and BITGET_PRODUCT_TYPE:
        bitget_symbol = f"{raw}_{BITGET_PRODUCT_TYPE}"
    else:
        bitget_symbol = raw

    body_obj = {"symbol": bitget_symbol, "marginCoin": BITGET_MARGIN_COIN}
    body = json.dumps(body_obj, separators=(",", ":"))
    request_path = "/api/mix/v1/position/singlePosition"

    # build signature
    timestamp = str(int(time.time() * 1000))
    sign = build_signature(timestamp, "POST", request_path, body, BITGET_SECRET)
    headers = {
        "ACCESS-KEY": BITGET_API_KEY,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
        "Content-Type": "application/json",
        "paptrading": PAPTRADING,
        "locale": "en-US",
    }

    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return {"ok": False, "dry_run": True, "note": "BITGET_DRY_RUN is enabled — not querying live Bitget", "payload": body_obj}

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(BITGET_BASE + request_path, headers=headers, content=body)
            try:
                parsed = resp.json()
            except Exception:
                parsed = resp.text
            return {"ok": True, "status_code": resp.status_code, "response": parsed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get('/debug/check-creds')
async def debug_check_creds():
    """Lightweight credentials check: perform a signed GET against a non-destructive
    account listing endpoint so we can see whether Bitget accepts the provided
    API key / secret / passphrase. This does NOT place trades.
    """
    # If dry-run is enabled, explicitly state that we won't call Bitget
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return {"ok": False, "dry_run": True, "note": "BITGET_DRY_RUN is enabled — not calling Bitget"}

    # Ensure credentials present
    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE):
        return {"ok": False, "error": "Missing Bitget credentials (API key/secret/passphrase)"}

    # Use account listing endpoint for the mix product as a safe read-only check.
    # Build request path including query string as required by Bitget's signature scheme.
    qp = f"productType={BITGET_PRODUCT_TYPE}" if BITGET_PRODUCT_TYPE else ""
    request_path = "/api/mix/v1/account/accounts"
    if qp:
        request_path_q = request_path + "?" + qp
    else:
        request_path_q = request_path

    timestamp = str(int(time.time() * 1000))
    # GET requests use empty body for signing
    try:
        sign = build_signature(timestamp, "GET", request_path_q, "", BITGET_SECRET)
    except Exception as e:
        return {"ok": False, "error": f"failed to build signature: {e}"}

    headers = {
        "ACCESS-KEY": BITGET_API_KEY,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
        "Content-Type": "application/json",
        "paptrading": PAPTRADING,
        "locale": "en-US",
    }

    url = BITGET_BASE + request_path_q
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, headers=headers)
            try:
                parsed = resp.json()
            except Exception:
                parsed = resp.text
            return {"ok": True, "status_code": resp.status_code, "response": parsed}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.on_event("startup")
async def startup():
    await database.connect()
    # Print important runtime info to help verify demo vs prod endpoints and dry-run
    try:
        print(f"[startup] BITGET_BASE={BITGET_BASE} BITGET_DRY_RUN={BITGET_DRY_RUN}")
    except Exception:
        pass
    # Warn if we're configured to send real orders but credentials are missing
    try:
        dry = str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on")
        missing_creds = not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE)
        if not dry and missing_creds:
            print("[startup][warning] BITGET_DRY_RUN is disabled but one or more Bitget credentials are missing: BITGET_API_KEY, BITGET_SECRET, BITGET_PASSPHRASE")
            print("[startup][warning] Set BITGET_DRY_RUN=1 to test locally without sending orders, or provide valid Bitget credentials to enable live/demo placements.")
    except Exception:
        pass

@app.on_event("shutdown")
async def shutdown():
    await database.disconnect()

@app.post("/webhook")
async def webhook(req: Request):
    """
    TradingView will POST the alert body to this endpoint.
    The TradingView message should be the JSON created by your PineScript,
    e.g. {"signal":"BUY","symbol":"BTCUSDT","price":42000,"time":"..."}
    We also expect a header 'Tradingview-Secret' or a JSON field 'secret' for verification.
    """
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode())
    except Exception:
        # If it's not JSON, return error
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    # simple verification:
    header_secret = req.headers.get("tradingview-secret") or req.headers.get("tradingview_secret")
    if header_secret:
        if header_secret != TRADINGVIEW_SECRET:
            raise HTTPException(status_code=403, detail="Invalid tradingview secret header")
    else:
        # fallback: allow if payload contains secret field that matches (less secure)
        if "secret" in payload and payload.get("secret") == TRADINGVIEW_SECRET:
            pass
        # else: allow anyway but note in logs (you can change this to reject)
    # Extract fields
    signal = payload.get("signal") or payload.get("action") or ""
    # If there's no explicit signal, fail loudly so misconfigured alerts are obvious.
    if not signal:
        # Return 400 so TradingView shows an error in the alert log and you can fix the alert message
        raise HTTPException(status_code=400, detail="Missing required field: 'signal' (expected 'BUY' or 'SELL')")
    symbol = payload.get("symbol") or payload.get("ticker") or ""
    price = payload.get("price")

    # Support explicit size or USD-based size from TradingView payload.
    # You can send {"size": 0.1} to place a quantity, or {"size_usd": 50} to indicate $50 worth.
    size = payload.get("size")
    size_usd = payload.get("size_usd") or payload.get("sizeUsd") or payload.get("sizeUSD")
    computed_size = None
    if size is not None:
        try:
            computed_size = float(size)
        except Exception:
            computed_size = None
    elif size_usd is not None:
        try:
            usd = float(size_usd)
            if price:
                p = float(price)
                fetched_price = p
            else:
                p = await get_market_price_with_retries(symbol)
                fetched_price = p
            if p and p != 0:
                # simple conversion: number of contracts = usd / price
                computed_size = usd / p
            else:
                raise HTTPException(status_code=400, detail="Missing price and unable to fetch market price; include price in the webhook or try again")
        except Exception:
            computed_size = None

    # If we fetched a market price to compute size, prefer that for DB storage
    price_for_db = price or (p if 'p' in locals() and p is not None else 0.0)
    # If price still missing, attempt to fetch a market price (with retries).
    if not price_for_db:
        fetched = await get_market_price_with_retries(symbol)
        if fetched:
            price_for_db = fetched
        else:
            # Fail loudly so we don't store 0.0; caller can retry the webhook when network is ok
            raise HTTPException(status_code=502, detail="Unable to fetch market price for symbol; try again")
    try:
        print(f"[webhook] computed market price p={locals().get('p', None)} price={price} price_for_db={price_for_db}")
    except Exception:
        pass

    # Save incoming alert to DB as pending (use discovered price when available)
    trade_id = str(uuid.uuid4())
    now = time.time()
    await database.execute(trades.insert().values(
        id=trade_id, signal=signal, symbol=symbol, price=price_for_db,
        status="received", response="", created_at=now
    ))
    try:
        print(f"[webhook] inserted pending trade id={trade_id} price={price_for_db}")
    except Exception:
        pass
    # Broadcast received alert
    await broadcast({"type":"received","id":trade_id,"signal":signal,"symbol":symbol,"price":price, "at":now})

    # Map signal to side
    if signal and signal.upper() in ("BUY","LONG"):
        side = "buy"
    elif signal and signal.upper() in ("SELL","SHORT"):
        side = "sell"
    else:
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="ignored", response="Unknown signal"))
        await broadcast({"type":"ignored","id":trade_id,"reason":"unknown signal"})
        return {"ok": False, "reason": "unknown signal"}

    # Place demo order
    try:
        # pass computed_size (or None) to place_demo_order; that function will fall back to "1" if None
        status_code, resp_text = await place_demo_order(symbol=symbol, side=side, price=price, size=computed_size)

        # Update stored trade with the Bitget response
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="placed", response=resp_text))

        # Include the price we persisted earlier so the frontend sees the market price
        await broadcast({
            "type": "placed",
            "id": trade_id,
            "status_code": status_code,
            "response": json.loads(resp_text) if resp_text else resp_text,
            "price": float(price_for_db) if 'price_for_db' in locals() and price_for_db is not None else None
        })

        return {"ok": True, "id": trade_id, "status_code": status_code, "response": resp_text}
    except Exception as e:
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="error", response=str(e)))
        await broadcast({"type": "error", "id": trade_id, "error": str(e)})
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/trades")
async def list_trades():
    rows = await database.fetch_all(trades.select().order_by(trades.c.created_at.desc()))
    return [dict(r) for r in rows]

# Simple WebSocket endpoint for frontend live updates
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connected_websockets.append(ws)
    try:
        while True:
            # just keep socket alive; frontend doesn't need to send messages
            data = await ws.receive_text()
            # Echo or ignore
            await ws.send_text(json.dumps({"type":"pong","msg":"ok"}))
    except WebSocketDisconnect:
        if ws in connected_websockets:
            connected_websockets.remove(ws)
