import httpx
import asyncio

async def get_product_types():
    base = 'https://api.bitget.com'

    # Try different product types
    product_types = ['USDT-FUTURES', 'usdt-futures', 'BBO', 'cbl', 'SUMCBL', 'UMCBL']

    for pt in product_types:
        print(f"\n--- Trying productType: {pt} ---")
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f'{base}/api/mix/v1/market/contracts?productType={pt}')
                print(f"Status: {resp.status_code}")
                if resp.status_code == 200:
                    data = resp.json()
                    if 'data' in data and data['data']:
                        print(f"Found {len(data['data'])} contracts")
                        for contract in data['data'][:3]:  # Show first 3
                            print(f"  Symbol: {contract.get('symbol')}, ProductType: {contract.get('productType')}")
                    else:
                        print("No contracts found")
                else:
                    print(f"Error response: {resp.text[:200]}...")
        except Exception as e:
            print(f"Exception: {e}")

if __name__ == "__main__":
    asyncio.run(get_product_types())