"""Simple end-to-end test helper.
Sends a TradingView-like webhook to your local (or deployed) API at /webhook,
then polls /trades and /debug/order-status to verify the trade was recorded
and (if BITGET_DRY_RUN=0) the order exists on Bitget.

Usage (PowerShell):
$env:API_BASE = 'http://127.0.0.1:8000'
$env:TRADINGVIEW_SECRET = 'SUPERSECRET23'
python .\scripts\test_webhook_and_bitget.py

The script reads environment variables:
- API_BASE (default http://127.0.0.1:8000)
- TRADINGVIEW_SECRET (required)
- SYMBOL (default BTCUSDT)
- SIZE_USD (default 10)
- PRICE (optional - used to compute size if needed)

Note: ensure your backend has BITGET_DRY_RUN set appropriately for your test.
"""

import os
import time
import json
import sys
import hmac
import hashlib
import base64
import requests
from pprint import pprint

API_BASE = os.getenv('API_BASE', 'https://capi-production-7bf3.up.railway.app').rstrip('/')
if API_BASE.endswith('/webhook'):
    API_BASE = API_BASE[: -len('/webhook')].rstrip('/')
    print('Note: trimmed API_BASE to', API_BASE)
TRADINGVIEW_SECRET = os.getenv('TRADINGVIEW_SECRET')
SYMBOL = os.getenv('SYMBOL', 'BTCUSDT')
SIZE_USD = os.getenv('SIZE_USD', '10')
PRICE = os.getenv('PRICE')

# Bitget credentials (needed when BITGET_DRY_RUN=0)
BITGET_API_KEY = os.getenv('BITGET_API_KEY')
BITGET_SECRET = os.getenv('BITGET_SECRET')
BITGET_PASSPHRASE = os.getenv('BITGET_PASSPHRASE')
BITGET_DRY_RUN = os.getenv('BITGET_DRY_RUN', '1')
BITGET_BASE = os.getenv('BITGET_BASE', 'https://api.bitget.com').rstrip('/')
BITGET_PRODUCT_TYPE = os.getenv('BITGET_PRODUCT_TYPE', 'UMCBL').upper()
BITGET_MARGIN_COIN = os.getenv('BITGET_MARGIN_COIN', '').upper()
BITGET_POSITION_MODE = os.getenv('BITGET_POSITION_MODE', 'single').lower()
if BITGET_POSITION_MODE not in ('single', 'double'):
    BITGET_POSITION_MODE = 'single'

if not TRADINGVIEW_SECRET:
    print('ERROR: TRADINGVIEW_SECRET environment variable is required')
    sys.exit(2)


def sign_bitget_request(timestamp: str, method: str, endpoint: str, body: str, secret: str) -> str:
    payload = f"{timestamp}{method.upper()}{endpoint}{body}"
    mac = hmac.new(secret.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256)
    return base64.b64encode(mac.digest()).decode()


