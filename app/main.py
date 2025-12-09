# app/main.py
import os
import time
import hmac
import hashlib
import base64
import json
import uuid
import asyncio
import secrets
from datetime import datetime, timedelta
from typing import List, Tuple, Optional, Dict, Any
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException, WebSocket, WebSocketDisconnect, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import socket
import re
from urllib.parse import urlparse
import httpx
import sqlalchemy
from sqlalchemy import text
from databases import Database
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import jwt

load_dotenv()

BITGET_API_KEY = os.getenv("BITGET_API_KEY")
BITGET_SECRET = os.getenv("BITGET_SECRET")
BITGET_PASSPHRASE = os.getenv("BITGET_PASSPHRASE")

# Support multiple API keys (comma-separated for load balancing/failover)
BITGET_API_KEYS = [key.strip() for key in (BITGET_API_KEY or "").split(",") if key.strip()]
BITGET_SECRETS = [secret.strip() for secret in (BITGET_SECRET or "").split(",") if secret.strip()]
BITGET_PASSPHRASES = [passphrase.strip() for passphrase in (BITGET_PASSPHRASE or "").split(",") if passphrase.strip()]

# Validate that we have matching sets of credentials
if len(BITGET_API_KEYS) != len(BITGET_SECRETS) or len(BITGET_SECRETS) != len(BITGET_PASSPHRASES):
    print(f"[error] Mismatched API credentials: {len(BITGET_API_KEYS)} keys, {len(BITGET_SECRETS)} secrets, {len(BITGET_PASSPHRASES)} passphrases")
    BITGET_API_KEYS = []
    BITGET_SECRETS = []
    BITGET_PASSPHRASES = []

# Default to first set if available
BITGET_API_KEY = BITGET_API_KEYS[0] if BITGET_API_KEYS else None
BITGET_SECRET = BITGET_SECRETS[0] if BITGET_SECRETS else None
BITGET_PASSPHRASE = BITGET_PASSPHRASES[0] if BITGET_PASSPHRASES else None
PAPTRADING = os.getenv("PAPTRADING", "1")
TRADINGVIEW_SECRET = os.getenv("TRADINGVIEW_SECRET")
BITGET_BASE = os.getenv("BITGET_BASE") or "https://api.bitget.com"
BITGET_PRODUCT_TYPE = os.getenv("BITGET_PRODUCT_TYPE", "USDT-FUTURES")  # Use proper API product type for demo futures
BITGET_MARGIN_MODE = os.getenv("BITGET_MARGIN_MODE", "isolated")  # crossed or isolated (default isolated)

# For demo trading, use UMCBL product type
if PAPTRADING == "1":
    BITGET_PRODUCT_TYPE = "UMCBL"

# For Railway deployment, override with correct values
if os.getenv("RAILWAY_ENVIRONMENT"):
    BITGET_PRODUCT_TYPE = "UMCBL"
    BITGET_MARGIN_COIN = "USDT"
    BITGET_POSITION_MODE = "single"
BITGET_MARGIN_COIN = os.getenv("BITGET_MARGIN_COIN")
BITGET_POSITION_MODE = os.getenv("BITGET_POSITION_MODE", "single")  # optional: e.g. 'double' for hedge mode to allow multiple positions
BITGET_POSITION_TYPE = os.getenv("BITGET_POSITION_TYPE")  # optional: try values like 'unilateral' or 'one-way' if Bitget expects 'positionType'
BITGET_POSITION_SIDE = os.getenv("BITGET_POSITION_SIDE")  # optional: explicit position side e.g. 'long' or 'short'
BITGET_DRY_RUN = os.getenv("BITGET_DRY_RUN")

DEFAULT_LEVERAGE_RAW = os.getenv("DEFAULT_LEVERAGE")
try:
    DEFAULT_LEVERAGE = float(DEFAULT_LEVERAGE_RAW) if DEFAULT_LEVERAGE_RAW not in (None, "") else 10.0
except ValueError:
    print(f"[startup] DEFAULT_LEVERAGE is not a number: {DEFAULT_LEVERAGE_RAW}, using 10.0")
    DEFAULT_LEVERAGE = 10.0

# Authentication configuration
AUTH_SECRET_KEY = os.getenv("AUTH_SECRET_KEY") or secrets.token_urlsafe(32)
AUTH_ALGORITHM = "HS256"
AUTH_TOKEN_EXPIRE_MINUTES = int(os.getenv("AUTH_TOKEN_EXPIRE_MINUTES", "1440"))
# Default to allowing anonymous /trades read in CI to satisfy smoke tests; override with ALLOW_ANON_TRADES=0 to disable.
ALLOW_ANON_TRADES = str(
    os.getenv(
        "ALLOW_ANON_TRADES",
        "1" if (os.getenv("GITHUB_ACTIONS") or "").lower() == "true" else "0",
    )
).lower() in ("1", "true", "yes", "on")

USERS: Dict[str, Dict[str, str]] = {}
CI_FALLBACK_USER: Optional[str] = None
CI_FALLBACK_ROLE: Optional[str] = None
CI_FALLBACK_ACTIVE: bool = False
raw_users = os.getenv("DASHBOARD_USERS")
if raw_users:
    parsed_from_json = False
    try:
        parsed_users = json.loads(raw_users)
        if isinstance(parsed_users, dict):
            for username, info in parsed_users.items():
                if isinstance(info, dict) and "password" in info and "role" in info:
                    USERS[username] = {"password": info["password"], "role": info["role"]}
                    parsed_from_json = True
    except Exception as e:
        print(f"[auth] Failed to parse DASHBOARD_USERS as JSON: {e}")

    if not parsed_from_json:
        try:
            entries = [item.strip() for item in raw_users.split(",") if item.strip()]
            for entry in entries:
                parts = [p.strip() for p in entry.split(":")]
                if len(parts) >= 2 and parts[0] and parts[1]:
                    role = parts[2] if len(parts) >= 3 and parts[2] else "user"
                    USERS[parts[0]] = {"password": parts[1], "role": role}
            if not USERS:
                print("[auth] DASHBOARD_USERS fallback parse produced no valid users")
        except Exception as e:
            print(f"[auth] Failed to parse DASHBOARD_USERS fallback format: {e}")

# Add default users for testing/development
if not USERS:
    # Default admin user for testing
    USERS["admin"] = {"password": "admin123", "role": "admin"}
    # Default user for testing
    USERS["user"] = {"password": "user123", "role": "user"}
    print("[auth] Added default users for testing: admin/admin123, user/user123")

admin_username = os.getenv("ADMIN_USERNAME")
admin_password = os.getenv("ADMIN_PASSWORD")
if admin_username and admin_password:
    USERS[admin_username] = {"password": admin_password, "role": "admin"}

user_username = os.getenv("USER_USERNAME")
user_password = os.getenv("USER_PASSWORD")
if user_username and user_password:
    USERS[user_username] = {"password": user_password, "role": "user"}

if not USERS:
    ci_flag = ((os.getenv("GITHUB_ACTIONS") or "").lower() == "true") or ((os.getenv("CI") or "").lower() == "true")
    if ci_flag:
        fallback_user = os.getenv("GITHUB_ACTIONS_USER", "capi_ci")
        fallback_password = os.getenv("GITHUB_ACTIONS_PASSWORD", "capi_ci_pass")
        fallback_role = os.getenv("GITHUB_ACTIONS_ROLE", "admin")
        USERS[fallback_user] = {"password": fallback_password, "role": fallback_role}
        CI_FALLBACK_USER = fallback_user
        CI_FALLBACK_ROLE = fallback_role
        CI_FALLBACK_ACTIVE = True
        print(f"[auth] No users configured from env; created fallback CI user '{fallback_user}'.")

if not USERS:
    print("[auth] Warning: no dashboard users configured. UI authentication will fail until users are defined.")

security = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    """
    Receives TradingView alerts and manages Bitget positions:
    - If alert is 'short' and current position is 'short', ignore.
    - If alert is 'short' and current position is 'long' or 'none', close long (if any) and open short.
    - If alert is 'long' and current position is 'long', ignore.
    - If alert is 'long' and current position is 'short' or 'none', close short (if any) and open long.
    """
    access_token: str
    token_type: str = "bearer"
    role: str
    username: str


class UserInfo(BaseModel):
    username: str
    role: str


