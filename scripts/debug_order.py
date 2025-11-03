import os
import time
import hmac
import hashlib
import base64
import json
import httpx
import asyncio
from dotenv import load_dotenv

# Load environment from .env (project root) and OS environment
load_dotenv()

# Read Bitget credentials and settings from environment variables so this
# script behaves the same way as the main app. Values default to empty string
# (credentials) or reasonable defaults for base/product type.
BITGET_API_KEY = os.getenv("BITGET_API_KEY", "")
BITGET_SECRET = os.getenv("BITGET_SECRET", "")
BITGET_PASSPHRASE = os.getenv("BITGET_PASSPHRASE", "")
BITGET_BASE = os.getenv("BITGET_BASE", "https://api.bitget.com")
BITGET_PRODUCT_TYPE = os.getenv("BITGET_PRODUCT_TYPE", "UMCBL")

# Optional: paptrading flag used by the main app
PAPTRADING = os.getenv("PAPTRADING", "1")

# Friendly startup info (do not print secrets)
print(f"[debug_order] BITGET_BASE={BITGET_BASE} BITGET_PRODUCT_TYPE={BITGET_PRODUCT_TYPE} has_api_key={bool(BITGET_API_KEY)}")

def build_signature(timestamp: str, method: str, request_path: str, body: str, secret: str):
    payload = f"{timestamp}{method.upper()}{request_path}{body}"
    mac = hmac.new(secret.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256)
    d = mac.digest()
    return base64.b64encode(d).decode()

async def test_order():
    # Test payload
    # Try without symbol suffix - maybe demo trading uses plain BTCUSDT
    body_obj = {
        "symbol": "BTCUSDT",
        "productType": "UMCBL",
        "orderType": "market",
        "size": "0.001",
        "marginCoin": "USDT",
        "marginMode": "crossed",
        "clientOid": "test123",
        "side": "buy_single",
        "positionSide": "long",
        "positionMode": "single"
    }

    body = json.dumps(body_obj, separators=(',', ':'))  # compact body

    # Test different endpoints
    candidates = [
        "/api/v2/mix/order/place-order",
        "/api/mix/v1/order/placeOrder?productType=UMCBL",
        "/api/mix/v1/order/placeOrder",
        "/api/v2/mix/order/placeOrder"
    ]

    async with httpx.AsyncClient(timeout=10.0) as client:
        for request_path in candidates:
            print(f"\n--- Testing {request_path} ---")

            # Build fresh timestamp and signature
            ts = str(int(time.time() * 1000))
            sign = build_signature(ts, "POST", request_path, body, BITGET_SECRET)

            headers = {
                "ACCESS-KEY": BITGET_API_KEY,
                "ACCESS-SIGN": sign,
                "ACCESS-TIMESTAMP": ts,
                "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
                "Content-Type": "application/json",
                "paptrading": "1",
                "locale": "en-US",
            }

            url = BITGET_BASE + request_path
            print(f"URL: {url}")
            print(f"Payload: {body}")

            try:
                resp = await client.post(url, headers=headers, content=body)
                print(f"Status: {resp.status_code}")
                print(f"Response: {resp.text}")

                if resp.status_code == 200:
                    print("SUCCESS!")
                    break
            except Exception as e:
                print(f"Exception: {e}")

if __name__ == "__main__":
    asyncio.run(test_order())