def ensure_single_position_mode():
    if str(BITGET_DRY_RUN).lower() in ('1', 'true', 'yes', 'on'):
        return
    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE):
        raise RuntimeError('Missing Bitget API credentials in env; cannot enforce position mode')

    # Prepare candidate payloads/endpoints; Bitget has multiple variants (v1/v2, posMode/holdMode).
    base = BITGET_BASE.rstrip('/')
    pap_value = os.getenv('PAPTRADING', '1')
    target_mode = BITGET_POSITION_MODE
    base_symbol = (SYMBOL or '').replace('_', '').upper() or 'BTCUSDT'
    symbol_variants = []
    product_type = (BITGET_PRODUCT_TYPE or '').upper()
    if base_symbol:
        symbol_variants.append(base_symbol)
    if base_symbol and product_type:
        symbol_variants.append(f'{base_symbol}_{product_type}')
        if product_type == 'SUMCBL':
            symbol_variants.append(f'{base_symbol}_UMCBL')
    # Deduplicate while preserving order
    seen_symbols = set()
    symbol_variants = [s for s in symbol_variants if not (s in seen_symbols or seen_symbols.add(s))]

    if target_mode == 'double':
        mode_aliases = [
            ('posMode', 'double'),
            ('posMode', 'hedge'),
            ('holdMode', 'double_hold'),
        ]
        combo_payloads = [
            {'posMode': 'hedge', 'holdMode': 'double_hold'},
            {'posMode': 'double', 'holdMode': 'double_hold'},
        ]
    else:
        mode_aliases = [
            ('posMode', 'single'),
            ('posMode', 'one_way'),
            ('holdMode', 'single_hold'),
        ]
        combo_payloads = [
            {'posMode': 'one_way', 'holdMode': 'single_hold'},
            {'posMode': 'single', 'holdMode': 'single_hold'},
        ]

    endpoint_variants = [
        '/api/mix/v1/account/setPositionMode',
        '/api/v2/mix/account/set-position-mode',
    ]

    attempts = []
    for field, value in mode_aliases:
        base_payload = {field: value}
        if product_type:
            attempts.append((endpoint_variants[0], {**base_payload, 'productType': product_type}))
            attempts.append((endpoint_variants[1], {**base_payload, 'productType': product_type}))
        if symbol_variants:
            for sym in symbol_variants:
                attempts.append((endpoint_variants[0], {**base_payload, 'symbol': sym}))
                attempts.append((endpoint_variants[0], {**base_payload, 'symbol': sym, 'productType': product_type}))
                attempts.append((endpoint_variants[1], {**base_payload, 'symbol': sym}))
                attempts.append((endpoint_variants[1], {**base_payload, 'symbol': sym, 'productType': product_type}))
        else:
            attempts.append((endpoint_variants[0], base_payload))
            attempts.append((endpoint_variants[1], base_payload))

    for combo in combo_payloads:
        if product_type:
            attempts.append((endpoint_variants[0], {**combo, 'productType': product_type}))
            attempts.append((endpoint_variants[1], {**combo, 'productType': product_type}))
        if symbol_variants:
            for sym in symbol_variants:
                attempts.append((endpoint_variants[0], {**combo, 'symbol': sym}))
                attempts.append((endpoint_variants[0], {**combo, 'symbol': sym, 'productType': product_type}))
                attempts.append((endpoint_variants[1], {**combo, 'symbol': sym}))
                attempts.append((endpoint_variants[1], {**combo, 'symbol': sym, 'productType': product_type}))
        else:
            attempts.append((endpoint_variants[0], combo))
            attempts.append((endpoint_variants[1], combo))

    unique_attempts = []
    seen = set()
    for endpoint, payload in attempts:
        clean_payload = {k: v for k, v in payload.items() if v}
        if BITGET_MARGIN_COIN and 'marginCoin' not in clean_payload:
            clean_payload['marginCoin'] = BITGET_MARGIN_COIN
        key = (endpoint, tuple(sorted(clean_payload.items())))
        if key in seen:
            continue
        seen.add(key)
        unique_attempts.append((endpoint, clean_payload))

    last_data = None
    for endpoint, payload in unique_attempts:
        body = json.dumps(payload, separators=(',', ':'))
        timestamp = str(int(time.time() * 1000))
        signature = sign_bitget_request(timestamp, 'POST', endpoint, body, BITGET_SECRET)
        headers = {
            'ACCESS-KEY': BITGET_API_KEY,
            'ACCESS-SIGN': signature,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-PASSPHRASE': BITGET_PASSPHRASE,
            'Content-Type': 'application/json',
            'PAPTRADING': pap_value,
        }
        try:
            print(f'setPositionMode attempt {endpoint} payload={payload}')
        except Exception:
            pass
        resp = requests.post(base + endpoint, headers=headers, data=body, timeout=10)
        try:
            data = resp.json()
        except Exception:
            data = {'status_code': resp.status_code, 'body': resp.text}
        print('setPositionMode response:', data)
        if resp.status_code == 200 and isinstance(data, dict) and data.get('code') == '00000':
            print(f'setPositionMode succeeded via {endpoint}')
            return
        last_data = data

    if isinstance(last_data, dict) and last_data.get('code') in {'400172', '400171'}:
        print('Bitget API reported illegal/unchanged position mode; assuming account already in desired mode.')
        return

    raise RuntimeError(
        'Failed to set position mode automatically. '
        f'Last response: {last_data}. '
        'Log in to Bitget (demo), open Futures -> Settings, switch Position Mode to One-way (single), then rerun.'
    )

