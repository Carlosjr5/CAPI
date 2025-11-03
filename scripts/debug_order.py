import os
import time
import hmac
import hashlib
import base64
import json
import httpx
import asyncio

# Load env vars
BITGET_API_KEY = "bg_3990ce684aa84b5d0ba8de94f5ce18e0"
BITGET_SECRET = "822382b6ec0b8fb9a5f2e49ca963dc8e64fc484aaba164fe47f2296e61e33b92"
BITGET_PASSPHRASE = "2323232323"
BITGET_BASE = "https://api.bitget.com"
BITGET_PRODUCT_TYPE = "UMCBL"

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