import httpx
import asyncio

async def check_order_symbol():
    # Check if we can place an order with BTCUSDT_UMCBL
    base = 'https://api.bitget.com'

    # Try to get ticker data for the symbol
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f'{base}/api/mix/v1/market/ticker?symbol=BTCUSDT_UMCBL')
            print(f"Ticker check for BTCUSDT_UMCBL: Status {resp.status_code}")
            if resp.status_code == 200:
                data = resp.json()
                if 'data' in data:
                    print(f"Ticker data: {data['data']}")
                else:
                    print("No ticker data")
            else:
                print(f"Error: {resp.text}")

            # Try without the suffix
            resp2 = await client.get(f'{base}/api/mix/v1/market/ticker?symbol=BTCUSDT')
            print(f"\nTicker check for BTCUSDT: Status {resp2.status_code}")
            if resp2.status_code == 200:
                data = resp2.json()
                if 'data' in data:
                    print(f"Ticker data: {data['data']}")
                else:
                    print("No ticker data")
            else:
                print(f"Error: {resp2.text}")

    except Exception as e:
        print(f"Exception: {e}")

if __name__ == "__main__":
    asyncio.run(check_order_symbol())