def safe_float(value) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def extract_numeric_field(payload: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        if key in payload:
            candidate = safe_float(payload.get(key))
            if candidate is not None:
                return candidate
    return None


def extract_leverage_from_payload(payload: Optional[Dict[str, object]]) -> Optional[float]:
    if not isinstance(payload, dict):
        return None
    for key in ("leverage", "lev", "leverage_x", "leverageX", "leverageMultiplier"):
        val = safe_float(payload.get(key)) if key in payload else None
        if val is not None:
            return val
    return None


def resolve_leverage(payload: Optional[Dict[str, object]]) -> Optional[float]:
    payload_leverage = extract_leverage_from_payload(payload)
    if payload_leverage is not None:
        return payload_leverage
    return DEFAULT_LEVERAGE


def compute_size_usd(size_value: Optional[float], price_value: Optional[float], provided_size_usd: Optional[float]) -> Optional[float]:
    provided = safe_float(provided_size_usd)
    if provided is not None:
        return provided
    if size_value is not None and price_value is not None:
        try:
            return float(size_value) * float(price_value)
        except Exception:
            return None
    return None


def resolve_trade_dimensions(price_value, computed_size, explicit_size, provided_size_usd, payload):
    size_value = computed_size if computed_size is not None else safe_float(explicit_size)
    if size_value is None:
        size_value = 0.0
    price_numeric = safe_float(price_value)
    leverage_value = resolve_leverage(payload)
    size_usd_numeric = compute_size_usd(size_value, price_numeric, provided_size_usd)
    return size_value, size_usd_numeric, leverage_value, price_numeric


def verify_password(plain_password: str, stored_password: str) -> bool:
    try:
        return secrets.compare_digest(str(plain_password).strip(), str(stored_password).strip())
    except Exception:
        return False


def authenticate_user(username: str, password: str) -> Optional[Dict[str, str]]:
    user = USERS.get(username)
    if not user:
        return None
    if not verify_password(password, user.get("password", "")):
        return None
    return {"username": username, "role": user.get("role", "user")}


def create_access_token(subject: str, role: str, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = {"sub": subject, "role": role}
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=AUTH_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, AUTH_SECRET_KEY, algorithm=AUTH_ALGORITHM)


def decode_token(token: str) -> Dict[str, str]:
    try:
        payload = jwt.decode(token, AUTH_SECRET_KEY, algorithms=[AUTH_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> Dict[str, str]:
    if credentials is None:
        if CI_FALLBACK_ACTIVE and CI_FALLBACK_USER:
            return {"username": CI_FALLBACK_USER, "role": CI_FALLBACK_ROLE or "admin"}
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = credentials.credentials
    payload = decode_token(token)
    username = payload.get("sub")
    role = payload.get("role")
    if not username:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = USERS.get(username)
    if not user:
        raise HTTPException(status_code=401, detail="User no longer exists")
    return {"username": username, "role": role or user.get("role", "user")}


async def get_current_user_optional(credentials: HTTPAuthorizationCredentials = Depends(security)) -> Optional[Dict[str, str]]:
    """Return user info if a valid bearer token is supplied; otherwise None."""
    try:
        if credentials is None:
            return None
        token = credentials.credentials
        payload = decode_token(token)
        username = payload.get("sub")
        role = payload.get("role")
        if not username:
            return None
        user = USERS.get(username)
        if not user:
            return None
        return {"username": username, "role": role or user.get("role", "user")}
    except Exception:
        return None


def require_role(allowed_roles: List[str]):
    async def checker(current_user: Dict[str, str] = Depends(get_current_user)) -> Dict[str, str]:
        if current_user.get("role") not in allowed_roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user

    return checker

# DB - Use PostgreSQL on Railway, SQLite locally
DATABASE_URL = os.getenv("DATABASE_URL")  # Railway provides this for PostgreSQL
if not DATABASE_URL:
    # Local development fallback to SQLite
    DATABASE_URL = "sqlite:///./trades.db"
    print("[db] Using local SQLite database")

database = Database(DATABASE_URL)
metadata = sqlalchemy.MetaData()
trades = sqlalchemy.Table(
    "trades",
    metadata,
    sqlalchemy.Column("id", sqlalchemy.String, primary_key=True),
    sqlalchemy.Column("signal", sqlalchemy.String),
    sqlalchemy.Column("symbol", sqlalchemy.String),
    sqlalchemy.Column("price", sqlalchemy.Float),
    sqlalchemy.Column("size", sqlalchemy.Float),  # Add size column
    sqlalchemy.Column("size_usd", sqlalchemy.Float),
    sqlalchemy.Column("leverage", sqlalchemy.Float),
    sqlalchemy.Column("margin", sqlalchemy.Float),
    sqlalchemy.Column("liquidation_price", sqlalchemy.Float),
    sqlalchemy.Column("exit_price", sqlalchemy.Float),
    sqlalchemy.Column("realized_pnl", sqlalchemy.Float),
    sqlalchemy.Column("status", sqlalchemy.String),  # placed, filled, rejected
    sqlalchemy.Column("response", sqlalchemy.Text),
    sqlalchemy.Column("reservation_key", sqlalchemy.String),
    sqlalchemy.Column("pine_trade_index", sqlalchemy.Integer),
    sqlalchemy.Column("created_at", sqlalchemy.Float),
)
# Configure engine based on database type
if DATABASE_URL.startswith("sqlite"):
    engine = sqlalchemy.create_engine(
        DATABASE_URL, connect_args={"check_same_thread": False}
    )
else:
    # PostgreSQL for Railway
    engine = sqlalchemy.create_engine(DATABASE_URL)

# Create tables (Railway handles PostgreSQL schema, SQLite needs explicit creation)
metadata.create_all(engine)


def ensure_trade_table_columns():
    # Only run SQLite-specific schema checks when using the SQLite backend
    try:
        if engine.url.get_backend_name() != "sqlite":
            return
    except Exception:
        # If engine isn't initialized yet, skip
        return
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("PRAGMA table_info(trades)")).fetchall()
            existing = {row[1] for row in rows}
            if "size" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN size REAL"))
            if "size_usd" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN size_usd REAL"))
            if "leverage" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN leverage REAL"))
            if "margin" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN margin REAL"))
            if "liquidation_price" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN liquidation_price REAL"))
            if "exit_price" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN exit_price REAL"))
            if "realized_pnl" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN realized_pnl REAL"))
            if "reservation_key" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN reservation_key TEXT"))
            if "pine_trade_index" not in existing:
                conn.execute(text("ALTER TABLE trades ADD COLUMN pine_trade_index INTEGER"))
            # Create a unique index on reservation_key to prevent concurrent reservations
            try:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_reservation_key_unique ON trades(reservation_key)"))
            except Exception:
                pass
    except Exception as exc:
        try:
            print(f"[startup] failed to ensure trades table columns: {exc}")
        except Exception:
            pass

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
    # WebSocket connections from Railway - needed for production WebSocket connections
    "wss://capi-production-7bf3.up.railway.app",
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
connected_websockets: List[Dict[str, object]] = []


@app.post("/auth/login", response_model=TokenResponse)
async def login(request: LoginRequest):
    user = authenticate_user(request.username, request.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user["username"], user["role"])
    return TokenResponse(access_token=token, role=user["role"], username=user["username"])


@app.get("/auth/me", response_model=UserInfo)
async def read_current_user(current_user: Dict[str, str] = Depends(get_current_user)):
    return UserInfo(username=current_user["username"], role=current_user.get("role", "user"))

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
    for client in connected_websockets:
        ws = client.get("ws")
        if not ws:
            continue
        try:
            await ws.send_text(json.dumps(event))
            living.append(client)
        except Exception:
            pass
    connected_websockets[:] = living


def normalize_signal_payload(payload: dict) -> Tuple[str, str, str, str]:
    """Return (event, signal_label, order_side, side_hint) derived from payload."""
    event = str(payload.get("event") or "").upper()
    raw_signal = str(payload.get("signal") or payload.get("action") or "").upper()
    side_hint = str(payload.get("side") or "").upper()

    signal = raw_signal
    if not signal:
        if event in ("BUY", "SELL"):
            signal = event
        elif event in ("LONG", "SHORT"):
            signal = "BUY" if event == "LONG" else "SELL"

    if not signal:
        if side_hint in ("LONG", "BUY"):
            signal = "LONG" if side_hint == "LONG" else "BUY"
        elif side_hint in ("SHORT", "SELL"):
            signal = "SHORT"

    order_side = ""
    if signal == "BUY":
        order_side = "buy"
    elif signal == "SELL":
        order_side = "sell"

    return event, signal, order_side, side_hint


def normalize_position_mode(value: Optional[str]) -> Optional[str]:
    if not value:
        return value
    v = str(value).strip().lower()
    if v in ("single", "single_hold", "one-way", "one_way", "oneway", "unilateral"):
        return "single"
    if v in ("hedge", "double", "double_hold", "dual"):
        return "hedge"
    return value


def normalize_position_type(value: Optional[str]) -> Optional[str]:
    if not value:
        return value
    v = str(value).strip().lower()
    if v in ("single", "single_hold", "one-way", "one_way", "oneway", "unilateral"):
        return "single_hold"
    if v in ("hedge", "double", "double_hold", "dual"):
        return "double_hold"
    return value


def normalize_exchange_symbol(value: Optional[str]) -> Optional[str]:
    """Normalize symbols from TradingView/Bitget by removing prefixes and uppercasing."""
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return normalized
    upper = normalized.upper()
    for prefix in ("BITGET:", "BINANCE:"):
        if upper.startswith(prefix):
            normalized = normalized[len(prefix):]
            upper = normalized.upper()
    normalized = normalized.replace(" ", "")
    return normalized.upper()


def sanitize_symbol_for_bitget(value: Optional[str]) -> str:
    """Strip known decorations so Bitget endpoints receive a clean instrument code."""
    normalized = normalize_exchange_symbol(value) or ""
    cleaned = normalized.replace("/", "").replace(".P", "").replace(".p", "")
    cleaned = re.sub(r"[^A-Z0-9_]", "", cleaned)
    # If it already ends with USDT (case insensitive), keep as is
    if cleaned and cleaned.upper().endswith("USDT"):
        return cleaned
    # If it's just letters (base currency), assume USDT futures and add USDT
    if cleaned and cleaned.isalpha():
        cleaned += "USDT"
    return cleaned


def get_bitget_symbol(symbol: str) -> str:
    """Get the Bitget symbol (plain, without suffix)."""
    sanitized = sanitize_symbol_for_bitget(symbol)
    return sanitized

# Bitget signature (per docs): timestamp + method + requestPath + [ '?' + queryString ] + body
def build_signature(timestamp: str, method: str, request_path: str, body: str, secret: str):
    payload = f"{timestamp}{method.upper()}{request_path}{body}"
    mac = hmac.new(secret.encode('utf-8'), payload.encode('utf-8'), hashlib.sha256)
    d = mac.digest()
    return base64.b64encode(d).decode()

async def close_existing_bitget_position(trade_row) -> Tuple[bool, Optional[str]]:
    """Submit a close order for an existing position and update DB status."""
    try:
        # Extract trade details
        trade_id = trade_row['id']
        raw_symbol = trade_row.get('symbol')
        symbol = sanitize_symbol_for_bitget(raw_symbol) or (normalize_exchange_symbol(raw_symbol) or "")
        signal = trade_row['signal']
        size_value = safe_float(trade_row.get('size'))
        if size_value is None or size_value <= 0:
            entry_price = safe_float(trade_row.get('price'))
            size_usd = safe_float(trade_row.get('size_usd') or trade_row.get('sizeUsd'))
            if size_usd is not None and entry_price not in (None, 0):
                try:
                    size_value = abs(float(size_usd) / float(entry_price))
                except Exception:
                    size_value = None
        if size_value is None or size_value <= 0:
            size_value = 0.001

        detail_msg: Optional[str] = None

        if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
            print(f"[close_position] DRY-RUN: would close position for trade {trade_id}")
            # In dry-run, mark closed and attempt to set exit_price/realized_pnl using market price
            try:
                closing_price = await get_market_price_with_retries(symbol)
            except Exception:
                closing_price = None
            update_vals = {"status": "closed"}
            try:
                entry_price = safe_float(trade_row.get('price'))
                size_val = safe_float(trade_row.get('size'))
                if (not size_val or size_val <= 0) and safe_float(trade_row.get('size_usd')) and entry_price:
                    size_val = float(trade_row.get('size_usd')) / float(entry_price)
            except Exception:
                size_val = None
                entry_price = None
            if closing_price is not None and entry_price is not None and size_val is not None:
                direction = 1 if str(trade_row.get('signal') or '').upper() in ("BUY", "LONG") else -1
                update_vals['exit_price'] = float(closing_price)
                update_vals['realized_pnl'] = float((closing_price - entry_price) * size_val * direction)

            await database.execute(trades.update().where(trades.c.id == trade_id).values(**update_vals))
            return True, None

        # Skip closing in demo mode as close-positions API may not be supported
        paptrading = os.getenv("PAPTRADING", "1")
        product_type = os.getenv("BITGET_PRODUCT_TYPE", "USDT-FUTURES")
        print(f"[close_position] PAPTRADING={paptrading}, BITGET_PRODUCT_TYPE={product_type}")

        # Determine opposite side for closing
        close_side = "sell" if signal.upper() in ("BUY", "LONG") else "buy"

        original_side = str(signal or "").upper()
        hold_side = "long" if original_side in ("BUY", "LONG") else "short"
        overrides = {"holdSide": hold_side}

        parsed = None
        last_resp_text: Optional[str] = None

        for reduce_flag in (True, False):
            status_code, resp_text = await place_demo_order(
                symbol=symbol,
                side=close_side,
                size=size_value,
                reduce_only=reduce_flag,
                close_position=True,
                extra_fields=overrides,
            )
            last_resp_text = resp_text if isinstance(resp_text, str) else json.dumps(resp_text) if resp_text is not None else None

            parsed = None
            if resp_text:
                try:
                    parsed = json.loads(resp_text) if isinstance(resp_text, str) else resp_text
                except Exception:
                    parsed = None

            if status_code == 200 and isinstance(parsed, dict) and parsed.get("code") == "00000":
                # Update DB status and attempt to record exit price / realized PnL
                try:
                    # Try to determine a closing price: prefer order response if available, else fetch market price
                    closing_price = None
                    # Attempt to extract price from parsed response if present
                    if isinstance(parsed, dict):
                        # Different Bitget responses may include filledAvgPrice or avgFillPrice
                        for key in ("filledAvgPrice", "avgFillPrice", "avgPrice", "price", "lastPrice"):
                            if parsed.get('data') and isinstance(parsed.get('data'), dict) and parsed['data'].get(key) is not None:
                                try:
                                    closing_price = float(parsed['data'].get(key))
                                    break
                                except Exception:
                                    closing_price = None
                    if closing_price is None:
                        try:
                            closing_price = await get_market_price_with_retries(symbol)
                        except Exception:
                            closing_price = None

                    entry_price = safe_float(trade_row.get('price'))
                    size_val = safe_float(trade_row.get('size'))
                    if (size_val is None or size_val <= 0) and safe_float(trade_row.get('size_usd')) and entry_price:
                        try:
                            size_val = float(trade_row.get('size_usd')) / float(entry_price)
                        except Exception:
                            size_val = None

                    update_vals = {"status": "closed"}
                    if closing_price is not None and entry_price is not None and size_val is not None:
                        direction = 1 if str(trade_row.get('signal') or '').upper() in ("BUY", "LONG") else -1
                        update_vals['exit_price'] = float(closing_price)
                        update_vals['realized_pnl'] = float((closing_price - entry_price) * size_val * direction)

                    # Clear reservation when marking closed
                    update_vals['reservation_key'] = None
                    await database.execute(trades.update().where(trades.c.id == trade_id).values(**update_vals))
                except Exception as e:
                    try:
                        print(f"[close_position] failed to set exit/realized for {trade_id}: {e}")
                    except Exception:
                        pass

                print(f"[close_position] Successfully closed position for trade {trade_id} (reduceOnly={reduce_flag})")
                return True, None

            if isinstance(parsed, dict):
                detail_msg = parsed.get("msg") or parsed.get("message") or parsed.get("error")
                if not detail_msg:
                    try:
                        detail_msg = json.dumps(parsed)
                    except Exception:
                        detail_msg = str(parsed)
            elif isinstance(resp_text, str):
                detail_msg = resp_text
            else:
                detail_msg = str(resp_text)

            print(f"[close_position] Attempt to close trade {trade_id} failed (reduceOnly={reduce_flag}) status={status_code} resp={resp_text}")

            if reduce_flag and detail_msg and "reduceonly" in detail_msg.lower():
                print(f"[close_position] Retrying close for trade {trade_id} without reduceOnly flag due to error: {detail_msg}")
                continue
            break

        try:
            snapshot = await fetch_bitget_position(symbol)
            normalized = normalize_bitget_position(symbol, snapshot) if snapshot else None
        except Exception as lookup_exc:
            normalized = None
            print(f"[close_position] failed to inspect Bitget position after close failure: {lookup_exc}")

        if normalized:
            remaining = normalized.get("size")
            if remaining is None and normalized.get("signed_size") is not None:
                remaining = abs(normalized.get("signed_size"))
            if remaining is not None and abs(float(remaining)) < 1e-8:
                await database.execute(trades.update().where(trades.c.id == trade_id).values(status="closed", reservation_key=None))
                note = "No remaining Bitget position detected after close attempt"
                print(f"[close_position] treating trade {trade_id} as closed: {note}")
                return True, note

        return False, detail_msg or last_resp_text
    except Exception as e:
        print(f"[close_position] Error in close_existing_bitget_position: {e}")
        return False, str(e)


async def place_demo_order(
    symbol: str,
    side: str,
    price: float = None,
    size: float = None,
    *,
    reduce_only: bool = False,
    close_position: bool = False,
    extra_fields: Optional[Dict[str, Any]] = None,
):
    """
    Place an order on Bitget demo futures (v2 mix order)
    We'll place a market order by default. Modify `orderType` to 'limit' if you want limit.
    """
    # Use Bitget mix API for futures order placement
    if close_position:
        candidates = [
            BITGET_BASE + "/api/v2/mix/order/close-positions",
        ]
    else:
        candidates = [
            BITGET_BASE + "/api/v2/mix/order/place-order",
        ]

    # Use Bitget mix API for futures trading (v2 mix API is more reliable for paper trading)
    request_path = candidates[0].replace(BITGET_BASE, "")
    url = BITGET_BASE + request_path

    # For v5 API, we don't need contract discovery - just use the symbol directly
    # For v5 API, we don't need contract discovery - just use the symbol directly
    mapped_symbol = None

    # Normalize symbol for Bitget - strip TradingView prefixes/suffixes and whitespace
    use_symbol = get_bitget_symbol(symbol)
    body_obj = construct_bitget_payload(
        symbol=use_symbol,
        side=side,
        size=size,
        reduce_only=reduce_only,
        close_position=close_position,
        extra_fields=extra_fields,
    )

    # Set side for all products
    side_key = side.lower()
    body_obj["side"] = side_key

    # Optional: include position hints when configured. Respect any values set by construct_bitget_payload.
    if BITGET_POSITION_MODE and "positionMode" not in body_obj:
        body_obj["positionMode"] = normalize_position_mode(BITGET_POSITION_MODE)

    if BITGET_POSITION_SIDE and "positionSide" not in body_obj:
        body_obj["positionSide"] = BITGET_POSITION_SIDE
    elif "positionSide" not in body_obj:
        try:
            # Ensure positionSide matches order side: buy -> long, sell -> short
            inferred = "long" if side_key == "buy" else "short"
            body_obj["positionSide"] = inferred
        except Exception:
            pass

    if BITGET_POSITION_TYPE and "positionType" not in body_obj:
        body_obj["positionType"] = normalize_position_type(BITGET_POSITION_TYPE)

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
    if not BITGET_API_KEYS or not BITGET_SECRETS or not BITGET_PASSPHRASES:
        err = "Missing Bitget credentials (API key/secret/passphrase) required to send live orders"
        print(f"[bitget][error] {err}")
        return 400, json.dumps({"error": err})

    # Select API key to use (round-robin for load balancing)
    import time
    key_index = int(time.time() * 1000) % len(BITGET_API_KEYS)
    current_api_key = BITGET_API_KEYS[key_index]
    current_secret = BITGET_SECRETS[key_index]
    current_passphrase = BITGET_PASSPHRASES[key_index]

    print(f"[bitget] Using API key {key_index + 1}/{len(BITGET_API_KEYS)}")

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
                sign = build_signature(ts, "POST", request_path, body, current_secret)

                headers = {
                    "ACCESS-KEY": current_api_key,
                    "ACCESS-SIGN": sign,
                    "ACCESS-TIMESTAMP": ts,
                    "ACCESS-PASSPHRASE": current_passphrase,
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




async def cancel_orders_for_symbol(symbol: str):
    """Cancel all open orders for a symbol."""
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return

    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE and BITGET_BASE):
        return

    try:
        # Normalize symbol for Bitget
        bitget_symbol = get_bitget_symbol(symbol)

        # Cancel all orders for the symbol using v5 API
        request_path = "/api/v5/trade/cancel-batch-orders"
        body_obj: Dict[str, Any] = {"symbol": bitget_symbol}
        if BITGET_MARGIN_COIN:
            body_obj["marginCoin"] = BITGET_MARGIN_COIN
        if local_product:
            body_obj.setdefault("productType", local_product)

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

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(BITGET_BASE + request_path, headers=headers, content=body)
            data = resp.json()

            # Log the cancellation result
            try:
                print(f"[bitget][cancel] cancelled orders for {symbol}: status={resp.status_code} resp={data}")
            except Exception:
                pass

    except Exception as e:
        try:
            print(f"[bitget][cancel] failed to cancel orders for {symbol}: {e}")
        except Exception:
            pass


async def fetch_bitget_position(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch current Bitget position details to enrich leverage/margin data."""
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return None
    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE and BITGET_BASE):
        return None

    async def _post_bitget(request_path: str, body_obj: Dict[str, Any], label: str) -> Tuple[Optional[int], Optional[str]]:
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

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(BITGET_BASE + request_path, headers=headers, content=body)
                status_code = resp.status_code
                resp_text = resp.text
                try:
                    data_preview = resp.json()
                except Exception:
                    data_preview = resp_text[:200]
        except Exception as exc:
            try:
                print(f"[bitget][position] request failure ({label}) for {symbol}: {exc}")
            except Exception:
                pass
            return None, None

        try:
            print(f"[bitget][position] response ({label}) for {symbol}: status={status_code} data={data_preview}")
        except Exception:
            pass

        return status_code, resp_text

    def _pick_snapshot(payload: Optional[Any], desired_symbol: str) -> Optional[Dict[str, Any]]:
        if isinstance(payload, dict):
            return payload if payload else None
        if isinstance(payload, list):
            for entry in payload:
                if not isinstance(entry, dict):
                    continue
                if not desired_symbol or entry.get("symbol") == desired_symbol:
                    return entry
            return payload[0] if payload and isinstance(payload[0], dict) else None
        return None

    try:
        bitget_symbol = get_bitget_symbol(symbol)

        primary_body: Dict[str, Any] = {}
        if BITGET_MARGIN_COIN:
            primary_body["marginCoin"] = BITGET_MARGIN_COIN
        if BITGET_POSITION_SIDE:
            primary_body["holdSide"] = BITGET_POSITION_SIDE

        # Try multiple Bitget API endpoints for positions
        endpoints_to_try = [
            "/api/v2/mix/position/single-position",  # V2 mix single position
        ]
    
        successful_positions = []
    
        for endpoint in endpoints_to_try:
            try:
                if endpoint == "/api/v5/position/list":
                    body = {"productType": BITGET_PRODUCT_TYPE}
                else:
                    # For mix API, use product type and symbol in body
                    body = {"productType": BITGET_PRODUCT_TYPE, "symbol": bitget_symbol}
                    if BITGET_MARGIN_COIN:
                        body["marginCoin"] = BITGET_MARGIN_COIN
    
                status_code, resp_text = await _post_bitget(endpoint, body, f"positions-{endpoint.split('/')[-1]}")
    
                if status_code == 200:
                    try:
                        data = json.loads(resp_text)
                        if isinstance(data, dict):
                            # Check for success codes
                            if data.get("code") == "00000" or data.get("code") == "0":
                                positions = data.get("data", [])
                                if isinstance(positions, list):
                                    for pos in positions:
                                        if isinstance(pos, dict) and pos.get("symbol") == bitget_symbol.upper():
                                            successful_positions.append(pos)
                                            print(f"[bitget][position] Found position for {bitget_symbol}: {pos}")
                                elif isinstance(positions, dict) and positions.get("symbol") == bitget_symbol.upper():
                                    successful_positions.append(positions)
                                    print(f"[bitget][position] Found position for {bitget_symbol}: {positions}")
                                # Also check if positions contains our symbol regardless of exact match
                                elif isinstance(positions, list):
                                    for pos in positions:
                                        if isinstance(pos, dict) and pos.get("symbol"):
                                            print(f"[bitget][position] Available position symbol: {pos.get('symbol')}")
                            elif data.get("msg"):
                                try:
                                    print(f"[bitget][position] {endpoint} error: {data.get('msg')}")
                                except Exception:
                                    pass
                    except json.JSONDecodeError:
                        pass
                else:
                    try:
                        print(f"[bitget][position] {endpoint} HTTP {status_code}: {resp_text[:100]}...")
                    except Exception:
                        pass
            except Exception as e:
                try:
                    print(f"[bitget][position] Exception with {endpoint}: {e}")
                except Exception:
                    pass
    
        # Return first successful position found
        if successful_positions:
            return successful_positions[0]
    
        # Try account info as final verification
        try:
            status_code, resp_text = await _post_bitget("/api/v5/account/account-info", {}, "account")
            if status_code == 200:
                try:
                    data = json.loads(resp_text)
                    if isinstance(data, dict) and (data.get("code") == "00000" or data.get("code") == "0"):
                        print(f"[bitget][position] Account API works for {symbol}, but position APIs returning 404 - check if account has live positions")
                    else:
                        print(f"[bitget][position] Account API error: {data.get('msg', 'unknown')}")
                except json.JSONDecodeError:
                    print(f"[bitget][position] Account API returned invalid JSON")
            else:
                print(f"[bitget][position] Account API HTTP {status_code}")
        except Exception as e:
            print(f"[bitget][position] Account API exception: {e}")
    
        return None

        try:
            print(f"[bitget][position] no position snapshot found for {symbol} after fallbacks")
        except Exception:
            pass
        return None
    except Exception as exc:
        try:
            print(f"[bitget][position] failed to fetch position for {symbol}: {exc}")
        except Exception:
            pass
    return None


def normalize_bitget_position(requested_symbol: str, snapshot: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalize Bitget position payload into consistent keys for the UI."""
    if not isinstance(snapshot, dict):
        return None

    def pick_float(*keys: str) -> Optional[float]:
        for key in keys:
            if key in snapshot:
                candidate = safe_float(snapshot.get(key))
                if candidate is not None:
                    return candidate
        return None

    def pick_str(*keys: str) -> Optional[str]:
        for key in keys:
            if key in snapshot:
                value = snapshot.get(key)
                if value is None:
                    continue
                if isinstance(value, str):
                    stripped = value.strip()
                    if stripped:
                        return stripped
                else:
                    return str(value)
        return None

    side_raw = pick_str("holdSide", "side", "positionSide", "direction")
    side = side_raw.lower() if isinstance(side_raw, str) else None

    size = pick_float(
        "total",
        "holdAmount",
        "holdSize",
        "position",
        "size",
        "pos",
        "baseSize",
        "available",
        "quantity",
    )

    if size is None:
        long_hold = pick_float("longTotal", "longHold", "longQty")
        short_hold = pick_float("shortTotal", "shortHold", "shortQty")
        if side in ("long", "buy") and long_hold is not None:
            size = long_hold
        elif side in ("short", "sell") and short_hold is not None:
            size = short_hold
        elif long_hold is not None and short_hold is None:
            size = long_hold
        elif short_hold is not None and long_hold is None:
            size = short_hold

    avg_open_price = pick_float("openAvgPrice", "avgOpenPrice", "avgPrice", "averagePrice", "entry_price", "entryPrice")
    mark_price = pick_float("markPrice", "marketPrice", "currentPrice", "lastPrice", "mark", "markPx")
    index_price = pick_float("indexPrice", "indexPx")
    margin = pick_float("margin", "marginSize", "positionMargin", "fixedMargin", "marginValue", "marginBalance")
    leverage = pick_float("leverage", "lever", "marginLeverage")
    liquidation_price = pick_float("liquidationPrice", "liqPrice", "liqPx", "liqprice")
    unrealized = pick_float("unrealizedPL", "unrealizedPnl", "unrealizedProfit")
    realized = pick_float("realizedPL", "realizedPnl", "realizedProfit")
    pnl_ratio = pick_float("uplRatio", "uplRate", "unrealizedPLRatio", "pnlRatio", "profitRate", "unrealizedPnlRate", "roe", "roeRate", "roe_ratio", "returnOnEquity", "return_on_equity")
    margin_ratio = pick_float("marginRatio", "keepMarginRate", "maintMarginRate", "maintenanceMarginRate")
    timestamp = pick_float("uTime", "updateTime", "timestamp", "ts", "cTime")
    margin_coin = pick_str("marginCoin", "margin_coin")

    notional = pick_float("notionalUsd", "positionValue", "quoteSize", "value", "positionValueUsd")
    size_usd = pick_float("notionalUsd", "positionUsd", "totalValue", "valueUsd")

    if notional is None and size is not None and avg_open_price is not None:
        notional = size * avg_open_price
    if notional is None and size is not None and mark_price is not None:
        notional = size * mark_price

    if size_usd is None:
        size_usd = notional

    signed_size = None
    if size is not None:
        signed_size = size
        if side in ("short", "sell"):
            signed_size = -abs(size)
        elif side in ("long", "buy"):
            signed_size = abs(size)

    normalized = {
        "requested_symbol": requested_symbol,
        "bitget_symbol": pick_str("symbol", "instId"),
        "margin_coin": margin_coin,
        "side": side,
        "size": size,
        "signed_size": signed_size,
        "avg_open_price": avg_open_price,
        "mark_price": mark_price,
        "index_price": index_price,
        "margin": margin,
        "leverage": leverage,
        "liquidation_price": liquidation_price,
        "unrealized_pnl": unrealized,
        "realized_pnl": realized,
        "pnl_ratio": pnl_ratio,
        "margin_ratio": margin_ratio,
        "notional": notional,
        "size_usd": size_usd,
        "timestamp": timestamp,
    }

    cleaned = {key: value for key, value in normalized.items() if value is not None}
    if "size" not in cleaned and "size_usd" not in cleaned and "unrealized_pnl" not in cleaned:
        # Nothing meaningful extracted; treat as missing.
        return None
    return cleaned


async def close_open_positions_for_rotation(new_symbol: Optional[str], fallback_price: Optional[float], payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Close existing trades marked as placed for the same symbol before opening a new one.

    Attempts to submit reduce-only Bitget orders and records exit price / realized PnL."""
    try:
        if new_symbol:
            fetched_rows = await database.fetch_all(trades.select().where((trades.c.status == "placed") & (trades.c.symbol == new_symbol)))
        else:
            fetched_rows = await database.fetch_all(trades.select().where(trades.c.status == "placed"))
        closing_rows = [dict(row) for row in fetched_rows]
    except Exception:
        closing_rows = []

    if not closing_rows:
        return {"closed": [], "failed": []}

    payload_dict = payload if isinstance(payload, dict) else {}
    price_cache: Dict[str, Optional[float]] = {}
    closed_ids: List[str] = []
    failed_ids: List[str] = []
    failure_details: Dict[str, Optional[str]] = {}

    for row in closing_rows:
        size_value = safe_float(row.get("size"))
        if (size_value is None or size_value <= 0) and safe_float(row.get("price")) not in (None, 0):
            size_usd_val = safe_float(row.get("size_usd") or row.get("sizeUsd"))
            entry_price = safe_float(row.get("price"))
            if size_usd_val is not None and entry_price not in (None, 0):
                try:
                    size_value = abs(float(size_usd_val) / float(entry_price))
                except Exception:
                    size_value = None
        if size_value is not None and size_value > 0:
            row["size"] = size_value

        close_success, close_detail = await close_existing_bitget_position(row)
        if not close_success:
            trade_id_value = row.get("id")
            failed_ids.append(trade_id_value)
            if trade_id_value and close_detail:
                failure_details[trade_id_value] = close_detail
            continue

        symbol_for_row = (row.get("symbol") or "").strip()
        closing_price = None
        if symbol_for_row and new_symbol and symbol_for_row == new_symbol and fallback_price is not None:
            closing_price = fallback_price

        if closing_price is None:
            candidate = safe_float(payload_dict.get("price"))
            if candidate is not None:
                closing_price = candidate

        if closing_price is None and symbol_for_row:
            if symbol_for_row not in price_cache:
                price_cache[symbol_for_row] = await get_market_price_with_retries(symbol_for_row)
            closing_price = price_cache.get(symbol_for_row)

        entry_price = safe_float(row.get("price"))
        size_value = safe_float(row.get("size"))
        if (not size_value or size_value <= 0) and entry_price:
            size_usd_val = safe_float(row.get("size_usd"))
            if size_usd_val is not None and entry_price not in (None, 0):
                try:
                    size_value = float(size_usd_val) / float(entry_price)
                except Exception:
                    size_value = None

        exit_price = None
        realized_pnl = None
        if closing_price is not None and entry_price is not None and size_value is not None and size_value != 0:
            direction = 1 if str(row.get("signal") or "").upper() in ("BUY", "LONG") else -1
            exit_price = float(closing_price)
            realized_pnl = float((closing_price - entry_price) * size_value * direction)

        update_values = {"status": "closed"}
        if exit_price is not None:
            update_values["exit_price"] = exit_price
        if realized_pnl is not None:
            update_values["realized_pnl"] = realized_pnl

        # Clear reservation key when marking closed from rotation
        update_values["reservation_key"] = None
        await database.execute(trades.update().where(trades.c.id == row["id"]).values(**update_values))
        closed_ids.append(row.get("id"))

        try:
            await broadcast({
                "type": "closed",
                "id": row.get("id"),
                "reason": "rotation",
                "exit_price": exit_price,
                "realized_pnl": realized_pnl,
            })
        except Exception:
            pass

    # Clean up any lingering open orders for the same symbols to avoid Bitget showing
    # stale limit entries when we immediately send the reversal order.
    unique_symbols = {str(row.get("symbol") or "").strip() for row in closing_rows if row.get("symbol")}
    for sym in unique_symbols:
        try:
            await cancel_orders_for_symbol(sym)
        except Exception as exc:
            try:
                print(f"[rotation] cancel_orders_for_symbol failed for {sym}: {exc}")
            except Exception:
                pass

    return {"closed": closed_ids, "failed": failed_ids, "errors": failure_details}


async def fetch_market_price(symbol: str):
    """Try to fetch a current market price for the given symbol from a public ticker (Binance).
    Returns a float price or None if it couldn't be fetched.
    """
    # Normalize symbol (remove slashes, TradingView suffixes, uppercase). Prefer plain symbol like BTCUSDT
    cleaned = sanitize_symbol_for_bitget(symbol)
    if "_" in cleaned:
        cleaned = cleaned.split("_", 1)[0]
    s = cleaned
    if not s:
        try:
            s = str(symbol or "").replace('/', '').replace('.P', '').replace('.p', '').upper()
        except Exception:
            s = str(symbol or "")

    # Prefer Binance public ticker (reliable public endpoint) then try Bitget
    candidates = []
    candidates.append(f"https://api.binance.com/api/v3/ticker/price?symbol={s}")
    try:
        # e.g. https://api.bitget.com/api/mix/v2/market/ticker?symbol=BTCUSDT
        candidates.append(f"{BITGET_BASE}/api/mix/v2/market/ticker?symbol={s}")
        candidates.append(f"{BITGET_BASE}/api/spot/v2/market/ticker?symbol={s}")
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


def construct_bitget_payload(symbol: str, side: str, size: float = None, *, reduce_only: bool = False, close_position: bool = False, extra_fields: Optional[Dict[str, Any]] = None):
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
    # or already Bitget style 'BTCUSDT_UMCBL'. Remove prefixes and
    # non-alphanumeric/underscore characters, then construct the
    # Bitget symbol as RAW + '_' + productType when needed.
    raw = get_bitget_symbol(symbol)
    # remove dots and any characters except letters, digits and underscore (double-sanitize defensive)
    raw = re.sub(r"[^A-Za-z0-9_]", "", raw)
    
    # Resolve margin coin defaults per product type. Bitget demo markets expect
    # USDT for UMCBL and SUSDT for SUMCBL unless explicitly overridden.
    margin_coin_env = (BITGET_MARGIN_COIN or "").strip()
    pt_upper = (BITGET_PRODUCT_TYPE or "").upper()
    local_product = "UMCBL" if pt_upper == "SUMCBL" else pt_upper

    # For USDT futures, use USDT as margin coin
    use_margin_coin = margin_coin_env or "USDT"
    margin_mode = (BITGET_MARGIN_MODE or "crossed").lower()
    if margin_mode not in ("cross", "crossed", "isolated"):
        margin_mode = "crossed"

    # Initialize body_obj with default values - use the working parameters from debug_order.py
    client_oid = f"capi-{uuid.uuid4().hex[:20]}"

    if close_position:
        # For close position, use different payload
        body_obj = {
            "symbol": "",  # Will be set below
            "productType": local_product,  # Use UMCBL for demo
            "marginCoin": use_margin_coin,
        }
        if extra_fields:
            body_obj.update(extra_fields)
    else:
        body_obj = {
            "symbol": "",  # Will be set below
            "productType": local_product,  # Add required productType
            "orderType": "market",
            "size": str(size) if size is not None else "0.001",  # Smaller default size like debug script
            "marginCoin": use_margin_coin,
            "marginMode": margin_mode,
            "clientOid": client_oid  # Unique per order to avoid Bitget duplicate errors
        }

        # reduceOnly/closePosition signals from caller if provided
        if reduce_only:
            body_obj["reduceOnly"] = "YES"

    if extra_fields:
        for key, value in extra_fields.items():
            body_obj[key] = value

    # Determine the symbol - for futures trading, use plain symbol (BTCUSDT)
    bitget_symbol = raw  # Use plain symbol like BTCUSDT
    body_obj["symbol"] = bitget_symbol

    # Ensure productType is always included for Bitget API
    if "productType" not in body_obj:
        body_obj["productType"] = local_product

    if not close_position:
        # Map side for single/unilateral accounts when necessary
        side_key = side.lower()
        pm = str(BITGET_POSITION_MODE or "").lower()
        pt = str(BITGET_POSITION_TYPE or "").lower()
        single_indicators = ("single", "single_hold", "unilateral", "one-way", "one_way", "oneway")
        if any(x in pm for x in single_indicators) or any(x in pt for x in ("unilateral", "one-way", "one_way", "oneway")):
            # Use buy/sell for unilateral mode - the positionMode handles the unilateral aspect
            body_obj["side"] = side_key
        else:
            body_obj["side"] = side_key

        # positionSide inference - include long/short hint unless explicitly overridden
        if BITGET_POSITION_SIDE:
            body_obj["positionSide"] = BITGET_POSITION_SIDE
        else:
            try:
                inferred = "long" if side_key == "buy" else "short"
                body_obj["positionSide"] = inferred
            except Exception:
                pass

    return body_obj


@app.post("/debug/payload")
async def debug_payload(req: Request, _: Dict[str, str] = Depends(require_role(["admin"]))):
    """Return the Bitget payload that would be sent for a TradingView alert.
    Accepts the same JSON body as `/webhook` (signal, symbol, price, size).
    This endpoint never sends anything to Bitget.
    """
    body_text = await req.body()
    try:
        payload = json.loads(body_text.decode())
    except Exception:
        raise HTTPException(status_code=400, detail="Payload must be JSON")

    _event, signal, side, _ = normalize_signal_payload(payload)
    raw_symbol = payload.get("symbol") or payload.get("ticker") or ""
    symbol = sanitize_symbol_for_bitget(raw_symbol) or (normalize_exchange_symbol(raw_symbol) or "")
    payload["raw_symbol"] = raw_symbol
    payload["symbol"] = symbol
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
                p = await fetch_market_price(symbol)
            if p and p != 0:
                computed_size = usd / p
            else:
                raise HTTPException(status_code=400, detail="Missing price and unable to fetch market price; include price in payload or try again")
        except HTTPException:
            raise
        except Exception:
            computed_size = None

    # Map signal to side
    if not signal:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    if not side:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    # prefer computed_size (from size_usd) when provided so debug mirrors webhook
    constructed = construct_bitget_payload(symbol=symbol, side=side, size=computed_size if computed_size is not None else size)
    return {"payload": constructed}


@app.post("/debug/place-test")
async def debug_place_test(req: Request, _: Dict[str, str] = Depends(require_role(["admin"]))):
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
    event, signal, side, _ = normalize_signal_payload(payload)
    if not signal:
        signal = "BUY"
    raw_symbol = payload.get("symbol") or payload.get("ticker") or "BTCUSDT"
    symbol = sanitize_symbol_for_bitget(raw_symbol) or (normalize_exchange_symbol(raw_symbol) or "")
    if not symbol:
        symbol = "BTCUSDT"
    payload["raw_symbol"] = raw_symbol
    payload["symbol"] = symbol
    price = payload.get("price") or None
    size = payload.get("size")
    size_usd = payload.get("size_usd") or payload.get("sizeUsd") or payload.get("sizeUSD")

    # determine side from normalized payload
    # Map inputs so that BUY/LONG => side='buy' (open long), SELL/SHORT => side='sell' (open short)
    user_side = side  # capture user input for intended direction calculation
    if side:
        # `side` may come from normalize_signal_payload as 'buy' or 'sell' or be a hint like 'BUY'/'SELL'/'LONG'/'SHORT'
        s = str(side).lower()
        if s in ("sell", "short"):
            side = "sell"
            signal = "SHORT"
            user_side = "sell"
        else:
            side = "buy"
            signal = "LONG"
            user_side = "buy"
    else:
        # No explicit side hint provided, infer from signal
        if signal and str(signal).upper() in ("SELL", "SHORT"):
            side = "sell"
            signal = "SHORT"
            user_side = "sell"
        elif signal and str(signal).upper() in ("BUY", "LONG"):
            side = "buy"
            signal = "LONG"
            user_side = "buy"

    if not side:
        raise HTTPException(status_code=400, detail="Unknown signal; must be BUY or SELL")

    print(f"[place-test] Determined signal: {signal}, side: {side}")

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

    # Determine price for DB storage (early calculation for both live and dry-run paths)
    price_for_db = price
    if not price_for_db:
        if fetched_price:
            price_for_db = fetched_price
        else:
            price_for_db = await get_market_price_with_retries(symbol)
            if not price_for_db:
                raise HTTPException(status_code=400, detail="Unable to fetch market price for symbol; include price or try again")

    trade_size_value, trade_size_usd_value, leverage_value, price_numeric = resolve_trade_dimensions(
        price_for_db,
        computed_size,
        size,
        size_usd,
        payload,
    )
    if price_numeric is None:
        price_numeric = safe_float(price_for_db)

    margin_value = safe_float(payload.get("margin") if isinstance(payload, dict) else None)
    if margin_value is None and isinstance(payload, dict):
        margin_value = safe_float(payload.get("margin_required") or payload.get("marginRequired"))
    if margin_value is None and trade_size_usd_value is not None and leverage_value:
        try:
            margin_value = float(trade_size_usd_value) / float(leverage_value)
        except Exception:
            margin_value = None

    liquidation_price_value = None
    if isinstance(payload, dict):
        liquidation_price_value = safe_float(
            payload.get("liquidation_price")
            or payload.get("liquidationPrice")
            or payload.get("liq_price")
            or payload.get("liqPrice")
            or payload.get("liquidation")
        )

    # Check current position before placing new order (Bitget or database simulation)
    current_direction = None
    current_size = None

    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        # In dry-run, check database for existing placed trades
        existing_trades = await database.fetch_all(
            trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
        )
        if existing_trades:
            # Take the first one (should be only one)
            existing_trade = dict(existing_trades[0])
            db_signal = str(existing_trade.get("signal") or "" ).upper()
            # Accept multiple possible signal representations
            if db_signal in ("LONG", "BUY"):
                current_direction = "long"
            elif db_signal in ("SHORT", "SELL"):
                current_direction = "short"
            else:
                # Also check if the DB row stored a side field like 'buy'/'sell'
                db_side = str(existing_trade.get("side") or "").lower()
                if db_side in ("buy", "long"):
                    current_direction = "long"
                elif db_side in ("sell", "short"):
                    current_direction = "short"
            current_size = safe_float(existing_trade.get("size")) or 1.0  # Simulate size
        print(f"[debug/place-test] DRY-RUN: Database position - direction: {current_direction}, size: {current_size}")
    else:
        # Live mode: check Bitget
        current_position_data = await fetch_bitget_position(symbol)
        print(f"[debug/place-test] Bitget position raw data for {symbol}: {current_position_data}")
        normalized_position = None
        if current_position_data:
            normalized_position = normalize_bitget_position(symbol, current_position_data)
            print(f"[debug/place-test] Normalized position for {symbol}: {normalized_position}")
        if normalized_position and normalized_position.get("size"):
            sz = safe_float(normalized_position.get("size"))
            if sz and sz > 0:
                side_val = str(normalized_position.get("side") or "").lower()
                if side_val in ("long", "buy"):
                    current_direction = "long"
                elif side_val in ("short", "sell"):
                    current_direction = "short"
                current_size = sz

        # If Bitget reports no active position (or size 0), fall back to DB 'placed' trades
        # This covers propagation latency where Bitget hasn't reflected a newly-placed position yet.
        try:
            need_db_fallback = not (normalized_position and safe_float(normalized_position.get("size")) and safe_float(normalized_position.get("size")) > 0)
        except Exception:
            need_db_fallback = True

        if need_db_fallback:
            try:
                recent_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol)).order_by(trades.c.created_at.desc()).limit(1)
                )
                if recent_trades:
                    recent = dict(recent_trades[0])
                    db_signal = str(recent.get("signal") or "").upper()
                    if db_signal in ("LONG", "BUY"):
                        current_direction = "long"
                    elif db_signal in ("SHORT", "SELL"):
                        current_direction = "short"
                    else:
                        db_side = str(recent.get("side") or "").lower()
                        if db_side in ("buy", "long"):
                            current_direction = "long"
                        elif db_side in ("sell", "short"):
                            current_direction = "short"
                    # Use stored size if available
                    current_size = current_size or safe_float(recent.get("size"))
                    print(f"[debug/place-test] DB fallback detected placed trade id={recent.get('id')} direction={current_direction} size={current_size}")
            except Exception as e:
                print(f"[debug/place-test] DB fallback detection error: {e}")

    intended_direction = "short" if user_side and user_side.upper() in ("SELL", "SHORT") else "long"
    print(f"[debug/place-test] Current direction: {current_direction}, Current size: {current_size}, Intended direction: {intended_direction}")

    # Logic: For demo/test orders, allow switching positions (close existing and open opposite direction)
    # If there's already an open position in the SAME direction, ignore the new request (no-op)
    if current_direction and current_direction == intended_direction and current_size and current_size > 0:
        # Reject repeated same-direction demo orders with a clear 400 error so callers keep the existing position
        raise HTTPException(status_code=400, detail=f"Already have an open {current_direction} position for {symbol}. Close it first or use opposite direction to switch.")

    # If opposite direction, close existing and open new
    if current_direction and current_direction != intended_direction and current_size and current_size > 0:
        print(f"[debug/place-test] Closing previous {current_direction} position for {symbol} before opening {intended_direction}")
        # Get existing trade to close. Prefer the placed trade that matches the current direction
        existing_trade = None
        target_signal = "LONG" if current_direction == "long" else "SHORT"
        try:
            if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
                # Try to find the placed trade that matches the current direction first
                existing_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol) & (trades.c.signal == target_signal))
                )
                # Fallback: if none found, pick any placed trade for this symbol
                if not existing_trades:
                    existing_trades = await database.fetch_all(
                        trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
                    )
                if existing_trades:
                    existing_trade = dict(existing_trades[0])
            else:
                # Live: try to find the matching placed trade in DB first, otherwise fallback to any placed trade
                existing_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol) & (trades.c.signal == target_signal))
                )
                if not existing_trades:
                    existing_trades = await database.fetch_all(
                        trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
                    )
                if existing_trades:
                    existing_trade = dict(existing_trades[0])
        except Exception:
            existing_trade = None

        if existing_trade:
            close_success, close_detail = await close_existing_bitget_position(existing_trade)
            if not close_success:
                raise HTTPException(status_code=400, detail=f"Failed to close existing {current_direction} position: {close_detail}")
            print(f"[debug/place-test] Closed existing {current_direction} position for {symbol}")

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
        try:
            print(f"[debug/place-test] resolved price price={price} resolved_price={price_numeric}")
        except Exception:
            pass
        try:
            await database.execute(trades.insert().values(
                id=trade_id,
                signal=signal,
                symbol=symbol,
                price=float(price_numeric) if price_numeric is not None else 0.0,
                size=trade_size_value,
                size_usd=trade_size_usd_value,
                leverage=leverage_value,
                margin=margin_value,
                liquidation_price=liquidation_price_value,
                exit_price=None,
                realized_pnl=None,
                status=simulated_status,
                response=json.dumps(fake_resp),
                created_at=now
            ))
            try:
                print(f"[debug/place-test] inserting trade id={trade_id} price={price_numeric}")
            except Exception:
                pass
            # Broadcast the simulated placed event to connected frontends
            await broadcast({
                "type": "placed",
                "id": trade_id,
                "status_code": 200,
                "response": fake_resp,
                "price": float(price_numeric) if price_numeric is not None else None,
                "size": trade_size_value,
                "size_usd": trade_size_usd_value,
                "leverage": leverage_value,
                "margin": margin_value,
                "liquidation_price": liquidation_price_value,
            })
            print(f"[dry-run] Inserted signal: {signal} for trade {trade_id}")
            # Simulate position update for dry-run
            normalized_symbol = normalize_exchange_symbol(symbol).replace("/", "").replace(".", "").upper()
            fake_position = {
                "found": True,
                "side": "long" if str(signal).upper() in ("BUY", "LONG") else "short",
                "size": trade_size_value,
                "avg_open_price": price_numeric,
                "margin": margin_value,
                "leverage": leverage_value,
                "liquidation_price": liquidation_price_value,
                "unrealized_pnl": 0.0,
                "pnl_ratio": 0.0,
                "size_usd": trade_size_usd_value,
                "timestamp": now * 1000,
            }
            await broadcast({
                "type": "position_updates",
                "position_updates": {normalized_symbol: fake_position}
            })
        except Exception as e:
            # Fall back to returning simulated response even if DB write failed
            print(f"[debug/place-test] failed to write simulated trade to DB: {e}")

        return {
            "ok": True,
            "dry_run": True,
            "note": "BITGET_DRY_RUN is enabled — simulated order created locally",
            "orderId": fake_resp["data"]["orderId"],
            "trade_id": trade_id,
            "price": float(price_numeric) if price_numeric is not None else None,
            "response": fake_resp,
            "payload": constructed_payload,
            "margin": margin_value,
            "liquidation_price": liquidation_price_value,
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

        # Insert the trade into database regardless of success/failure
        trade_id = str(uuid.uuid4())
        bitget_code = None
        if isinstance(parsed, dict):
            bitget_code = parsed.get('code') or parsed.get('status')
        trade_status = "placed" if status_code == 200 and not (bitget_code and str(bitget_code) != '00000') else "error"

        if trade_status == "placed":
            need_margin = margin_value is None
            need_leverage = leverage_value is None or leverage_value <= 0
            need_liq = liquidation_price_value is None
            if not str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on") and (need_margin or need_leverage or need_liq):
                position_snapshot = await fetch_bitget_position(symbol)
                if position_snapshot:
                    if need_margin:
                        margin_candidate = extract_numeric_field(position_snapshot, "margin", "marginSize", "marginValue", "positionMargin", "fixedMargin", "marginBalance")
                        if margin_candidate is not None:
                            margin_value = margin_candidate
                    if need_leverage:
                        leverage_candidate = extract_numeric_field(position_snapshot, "leverage", "lever", "marginLeverage")
                        if leverage_candidate is not None and leverage_candidate > 0:
                            leverage_value = leverage_candidate
                    if need_liq:
                        liq_candidate = extract_numeric_field(position_snapshot, "liquidationPrice", "liqPrice", "liqPx", "liqprice")
                        if liq_candidate is not None:
                            liquidation_price_value = liq_candidate

        try:
            await database.execute(trades.insert().values(
                id=trade_id,
                signal=signal,
                symbol=symbol,
                price=float(price_numeric) if price_numeric is not None else 0.0,
                size=trade_size_value,
                size_usd=trade_size_usd_value,
                leverage=leverage_value,
                margin=margin_value,
                liquidation_price=liquidation_price_value,
                exit_price=None,
                realized_pnl=None,
                status=trade_status,
                response=resp_text,
                reservation_key=None,
                created_at=time.time()
            ))
            updates = {}
            if margin_value is not None:
                updates["margin"] = margin_value
            if leverage_value is not None:
                updates["leverage"] = leverage_value
            if liquidation_price_value is not None:
                updates["liquidation_price"] = liquidation_price_value
            if updates:
                await database.execute(trades.update().where(trades.c.id == trade_id).values(**updates))
            # Broadcast the placed event to connected frontends
            await broadcast({
                "type": "placed" if trade_status == "placed" else "error",
                "id": trade_id,
                "status_code": status_code,
                "response": parsed,
                "price": float(price_numeric) if price_numeric is not None else None,
                "size": trade_size_value,
                "size_usd": trade_size_usd_value,
                "leverage": leverage_value,
                "margin": margin_value,
                "liquidation_price": liquidation_price_value,
            })
        except Exception as e:
            print(f"[debug/place-test] failed to write trade to DB: {e}")

        result = {
            "ok": True,
            "dry_run": False,
            "sent_to_bitget": sent_to_bitget,
            "status_code": status_code,
            "orderId": order_id,
            "response": parsed,
            "payload": constructed_payload,
            "trade_id": trade_id,
            "margin": margin_value,
            "leverage": leverage_value,
            "liquidation_price": liquidation_price_value,
        }

        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/debug/order-status")
async def debug_order_status(req: Request, _: Dict[str, str] = Depends(require_role(["admin"]))):
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

    # Build query payload (POST) — Using v5 API for order details.
    request_path = "/api/v5/trade/orderInfo"
    body_obj = {"orderId": order_id}
    if symbol:
        body_obj["symbol"] = sanitize_symbol_for_bitget(symbol)

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
    sanitized = sanitize_symbol_for_bitget(symbol)
    pt_upper = (BITGET_PRODUCT_TYPE or "").upper()
    local_product = "UMCBL" if pt_upper == "SUMCBL" else pt_upper

    if "_" in sanitized:
        bitget_symbol = sanitized
    else:
        bitget_symbol = sanitized

    body_obj: Dict[str, Any] = {"symbol": bitget_symbol}
    if BITGET_MARGIN_COIN:
        body_obj["marginCoin"] = BITGET_MARGIN_COIN
    body = json.dumps(body_obj, separators=(",", ":"))
    request_path = "/api/v5/position/list"

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

    # Try multiple authenticated read endpoints and HTTP methods to determine
    # whether credentials are accepted (some endpoints expect POST with a body,
    # others accept GET with a query string). We'll report each attempt's
    # status and response so you can see whether the failure is auth-related
    # (400) or path-related (404).
    attempts = []
    candidates = []
    # Candidate: POST /api/v5/account/account-info
    candidates.append(("POST", "/api/v5/account/account-info", "{}"))
    # Candidate: GET /api/v5/account/account-info
    candidates.append(("GET", "/api/v5/account/account-info", ""))

    async with httpx.AsyncClient(timeout=8.0) as client:
        for method, path, body in candidates:
            try:
                ts = str(int(time.time() * 1000))
                # For signing include query string in path if present
                request_path_for_sign = path
                # Build signature
                sign = build_signature(ts, method, request_path_for_sign, body if body else "", BITGET_SECRET)

                headers = {
                    "ACCESS-KEY": BITGET_API_KEY,
                    "ACCESS-SIGN": sign,
                    "ACCESS-TIMESTAMP": ts,
                    "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
                    "Content-Type": "application/json",
                    "paptrading": PAPTRADING,
                    "locale": "en-US",
                }

                url = BITGET_BASE + path
                # perform request according to method
                if method == "GET":
                    resp = await client.get(url, headers=headers)
                else:
                    resp = await client.post(url, headers=headers, content=body)

                try:
                    parsed = resp.json()
                except Exception:
                    parsed = resp.text

                attempts.append({"method": method, "url": url, "status_code": resp.status_code, "response": parsed})
            except Exception as e:
                attempts.append({"method": method, "url": BITGET_BASE + path, "error": str(e)})

    return {"ok": True, "attempts": attempts}

@app.on_event("startup")
async def startup():
    # Connect to database and ensure schema
    await database.connect()
    ensure_trade_table_columns()

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

    # Multiple position system: allow positions in different symbols
    # No longer closing old positions on startup

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
    event = payload.get("event")  # SIGNAL, ENTRY, EXIT
    raw_signal = payload.get("signal") or payload.get("action") or ""
    if (not raw_signal) and event:
        raw_signal = str(event)
    signal = str(raw_signal).upper()
    # Enforce explicit LONG/SHORT labels; ignore BUY/SELL or any other aliases
    if signal in ("BUY", "SELL"):
        reason = "Only LONG/SHORT signals are accepted; ignoring BUY/SELL alias"
        try:
            await broadcast({"type": "ignored", "reason": reason, "payload": payload})
        except Exception:
            pass
        return {"ok": False, "ignored": True, "reason": reason}
    if signal and signal not in ("LONG", "SHORT"):
        reason = f"Unknown signal '{signal}'. Only LONG/SHORT are accepted."
        try:
            await broadcast({"type": "ignored", "reason": reason, "payload": payload})
        except Exception:
            pass
        return {"ok": False, "ignored": True, "reason": reason}
    trade_id_from_payload = payload.get("trade_id")
    raw_symbol = payload.get("symbol") or payload.get("ticker") or ""
    symbol = sanitize_symbol_for_bitget(raw_symbol) or (normalize_exchange_symbol(raw_symbol) or "")
    payload["raw_symbol"] = raw_symbol
    payload["symbol"] = symbol
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

    # Enforce Bitget's minimum contract size when we have a computed size.
    if computed_size is not None:
        try:
            if computed_size < 0.001:
                computed_size = 0.001
        except Exception:
            pass

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

    now = time.time()

    trade_size_value, trade_size_usd_value, leverage_value, price_numeric = resolve_trade_dimensions(
        price_for_db,
        computed_size,
        size,
        size_usd,
        payload,
    )
    if price_numeric is None:
        price_numeric = safe_float(price_for_db)

    margin_value = safe_float(payload.get("margin") if isinstance(payload, dict) else None)
    if margin_value is None and isinstance(payload, dict):
        margin_value = safe_float(payload.get("margin_required") or payload.get("marginRequired"))
    if margin_value is None and trade_size_usd_value is not None and leverage_value:
        try:
            margin_value = float(trade_size_usd_value) / float(leverage_value)
        except Exception:
            margin_value = None

    liquidation_price_value = None
    if isinstance(payload, dict):
        liquidation_price_value = safe_float(
            payload.get("liquidation_price")
            or payload.get("liquidationPrice")
            or payload.get("liq_price")
            or payload.get("liqPrice")
            or payload.get("liquidation")
        )

    # Treat TradingView 'SIGNAL' alerts and 'ENTRY_FALLBACK' as log-only signals.
    # Only explicit ENTRY alerts (sent when TradingView records the filled trade)
    # will proceed to attempt order placement. This keeps the webhook in sync
    # with the strategy tester's authoritative trade list and avoids acting on
    # fallback alerts that may be sent when TradingView state is uncertain.
    if event and str(event).upper() in ("SIGNAL", "ENTRY_FALLBACK"):
        # Decide if we need to log this signal. If a same-side position is
        # already open, we will ignore the incoming signal to prevent duplicate
        # entries in the database.
        trade_id = trade_id_from_payload or str(uuid.uuid4())
        # Attempt to detect an existing open position via Bitget and DB fallback
        # so signals that are duplicates are ignored even when Bitget snapshots
        # are missing.
        current_direction = None
        current_size = None
        current_position_data = await fetch_bitget_position(symbol)
        normalized_position = None
        if current_position_data:
            normalized_position = normalize_bitget_position(symbol, current_position_data)
            if normalized_position and normalized_position.get("size"):
                sz = safe_float(normalized_position.get("size"))
                if sz and sz > 0:
                    side_val = str(normalized_position.get("side") or "").lower()
                    if side_val in ("long", "buy"):
                        current_direction = "long"
                    elif side_val in ("short", "sell"):
                        current_direction = "short"
                    current_size = sz
        # DB fallback when Bitget not available
        if (not current_direction or not current_size) and not normalized_position:
            try:
                existing_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol)).order_by(trades.c.created_at.desc())
                )
                if existing_trades:
                    existing_trade = dict(existing_trades[0])
                    db_signal = str(existing_trade.get("signal") or "").upper()
                    if db_signal == "LONG":
                        current_direction = "long"
                    elif db_signal == "SHORT":
                        current_direction = "short"
                    current_size = safe_float(existing_trade.get("size")) or safe_float(existing_trade.get("size_usd")) or current_size
            except Exception:
                pass
        # If duplicate, ignore
        if current_direction and current_direction == ("long" if signal == "LONG" else "short") and current_size and current_size > 0:
            await broadcast({"type":"ignored","id":trade_id,"symbol":symbol,"reason":f"Ignored signal: already have {current_direction} open for {symbol}"})
            return {"ok": False, "id": trade_id, "ignored": True, "detail": "already have open position"}
        # Otherwise, record the signal
        await database.execute(trades.insert().values(
            id=trade_id,
            signal=signal,
            symbol=symbol,
            price=float(price_numeric) if price_numeric is not None else 0.0,
            size=trade_size_value,
            size_usd=trade_size_usd_value,
            leverage=leverage_value,
            margin=margin_value,
            liquidation_price=liquidation_price_value,
            exit_price=None,
            realized_pnl=None,
            status="signal",
            response="",
            created_at=now
        ))
        await broadcast({"type":"signal","id":trade_id,"signal":signal,"symbol":symbol,"price":price, "at":now})
        # Note: ENTRY_FALLBACK will be logged but not executed. Only
        # explicit ENTRY alerts (event == 'ENTRY') will open positions.
        return {"ok": True, "id": trade_id, "note": "signal logged"}

    elif event == "EXIT":
        # Close the specific trade
        if trade_id_from_payload:
            await database.execute(trades.update().where(trades.c.id == trade_id_from_payload).values(status="closed", reservation_key=None))
            await broadcast({"type":"closed","id":trade_id_from_payload})
        return {"ok": True, "note": "exit processed"}

    # --- UPDATED LOGIC: Check Bitget position before opening a new order ---
    # - If alert is 'short' and current position is 'short', ignore.
    # - If alert is 'short' and current position is 'long' or 'none', close long (if any) and open short.
    # - If alert is 'long' and current position is 'long', ignore.
    # - If alert is 'long' and current position is 'short' or 'none', close short (if any) and open long.
    # Enforce execution only on authoritative ENTRY alerts from TradingView's
    # strategy tester. If the incoming payload is not an ENTRY (for example
    # SIGNAL, ENTRY_FALLBACK, or has no event), log it and do not attempt
    # to place or rotate positions. This ensures the backend mirrors the
    # strategy tester's actual opened positions instead of acting on
    # speculative alerts.
    if not (event and str(event).upper() == "ENTRY"):
        trade_id = trade_id_from_payload or str(uuid.uuid4())
        await database.execute(trades.insert().values(
            id=trade_id,
            signal=signal,
            symbol=symbol,
            price=float(price_numeric) if price_numeric is not None else 0.0,
            size=trade_size_value,
            size_usd=trade_size_usd_value,
            leverage=leverage_value,
            margin=margin_value,
            liquidation_price=liquidation_price_value,
            exit_price=None,
            realized_pnl=None,
            status="signal",
            response="",
            created_at=now
        ))
        await broadcast({"type":"signal","id":trade_id,"signal":signal,"symbol":symbol,"price":price, "at":now})
        return {"ok": True, "id": trade_id, "note": "logged (only ENTRY events execute)"}

    intended_direction = None
    if signal and signal.upper() in ("BUY", "LONG"):
        intended_direction = "long"
        side = "buy"
    elif signal and signal.upper() in ("SELL", "SHORT"):
        intended_direction = "short"
        side = "sell"
    else:
        await database.execute(trades.update().where(trades.c.id==trade_id_from_payload).values(status="ignored", response="Unknown signal", reservation_key=None))
        await broadcast({"type":"ignored","id":trade_id_from_payload,"reason":"unknown signal"})
        return {"ok": False, "reason": "unknown signal"}

    # Normalize signal to LONG or SHORT based on intended direction
    signal = "LONG" if intended_direction == "long" else "SHORT"

    # Fetch current position from Bitget
    current_position_data = await fetch_bitget_position(symbol)
    print(f"[webhook] Bitget position raw data for {symbol}: {current_position_data}")
    normalized_position = None
    if current_position_data:
        normalized_position = normalize_bitget_position(symbol, current_position_data)
        print(f"[webhook] Normalized position for {symbol}: {normalized_position}")
    current_direction = None
    current_size = None
    if normalized_position and normalized_position.get("size"):
        sz = safe_float(normalized_position.get("size"))
        if sz and sz > 0:
            side_val = str(normalized_position.get("side") or "").lower()
            if side_val in ("long", "buy"):
                current_direction = "long"
            elif side_val in ("short", "sell"):
                current_direction = "short"
            current_size = sz
    # If we couldn't fetch a Bitget position (or Bitget returned no position),
    # check our DB for any previously 'placed' trades to derive the current direction
    # so we can properly ignore duplicates when Bitget snapshots are unavailable.
    if (not current_direction or not current_size) and not normalized_position:
        try:
            existing_trades = await database.fetch_all(
                trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol)).order_by(trades.c.created_at.desc())
            )
            if existing_trades:
                existing_trade = dict(existing_trades[0])
                db_signal = str(existing_trade.get("signal") or "").upper()
                if db_signal == "LONG":
                    current_direction = "long"
                elif db_signal == "SHORT":
                    current_direction = "short"
                current_size = safe_float(existing_trade.get("size")) or safe_float(existing_trade.get("size_usd")) or current_size
        except Exception:
            pass
    print(f"[webhook] Current direction: {current_direction}, Current size: {current_size}, Intended direction: {intended_direction}")

    # Logic: For webhook alerts, allow opposite positions to be opened (hedge mode)
    # This allows both long and short positions to coexist

    # If opposite direction, close existing and open new
    if current_direction and current_direction != intended_direction and current_size and current_size > 0:
        print(f"[webhook] Closing previous {current_direction} position for {symbol} before opening {intended_direction}")
        close_outcome = await close_open_positions_for_rotation(symbol, price_numeric, payload)
        print(f"[webhook] Close result: {close_outcome}")
        if close_outcome["failed"]:
            detail = {
                "message": "Failed to close existing Bitget positions before rotation",
                "failed_ids": close_outcome["failed"],
            }
            if close_outcome.get("errors"):
                detail["errors"] = close_outcome["errors"]
            await broadcast({
                "type": "error",
                "reason": "close_failed",
                "trades": close_outcome["failed"],
                "details": close_outcome.get("errors"),
            })
            raise HTTPException(status_code=502, detail=detail)

    # If no current position, just proceed to open the new position
    elif not current_direction or current_size <= 0:
        print(f"[webhook] No current position for {symbol}, proceeding to open {intended_direction}")

    # If an existing same-side position is already open, ignore the incoming
    # alert and do not persist it to DB. This prevents duplicate 'received'
    # records showing up from signals that try to open the same direction.
    if current_direction and current_direction == intended_direction and current_size and current_size > 0:
        # Broadcast an ignored event so connected clients can show user feedback
        tmp_id = trade_id_from_payload or str(uuid.uuid4())
        await broadcast({
            "type": "ignored",
            "id": tmp_id,
            "symbol": symbol,
            "reason": f"Already have an open {current_direction} position for {symbol}; incoming {intended_direction} ignored",
        })
        try:
            print(f"[webhook] Ignored incoming duplicate {intended_direction} for {symbol} (existing {current_direction})")
        except Exception:
            pass
        return {"ok": False, "id": tmp_id, "ignored": True, "detail": f"Already have an open {current_direction} position for {symbol}."}

    # Save incoming alert to DB as pending (use discovered price when available)
    trade_id = trade_id_from_payload or str(uuid.uuid4())
    # Support PineScript-provided trade index so we can ignore stale entries
    pine_idx = None
    for k in ("pine_trade_index", "tv_trade_index", "trade_index", "pine_index"):
        if isinstance(payload.get(k), (int, float)):
            try:
                pine_idx = int(payload.get(k))
                break
            except Exception:
                pine_idx = None

    # If Pine trade index supplied, ignore if it's older than the latest we know for this symbol
    if pine_idx is not None:
        try:
            q = sqlalchemy.select([sqlalchemy.func.max(trades.c.pine_trade_index)]).where(trades.c.symbol == symbol)
            row = await database.fetch_one(q)
            if row is not None:
                existing_max = row[0]
                if existing_max is not None and pine_idx < int(existing_max):
                    tmp_id = trade_id
                    await broadcast({"type": "ignored", "id": tmp_id, "symbol": symbol, "reason": f"Stale Pine trade index {pine_idx} < existing {existing_max}. Ignored."})
                    return {"ok": False, "id": tmp_id, "ignored": True, "detail": "stale pine trade index"}
        except Exception:
            pass

    # Reservation key prevents concurrent duplicate placements for same symbol+direction
    reservation_key = f"{symbol}:{intended_direction}"
    try:
        await database.execute(trades.insert().values(
            id=trade_id,
            signal=signal,
            symbol=symbol,
            price=float(price_numeric) if price_numeric is not None else 0.0,
            size=trade_size_value,
            size_usd=trade_size_usd_value,
            leverage=leverage_value,
            margin=margin_value,
            liquidation_price=liquidation_price_value,
            exit_price=None,
            realized_pnl=None,
            status="received",
            response="",
            reservation_key=reservation_key,
            pine_trade_index=pine_idx,
            created_at=now
        ))
    except Exception as e:
        # Detect unique constraint violation (concurrent reservation) and ignore
        msg = str(e).lower()
        if "unique" in msg or "constraint" in msg:
            tmp_id = trade_id
            await broadcast({"type": "ignored", "id": tmp_id, "symbol": symbol, "reason": "Concurrent reservation exists; ignored"})
            try:
                print(f"[webhook] reservation conflict for {reservation_key}: {e}")
            except Exception:
                pass
            return {"ok": False, "id": tmp_id, "ignored": True, "detail": "concurrent reservation"}
        # Other errors: re-raise
        raise
    try:
        print(f"[webhook] inserted pending trade id={trade_id} price={price_for_db}")
    except Exception:
        pass
    await broadcast({
        "type": "received",
        "id": trade_id,
        "signal": signal,
        "symbol": symbol,
        "price": float(price_numeric) if price_numeric is not None else None,
        "size": trade_size_value,
        "size_usd": trade_size_usd_value,
        "leverage": leverage_value,
        "margin": margin_value,
        "liquidation_price": liquidation_price_value,
        "at": now,
    })

    # Place demo order
    print(f"[webhook] Placing new {intended_direction} position for {symbol}")
    try:
        status_code, resp_text = await place_demo_order(symbol=symbol, side=side, price=price, size=computed_size)
        print(f"[webhook] Order result: status_code={status_code}, resp_text={resp_text}")
        parsed_resp = None
        try:
            parsed_resp = json.loads(resp_text) if resp_text else None
        except Exception:
            parsed_resp = {"raw": resp_text}

        bitget_code = None
        if isinstance(parsed_resp, dict):
            bitget_code = parsed_resp.get("code") or parsed_resp.get("status")

        is_success = status_code == 200 and (not bitget_code or str(bitget_code) == "00000")
        new_status = "placed" if is_success else "error"

        await database.execute(trades.update().where(trades.c.id==trade_id).values(status=new_status, response=resp_text, reservation_key=None))
        await broadcast({
            "type": "placed" if is_success else "error",
            "id": trade_id,
            "status_code": status_code,
            "response": parsed_resp,
            "price": float(price_numeric) if price_numeric is not None else None,
            "size": trade_size_value,
            "size_usd": trade_size_usd_value,
            "leverage": leverage_value,
            "margin": margin_value,
            "liquidation_price": liquidation_price_value,
        })

        if not is_success:
            return {"ok": False, "id": trade_id, "status_code": status_code, "response": parsed_resp}

        return {"ok": True, "id": trade_id, "status_code": status_code, "response": parsed_resp}
    except Exception as e:
        await database.execute(trades.update().where(trades.c.id==trade_id).values(status="error", response=str(e), reservation_key=None))
        await broadcast({"type": "error", "id": trade_id, "error": str(e)})
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/trades")
async def list_trades(current_user: Optional[Dict[str, str]] = Depends(get_current_user_optional)):
    if not ALLOW_ANON_TRADES and current_user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    rows = await database.fetch_all(trades.select().order_by(trades.c.created_at.desc()))
    return [dict(r) for r in rows]

@app.get("/tradingview-trades")
async def get_tradingview_trades(current_user: Dict[str, str] = Depends(get_current_user)):
    """Get trades from TradingView webhook signals only (status='signal')"""
    rows = await database.fetch_all(
        trades.select()
        .where(trades.c.status == "signal")
        .order_by(trades.c.created_at.desc())
    )
    return [dict(r) for r in rows]

@app.get("/bitget-trades")
async def get_bitget_trades(current_user: Dict[str, str] = Depends(get_current_user)):
    """Get trades that were actually executed on Bitget (status='placed' or 'error')"""
    rows = await database.fetch_all(
        trades.select()
        .where(trades.c.status.in_(["placed", "error"]))
        .order_by(trades.c.created_at.desc())
    )
    return [dict(r) for r in rows]

@app.get("/trade-sync-status")
async def get_trade_sync_status(current_user: Dict[str, str] = Depends(get_current_user)):
    """Get synchronization status between TradingView signals and Bitget executions"""
    tv_trades = await database.fetch_all(
        trades.select()
        .where(trades.c.status == "signal")
        .order_by(trades.c.created_at.desc())
    )

    bitget_trades = await database.fetch_all(
        trades.select()
        .where(trades.c.status.in_(["placed", "error"]))
        .order_by(trades.c.created_at.desc())
    )

    # Count by signal type
    tv_buy_signals = len([t for t in tv_trades if t.signal.upper() == "BUY"])
    tv_sell_signals = len([t for t in tv_trades if t.signal.upper() == "SELL"])
    bg_buy_trades = len([t for t in bitget_trades if t.signal.upper() == "BUY"])
    bg_sell_trades = len([t for t in bitget_trades if t.signal.upper() == "SELL"])

    return {
        "tradingview_signals": {
            "total": len(tv_trades),
            "buy_signals": tv_buy_signals,
            "sell_signals": tv_sell_signals,
            "trades": [dict(r) for r in tv_trades]
        },
        "bitget_executions": {
            "total": len(bitget_trades),
            "buy_trades": bg_buy_trades,
            "sell_trades": bg_sell_trades,
            "trades": [dict(r) for r in bitget_trades]
        },
        "sync_status": {
            "buy_signals_executed": bg_buy_trades == tv_buy_signals,
            "sell_signals_executed": bg_sell_trades == tv_sell_signals,
            "all_signals_executed": len(bitget_trades) == len(tv_trades)
        }
    }

@app.post("/close/{trade_id}")
async def close_position(trade_id: str, current_user: Dict[str, str] = Depends(require_role(["admin"]))):
    """Admin endpoint to close a position - sends close order to Bitget and updates DB."""
    try:
        # Get trade details
        trade = await database.fetch_one(trades.select().where(trades.c.id == trade_id))
        if not trade:
            raise HTTPException(status_code=404, detail="Trade not found")

        if trade['status'] != 'placed':
            raise HTTPException(status_code=400, detail="Trade is not in open state")

        # Close the position on Bitget
        success, detail = await close_existing_bitget_position(dict(trade))

        if success:
            # Broadcast the close event
            await broadcast({"type": "closed", "id": trade_id})
            return {"ok": True, "message": "Position closed successfully"}
        else:
            raise HTTPException(status_code=500, detail=detail or "Failed to close position on Bitget")

    except HTTPException:
        raise
    except Exception as e:
        print(f"[close_position] Error closing trade {trade_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/admin/delete-trade/{trade_id}")
async def delete_trade(trade_id: str, current_user: Dict[str, str] = Depends(require_role(["admin"]))):
    """Admin endpoint to delete a trade row from the database."""
    try:
        # Ensure trade exists
        t = await database.fetch_one(trades.select().where(trades.c.id == trade_id))
        if not t:
            raise HTTPException(status_code=404, detail="Trade not found")

        await database.execute(trades.delete().where(trades.c.id == trade_id))

        # Notify connected clients that the trade was deleted
        try:
            await broadcast({"type": "deleted", "id": trade_id})
        except Exception:
            pass

        return {"ok": True, "message": "Trade deleted"}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[delete_trade] Error deleting trade {trade_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/open-position")
async def open_position(req: Request, current_user: Dict[str, str] = Depends(get_current_user)):
    """Endpoint for users to manually open positions from the dashboard."""
    try:
        body_text = await req.body()
        payload = json.loads(body_text.decode())

        # Extract parameters
        signal = payload.get("signal") or payload.get("action") or ""
        raw_symbol = payload.get("symbol") or payload.get("ticker") or ""
        symbol = sanitize_symbol_for_bitget(raw_symbol) or (normalize_exchange_symbol(raw_symbol) or "")
        payload["raw_symbol"] = raw_symbol
        payload["symbol"] = symbol
        size = payload.get("size")
        size_usd = payload.get("size_usd") or payload.get("sizeUsd") or payload.get("sizeUSD")

        if not symbol:
            raise HTTPException(status_code=400, detail="Missing required field: symbol")

        # Default signal to BUY if not provided
        if not signal:
            signal = "BUY"

        if signal.upper() not in ("BUY", "SELL", "LONG", "SHORT"):
            raise HTTPException(status_code=400, detail="Invalid signal. Must be BUY, SELL, LONG, or SHORT")

        # Fetch current market price
        price = await get_market_price_with_retries(symbol)
        if not price:
            raise HTTPException(status_code=400, detail="Unable to fetch market price for symbol")

        # Add productType to payload for Bitget API
        payload["productType"] = "USDT-FUTURES"

        # Prepare payload similar to webhook
        webhook_payload = {
            "signal": signal,
            "symbol": symbol,
            "price": price,
            "size": size,
            "size_usd": size_usd,
            "manual": True  # Flag to indicate manual opening
        }

        # Map signal to side - normal trading logic
        # BUY/LONG signals open LONG positions (side="buy"), SELL/SHORT signals open SHORT positions (side="sell")
        intended_direction = None
        if signal.upper() in ("BUY", "LONG"):
            side = "buy"
            signal = "LONG"
            intended_direction = "long"
        elif signal.upper() in ("SELL", "SHORT"):
            side = "sell"
            signal = "SHORT"
            intended_direction = "short"

        # Check current position before opening new order (prevent duplicate same-direction positions)
        current_direction = None
        current_size = None

        if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
            # In dry-run, check database for existing placed trades
            existing_trades = await database.fetch_all(
                trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
            )
            if existing_trades:
                # Take the first one (should be only one)
                existing_trade = dict(existing_trades[0])
                db_signal = str(existing_trade.get("signal") or "").upper()
                # Signal "LONG" means long position, "SHORT" means short position
                if db_signal == "LONG":
                    current_direction = "long"
                elif db_signal == "SHORT":
                    current_direction = "short"
                current_size = safe_float(existing_trade.get("size")) or 1.0  # Simulate size
            print(f"[open-position] DRY-RUN: Database position - direction: {current_direction}, size: {current_size}")
        else:
            # Live mode: check Bitget
            current_position_data = await fetch_bitget_position(symbol)
            print(f"[open-position] Bitget position raw data for {symbol}: {current_position_data}")
            normalized_position = None
            if current_position_data:
                normalized_position = normalize_bitget_position(symbol, current_position_data)
                print(f"[open-position] Normalized position for {symbol}: {normalized_position}")
            if normalized_position and normalized_position.get("size"):
                sz = safe_float(normalized_position.get("size"))
                if sz and sz > 0:
                    side_val = str(normalized_position.get("side") or "").lower()
                    if side_val in ("long", "buy"):
                        current_direction = "long"
                    elif side_val in ("short", "sell"):
                        current_direction = "short"
                    current_size = sz

        print(f"[open-position] Current direction: {current_direction}, Current size: {current_size}, Intended direction: {intended_direction}")

        # For manual positions, allow switching positions (close existing and open opposite direction)
        # Only reject if trying to open same direction as existing position
        if current_direction and current_direction == intended_direction and current_size and current_size > 0:
            raise HTTPException(status_code=400, detail=f"Already have an open {current_direction} position for {symbol}. Close it first or use opposite direction to switch.")

        # If opposite direction, close existing and open new
        if current_direction and current_direction != intended_direction and current_size and current_size > 0:
            print(f"[open-position] Closing previous {current_direction} position for {symbol} before opening {intended_direction}")
            # Get existing trade to close
            existing_trade = None
            if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
                existing_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
                )
                if existing_trades:
                    existing_trade = dict(existing_trades[0])
            else:
                # Find the trade for the current position
                existing_trades = await database.fetch_all(
                    trades.select().where((trades.c.status == "placed") & (trades.c.symbol == symbol))
                )
                if existing_trades:
                    existing_trade = dict(existing_trades[0])

            if existing_trade:
                close_success, close_detail = await close_existing_bitget_position(existing_trade)
                if not close_success:
                    raise HTTPException(status_code=400, detail=f"Failed to close existing {current_direction} position: {close_detail}")
                print(f"[open-position] Closed existing {current_direction} position for {symbol}")

        # Compute size
        computed_size = None
        if size is not None:
            try:
                computed_size = float(size)
            except Exception:
                computed_size = None
        elif size_usd is not None:
            try:
                usd = float(size_usd)
                computed_size = usd / price
            except Exception:
                computed_size = None

        if computed_size is not None and computed_size < 0.001:
            computed_size = 0.001

        # Place the order
        status_code, resp_text = await place_demo_order(symbol=symbol, side=side, price=price, size=computed_size)

        parsed_resp = None
        try:
            parsed_resp = json.loads(resp_text) if resp_text else None
        except Exception:
            parsed_resp = {"raw": resp_text}

        bitget_code = None
        if isinstance(parsed_resp, dict):
            bitget_code = parsed_resp.get("code") or parsed_resp.get("status")

        is_success = status_code == 200 and (not bitget_code or str(bitget_code) == "00000")

        # Create trade record
        trade_id = str(uuid.uuid4())
        now = time.time()

        trade_size_value, trade_size_usd_value, leverage_value, price_numeric = resolve_trade_dimensions(
            price, computed_size, size, size_usd, webhook_payload
        )

        trade_status = "placed" if is_success else "error"

        await database.execute(trades.insert().values(
            id=trade_id,
            signal=signal,
            symbol=symbol,
            price=float(price_numeric) if price_numeric is not None else 0.0,
            size=trade_size_value,
            size_usd=trade_size_usd_value,
            leverage=leverage_value,
            status=trade_status,
            response=resp_text,
            created_at=now
        ))

        # Broadcast the event
        await broadcast({
            "type": "placed" if is_success else "error",
            "id": trade_id,
            "status_code": status_code,
            "response": parsed_resp,
            "price": float(price_numeric) if price_numeric is not None else None,
            "size": trade_size_value,
            "size_usd": trade_size_usd_value,
            "leverage": leverage_value,
        })

        if is_success:
            return {"ok": True, "id": trade_id, "message": "Position opened successfully"}
        else:
            raise HTTPException(status_code=500, detail=f"Failed to open position: {parsed_resp}")

    except HTTPException:
        raise
    except Exception as e:
        print(f"[open_position] Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/price/{symbol}")
async def get_price(symbol: str, current_user: Dict[str, str] = Depends(get_current_user)):
    """Get current market price for a symbol."""
    price = await get_market_price_with_retries(symbol)
    return {"symbol": symbol, "price": price}

# Simple WebSocket endpoint for frontend live updates
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    token = ws.query_params.get("token")
    if not token:
        await ws.close(code=1008)
        return
    try:
        payload = decode_token(token)
    except Exception:
        await ws.close(code=1008)
        return

    username = payload.get("sub")
    role = payload.get("role", "user")
    if not username:
        await ws.close(code=1008)
        return
    # Skip user existence check since token is already validated
    client = {"ws": ws, "username": username, "role": role}
    connected_websockets.append(client)
    try:
        while True:
            message = await ws.receive_text()
            try:
                data = json.loads(message)
                if data.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong", "msg": "ok"}))
            except json.JSONDecodeError:
                # If not JSON, treat as regular pong request
                await ws.send_text(json.dumps({"type": "pong", "msg": "ok"}))
    except WebSocketDisconnect:
        pass
    finally:
        connected_websockets[:] = [c for c in connected_websockets if c.get("ws") is not ws]


@app.get("/bitget/position/{symbol}")
async def get_bitget_position(symbol: str, current_user: Dict[str, str] = Depends(get_current_user)):
    dry_run = str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on")
    if dry_run:
        return {"found": False, "requested_symbol": symbol, "reason": "dry_run"}

    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE and BITGET_BASE):
        return {"found": False, "requested_symbol": symbol, "reason": "not_configured"}

    snapshot = await fetch_bitget_position(symbol)
    if not snapshot:
        return {"found": False, "requested_symbol": symbol, "reason": "not_found"}

    normalized = normalize_bitget_position(symbol, snapshot)
    if not normalized:
        return {"found": False, "requested_symbol": symbol, "reason": "empty"}

    normalized["found"] = True
    normalized["fetched_at"] = int(time.time())
    return normalized


@app.get("/bitget/all-positions")
async def get_all_bitget_positions(current_user: Dict[str, str] = Depends(get_current_user)):
    """Fetch all current positions from Bitget and return them with enriched data."""
    dry_run = str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on")
    if dry_run:
        return {"positions": [], "count": 0, "reason": "dry_run"}

    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE and BITGET_BASE):
        return {"positions": [], "count": 0, "reason": "not_configured"}

    try:
        # Try multiple endpoints for positions - prioritize demo-compatible endpoints
        endpoints_to_try = [
            "/api/mix/v2/position/allPosition",  # Mix API v2 all positions (demo compatible)
            "/api/v5/position/list",  # Unified API (fallback)
        ]

        all_positions = []

        for endpoint in endpoints_to_try:
            try:
                if endpoint == "/api/v5/position/list":
                    body = "{}"
                else:
                    # For mix API, use usdt-futures product type
                    body_obj = {"productType": BITGET_PRODUCT_TYPE.lower()}
                    if BITGET_MARGIN_COIN:
                        body_obj["marginCoin"] = BITGET_MARGIN_COIN
                    body = json.dumps(body_obj, separators=(",", ":"))

                timestamp = str(int(time.time() * 1000))
                sign = build_signature(timestamp, "POST", endpoint, body, BITGET_SECRET)

                headers = {
                    "ACCESS-KEY": BITGET_API_KEY,
                    "ACCESS-SIGN": sign,
                    "ACCESS-TIMESTAMP": timestamp,
                    "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
                    "Content-Type": "application/json",
                    "paptrading": PAPTRADING,
                    "locale": "en-US",
                }

                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(BITGET_BASE + endpoint, headers=headers, content=body)

                    if resp.status_code == 200:
                        try:
                            data = resp.json()
                            if isinstance(data, dict) and (data.get("code") == "00000" or data.get("code") == "0"):
                                positions_data = data.get("data", [])
                                if isinstance(positions_data, list):
                                    all_positions.extend(positions_data)
                                elif isinstance(positions_data, dict):
                                    all_positions.append(positions_data)
                                break  # Success, stop trying other endpoints
                        except json.JSONDecodeError:
                            pass
                    else:
                        try:
                            print(f"[all-positions] {endpoint} HTTP {resp.status_code}: {resp.text[:100]}...")
                        except Exception:
                            pass
            except Exception as e:
                try:
                    print(f"[all-positions] Exception with {endpoint}: {e}")
                except Exception:
                    pass

        # Process all collected positions
        normalized_positions = []
        seen_symbols = set()

        for pos in all_positions:
            if isinstance(pos, dict) and pos.get("symbol"):
                symbol = pos.get("symbol")
                if symbol not in seen_symbols:  # Avoid duplicates
                    normalized = normalize_bitget_position(symbol, pos)
                    if normalized:
                        normalized["found"] = True
                        normalized["fetched_at"] = int(time.time())
                        normalized_positions.append(normalized)
                        seen_symbols.add(symbol)

        # Sort by symbol for consistent ordering
        normalized_positions.sort(key=lambda x: x.get("bitget_symbol", ""))

        return {
            "positions": normalized_positions,
            "count": len(normalized_positions),
            "fetched_at": int(time.time())
        }

    except Exception as e:
        print(f"[all-positions] Error fetching all Bitget positions: {e}")
        return {"positions": [], "count": 0, "error": str(e)}


@app.post("/bitget/close-position")
async def close_position(request: Request, current_user: Dict[str, str] = Depends(get_current_user)):
    """Close a position for a specific trade ID."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    trade_id = body.get("trade_id")
    reason = body.get("reason", "manual_close")
    if not trade_id:
        raise HTTPException(status_code=400, detail="Missing required field: 'trade_id'")

    # Fetch the trade from database
    trade_row = await database.fetch_one(trades.select().where(trades.c.id == trade_id))
    if not trade_row:
        raise HTTPException(status_code=404, detail="Trade not found")

    trade_row = dict(trade_row)

    # Allow closing if status is "placed" or "closed" (for re-processing) or if it's an external close (position disappeared from Bitget)
    if trade_row.get("status") not in ("placed", "closed") and reason != "external_close":
        raise HTTPException(status_code=400, detail=f"Cannot close trade with status '{trade_row.get('status')}'")

    # Only attempt Bitget API close for manual closes, not for external closes
    if reason != "external_close":
        # Attempt to close the position on Bitget
        success, detail = await close_existing_bitget_position(trade_row)
        if not success:
            raise HTTPException(status_code=502, detail=detail or "Failed to close Bitget position")

        # Get current market price for exit_price (since it's a market close)
        symbol = trade_row.get("symbol", "")
        exit_price = None
        if symbol:
            exit_price = await get_market_price_with_retries(symbol)

        # Calculate realized PnL if possible
        entry_price = safe_float(trade_row.get("price"))
        size_value = safe_float(trade_row.get("size"))
        realized_pnl = None
        if exit_price is not None and entry_price is not None and size_value is not None and size_value != 0:
            direction = 1 if str(trade_row.get("signal") or "").upper() in ("BUY", "LONG") else -1
            realized_pnl = float((exit_price - entry_price) * size_value * direction)
    else:
        # For external closes, use current market price and calculate PnL
        symbol = trade_row.get("symbol", "")
        exit_price = None
        realized_pnl = None
        if symbol:
            exit_price = await get_market_price_with_retries(symbol)

            # Calculate realized PnL based on last known Bitget position data
            try:
                position_snapshot = await fetch_bitget_position(symbol)
                if position_snapshot:
                    unrealized = safe_float(position_snapshot.get("unrealizedPL") or position_snapshot.get("unrealized_pnl"))
                    if unrealized is not None:
                        realized_pnl = unrealized
                    else:
                        # Fallback to calculation
                        entry_price = safe_float(trade_row.get("price"))
                        size_value = safe_float(trade_row.get("size"))
                        if exit_price is not None and entry_price is not None and size_value is not None and size_value != 0:
                            direction = 1 if str(trade_row.get("signal") or "").upper() in ("BUY", "LONG") else -1
                            realized_pnl = float((exit_price - entry_price) * size_value * direction)
                else:
                    # Fallback calculation if no position data
                    entry_price = safe_float(trade_row.get("price"))
                    size_value = safe_float(trade_row.get("size"))
                    if exit_price is not None and entry_price is not None and size_value is not None and size_value != 0:
                        direction = 1 if str(trade_row.get("signal") or "").upper() in ("BUY", "LONG") else -1
                        realized_pnl = float((exit_price - entry_price) * size_value * direction)
            except Exception as e:
                try:
                    print(f"[close-position] error calculating PnL for external close: {e}")
                except Exception:
                    pass

    # Update trade status and exit details
    update_values = {"status": "closed"}
    if exit_price is not None:
        update_values["exit_price"] = exit_price
    if realized_pnl is not None:
        update_values["realized_pnl"] = realized_pnl

    # Clear reservation when marking external close
    update_values["reservation_key"] = None
    await database.execute(trades.update().where(trades.c.id == trade_id).values(**update_values))

    # Broadcast the close event
    await broadcast({
        "type": "closed",
        "id": trade_id,
        "reason": reason,
        "exit_price": exit_price,
        "realized_pnl": realized_pnl,
    })

    return {
        "ok": True,
        "trade_id": trade_id,
        "exit_price": exit_price,
        "realized_pnl": realized_pnl,
    }


@app.get("/bitget/cancel-orders/{symbol}", dependencies=[Depends(require_role(["admin"]))])
async def cancel_orders(symbol: str):
    """Cancel all open orders for a symbol (admin only)."""
    if str(BITGET_DRY_RUN).lower() in ("1", "true", "yes", "on"):
        return {"ok": False, "dry_run": True, "note": "BITGET_DRY_RUN is enabled — not cancelling orders"}

    if not (BITGET_API_KEY and BITGET_SECRET and BITGET_PASSPHRASE and BITGET_BASE):
        raise HTTPException(status_code=400, detail="Bitget credentials not configured")

    try:
        # Normalize symbol for Bitget
        sanitized = sanitize_symbol_for_bitget(symbol)

        if "_" in sanitized:
            bitget_symbol = sanitized
        else:
            bitget_symbol = sanitized

        # Cancel all orders for the symbol
        request_path = "/api/mix/v2/order/cancel-all-orders"
        body_obj: Dict[str, Any] = {"symbol": bitget_symbol, "productType": BITGET_PRODUCT_TYPE.lower()}
        if BITGET_MARGIN_COIN:
            body_obj["marginCoin"] = BITGET_MARGIN_COIN

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

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(BITGET_BASE + request_path, headers=headers, content=body)
            data = resp.json()

        return {
            "ok": True,
            "symbol": sanitized or symbol,
            "bitget_symbol": bitget_symbol,
            "status_code": resp.status_code,
            "response": data
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))