def post_webhook():
    url = API_BASE + '/webhook'
    headers = { 'Content-Type': 'application/json', 'Tradingview-Secret': TRADINGVIEW_SECRET }
    # ensure numeric types
    try:
        size_usd_val = float(SIZE_USD)
    except Exception:
        size_usd_val = 10.0

    # If PRICE not provided, attempt to fetch a live ticker price (Binance public API)
    price_val = None
    if PRICE:
        try:
            price_val = float(PRICE)
        except Exception:
            price_val = None
    if price_val is None:
        try:
            ticker_url = f'https://api.binance.com/api/v3/ticker/price?symbol={SYMBOL.upper()}'
            r = requests.get(ticker_url, timeout=5)
            if r.status_code == 200:
                j = r.json()
                price_val = float(j.get('price'))
                print(f'Fetched live price for {SYMBOL}: {price_val}')
        except Exception as e:
            print('Could not fetch live price:', e)
            price_val = None

    payload_size = None
    if price_val and price_val > 0:
        try:
            size_from_usd = size_usd_val / price_val
            if size_from_usd > 0:
                payload_size = max(size_from_usd, 0.001)
        except Exception:
            payload_size = None

    body = {
        'signal': 'BUY',
        'symbol': SYMBOL,
        'size_usd': size_usd_val,
        'price': price_val,
        'time': time.time()
    }
    if payload_size is not None:
        body['size'] = payload_size
    print(f'POST {url} -> payload: {body}')
    r = requests.post(url, headers=headers, json=body, timeout=15)
    print('Response status:', r.status_code)
    try:
        print('Response JSON:')
        pprint(r.json())
    except Exception:
        print('Response text:')
        print(r.text)
    return r

def find_trade(trade_id=None, wait_seconds=6):
    url = API_BASE + '/trades'
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        try:
            r = requests.get(url, timeout=10)
            rows = r.json()
            if trade_id:
                for t in rows:
                    if t.get('id') == trade_id:
                        return t
            else:
                # return most recent trade
                if rows:
                    return rows[0]
        except Exception as e:
            print('Error fetching trades:', e)
        time.sleep(1)
    return None


def query_order(order_id):
    url = API_BASE + '/debug/order-status'
    headers = { 'Content-Type': 'application/json', 'Tradingview-Secret': TRADINGVIEW_SECRET }
    body = { 'orderId': order_id }
    print(f'Querying order status for {order_id}')
    try:
        r = requests.post(url, headers=headers, json=body, timeout=15)
        print('Order-status response:', r.status_code)
        try:
            pprint(r.json())
        except Exception:
            print(r.text)
        return r
    except Exception as e:
        print('Error querying order-status:', e)
        return None


def main():
    print('Starting E2E test against', API_BASE)

    if str(BITGET_DRY_RUN).lower() not in ('1', 'true', 'yes', 'on'):
        ensure_single_position_mode()

    resp = post_webhook()
    if resp.status_code >= 400:
        print('Webhook returned error; aborting')
        sys.exit(3)

    data = None
    try:
        data = resp.json()
    except Exception:
        pass

    trade_id = None
    if isinstance(data, dict):
        trade_id = data.get('id')

    print('Waiting briefly for backend to persist trade...')
    trade = find_trade(trade_id=trade_id, wait_seconds=8)
    if not trade:
        print('Trade not found in /trades; fetching latest anyway...')
        trade = find_trade(wait_seconds=2)

    print('Trade record:')
    pprint(trade)

    # Extract orderId from webhook response (if present) or trade.response
    order_id = None
    if isinstance(data, dict):
        resp_field = data.get('response')
        if isinstance(resp_field, str):
            try:
                parsed = json.loads(resp_field)
            except Exception:
                parsed = None
        else:
            parsed = resp_field
        if isinstance(parsed, dict):
            order_id = parsed.get('orderId') or (parsed.get('data') or {}).get('orderId')

    # Fallback: try parse trade.response
    if not order_id and trade:
        resp_text = trade.get('response')
        if isinstance(resp_text, str):
            try:
                parsed = json.loads(resp_text)
            except Exception:
                parsed = None
        else:
            parsed = resp_text
        if isinstance(parsed, dict):
            order_id = parsed.get('orderId') or (parsed.get('data') or {}).get('orderId')

    if order_id:
        print('Found orderId:', order_id)
        q = query_order(order_id)
        if q and q.status_code == 200:
            print('Order query succeeded. Check Bitget UI for matching orderId.')
            sys.exit(0)
        else:
            print('Order query failed or returned non-200; inspect response above.')
            sys.exit(4)
    else:
        print('No orderId found in responses. If BITGET_DRY_RUN is enabled you will only see simulated orders (DRY-...).')
        sys.exit(5)

if __name__ == '__main__':
    main()
