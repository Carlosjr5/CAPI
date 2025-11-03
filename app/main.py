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
import httpx
import sqlalchemy
from databases import Database

load_dotenv()

BITGET_API_KEY = os.getenv("BITGET_API_KEY")
BITGET_SECRET = os.getenv("BITGET_SECRET")
BITGET_PASSPHRASE = os.getenv("BITGET_PASSPHRASE")
PAPTRADING = os.getenv("PAPTRADING", "1")
TRADINGVIEW_SECRET = os.getenv("TRADINGVIEW_SECRET")
BITGET_BASE = "https://api.bitget.com"
BITGET_PRODUCT_TYPE = os.getenv("BITGET_PRODUCT_TYPE", "usdt-futures")
BITGET_MARGIN_COIN = os.getenv("BITGET_MARGIN_COIN", "USDT")
BITGET_POSITION_MODE = os.getenv("BITGET_POSITION_MODE", "single")  # optional: e.g. 'single' for unilateral / one-way
BITGET_POSITION_TYPE = os.getenv("BITGET_POSITION_TYPE", "unilateral")  # optional: try values like 'unilateral' or 'one-way' if Bitget expects 'positionType'
BITGET_POSITION_SIDE = os.getenv("BITGET_POSITION_SIDE")  # optional: explicit position side e.g. 'long' or 'short'
BITGET_DRY_RUN = os.getenv("BITGET_DRY_RUN", "0")

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
# Allow CORS from local dev servers (React/Vite). Adjust origins in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
connected_websockets: List[WebSocket] = []

# Serve the frontend from the `static` folder. Index is available at '/'.
app.mount('/static', StaticFiles(directory=os.path.join(os.path.dirname(__file__), '..', 'static')), name='static')


@app.get('/')
async def root_index():
    # return the dashboard index.html from the static folder
    return FileResponse(os.path.join(os.path.dirname(__file__), '..', 'static', 'index.html'))

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
    # endpoint
    request_path = "/api/v2/mix/order/place-order"
    url = BITGET_BASE + request_path

    # Build the order payload using the shared helper
    body_obj = construct_bitget_payload(symbol=symbol, side=side, size=size)

    # Optional: include position mode if set via env. Bitget accounts can be one-way (unilateral)
    # or hedged. If your account is in unilateral mode and Bitget expects a matching order field,
    # set BITGET_POSITION_MODE in Railway (try 'single' or the value shown in Bitget docs) — this
    # will add a "positionMode" key to the order payload.
    if BITGET_POSITION_MODE:
        body_obj["positionMode"] = BITGET_POSITION_MODE

    # Map the incoming generic side (buy/sell) to the Bitget API's expected
    # values for the account's hold/position mode. For single/unilateral (one-way)
    # accounts Bitget expects 'buy_single' / 'sell_single' (or similar). For other
    # account modes we keep the original simple mapping (buy/sell) to avoid
    # accidental mismatches.
    side_key = side.lower()
    pm = str(BITGET_POSITION_MODE or "").lower()
    pt = str(BITGET_POSITION_TYPE or "").lower()
    single_indicators = ("single", "single_hold", "unilateral", "one-way", "one_way")
    if any(x in pm for x in single_indicators) or any(x in pt for x in ("unilateral", "one-way", "one_way")):
        # Use the single-hold side enum
        mapped = "buy_single" if side_key == "buy" else "sell_single"
        body_obj["side"] = mapped
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

    # Debugging: log outgoing request (without sensitive secrets) to help diagnose API errors.
    try:
        print(f"[bitget] POST {url}")
        print(f"[bitget] payload: {body}")
        # Do not print headers that contain secrets; only log the non-secret keys for context
        safe_headers = {k: v for k, v in headers.items() if k not in ("ACCESS-KEY", "ACCESS-SIGN", "ACCESS-PASSPHRASE")}
        print(f"[bitget] safe-headers: {safe_headers}")
    except Exception:
        pass

    # If dry-run is enabled, don't call Bitget — return a simulated successful response
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

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, headers=headers, content=body)
        # Log response for easier debugging
        try:
            print(f"[bitget] response status={resp.status_code} text={resp.text}")
        except Exception:
            pass
        return resp.status_code, resp.text


def construct_bitget_payload(symbol: str, side: str, size: float = None):
    """Construct the Bitget order payload dictionary without signing/sending.
    This mirrors the logic used by place_demo_order so it can be tested by
    the debug endpoint without making external calls.
    """
    body_obj = {
        "productType": BITGET_PRODUCT_TYPE,
        "symbol": symbol.replace("BINANCE:", "").replace("/", ""),
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
    single_indicators = ("single", "single_hold", "unilateral", "one-way", "one_way")
    if any(x in pm for x in single_indicators) or any(x in pt for x in ("unilateral", "one-way", "one_way")):
        mapped = "buy_single" if side_key == "buy" else "sell_single"
        body_obj["side"] = mapped
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
    size = payload.get("size")

    # Map signal to side
    if signal and str(signal).upper() in ("BUY", "LONG"):
        side = "buy"
    elif signal and str(signal).upper() in ("SELL", "SHORT"):
        side = "sell"
    else:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    constructed = construct_bitget_payload(symbol=symbol, side=side, size=size)
    return {"payload": constructed}

@app.on_event("startup")
async def startup():
    await database.connect()

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
            p = float(price) if price else 1.0
            if p and p != 0:
                # simple conversion: number of contracts = usd / price
                computed_size = usd / p
            else:
                computed_size = None
        except Exception:
            computed_size = None

    # Save incoming alert to DB as pending
    trade_id = str(uuid.uuid4())
    now = time.time()
    await database.execute(trades.insert().values(
        id=trade_id, signal=signal, symbol=symbol, price=price or 0.0,
        status="received", response="", created_at=now
    ))
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
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="placed", response=resp_text))
        await broadcast({"type":"placed","id":trade_id,"status_code":status_code,"response":json.loads(resp_text) if resp_text else resp_text})
        return {"ok": True, "id": trade_id, "status_code": status_code, "response": resp_text}
    except Exception as e:
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="error", response=str(e)))
        await broadcast({"type":"error","id":trade_id,"error":str(e)})
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
