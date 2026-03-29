from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
import feedparser
import time
import sqlite3
import os
from werkzeug.security import generate_password_hash, check_password_hash
from concurrent.futures import ThreadPoolExecutor

app = Flask(__name__)
CORS(app)

DB_PATH = "terminal.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

@app.route("/")
def index():
    return open(os.path.join(BASE_DIR, "index.html")).read()

@app.route("/ads.txt")
def ads_txt():
    return open(os.path.join(BASE_DIR, "ads.txt")).read()

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    # Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            email TEXT,
            password TEXT,
            wallet_address TEXT UNIQUE,
            provider TEXT,
            provider_id TEXT UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # MIGRATION: Ensure 'provider', 'provider_id', and 'email' columns exist if table was already created
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN email TEXT")
    except sqlite3.OperationalError: pass
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN provider TEXT")
    except sqlite3.OperationalError: pass
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN provider_id TEXT")
    except sqlite3.OperationalError: pass

    conn.commit()
    # Watchlist table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    ''')
    # Trades table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            side TEXT NOT NULL,
            price REAL NOT NULL,
            amount REAL NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    ''')
    # Fav Bots table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS fav_bots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            bot_name TEXT NOT NULL,
            config TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    ''')
    conn.commit()
    conn.close()

init_db()

BINANCE = "https://api.binance.com/api/v3"
COINGECKO = "https://api.coingecko.com/api/v3"
# GLOBAL CACHE
MARKET_CACHE = {
    "ticker": {"data": None, "time": 0},
    "top": {"data": None, "time": 0},
    "cg": {}
}
NEWS = []
NEWS_TIME = 0
EVENTS = []
EVENTS_TIME = 0

# AI CONFIGURATION (Supports Local Ollama & Cloudflare AI Gateway)
OLLAMA_BASE = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "minimax-m2.7:cloud")
OLLAMA_FALLBACK_MODEL = os.getenv("OLLAMA_FALLBACK_MODEL", "qwen2.5:3b")

# Cloudflare Configuration
CF_CLIENT_ID = os.getenv("CF_ACCESS_CLIENT_ID", "")
CF_CLIENT_SECRET = os.getenv("CF_ACCESS_CLIENT_SECRET", "")
CF_AIG_TOKEN = os.getenv("CF_AIG_TOKEN", "") 

# Binance to CoinGecko Mapping for Fallbacks
BINANCE_TO_CG_MAP = {
    "BTCUSDT": "bitcoin", "ETHUSDT": "ethereum", "BNBUSDT": "binancecoin",
    "SOLUSDT": "solana", "XRPUSDT": "ripple", "ADAUSDT": "cardano",
    "DOTUSDT": "polkadot", "AVAXUSDT": "avalanche-2", "DOGEUSDT": "dogecoin",
    "LINKUSDT": "chainlink", "UNIUSDT": "uniswap", "ATOMUSDT": "cosmos",
    "MATICUSDT": "matic-network", "NEARUSDT": "near", "APTUSDT": "aptos",
    "ARBUSDT": "arbitrum", "OPUSDT": "optimism", "SUIUSDT": "sui"
}

def get_cf_headers():
    """Returns Cloudflare Access auth headers."""
    headers = {}
    if CF_CLIENT_ID and CF_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_CLIENT_SECRET
    if CF_AIG_TOKEN:
        headers["Authorization"] = f"Bearer {CF_AIG_TOKEN}"
    headers["Content-Type"] = "application/json"
    return headers

def call_ai_api(prompt, model=None, system_prompt=None, timeout=30):
    """
    Unified AI call handler. 
    Supports Ollama (/api/generate) and OpenAI-compatible (/v1/chat/completions).
    """
    target_model = model or OLLAMA_MODEL
    headers = get_cf_headers()
    
    # Detect API type from URL
    is_openai_compat = "/v1" in OLLAMA_BASE or "gateway.ai.cloudflare.com" in OLLAMA_BASE
    
    try:
        if is_openai_compat:
            url = f"{OLLAMA_BASE}/chat/completions"
            payload = {
                "model": target_model,
                "messages": [
                    {"role": "system", "content": system_prompt or "You are a crypto terminal assistant."},
                    {"role": "user", "content": prompt}
                ],
                "stream": False
            }
            r = requests.post(url, json=payload, headers=headers, timeout=timeout)
            if r.ok:
                return r.json()["choices"][0]["message"]["content"].strip(), None
        else:
            url = f"{OLLAMA_BASE}/api/generate"
            payload = {
                "model": target_model,
                "prompt": f"{system_prompt}\n\n{prompt}" if system_prompt else prompt,
                "stream": False
            }
            r = requests.post(url, json=payload, headers=headers, timeout=timeout)
            if r.ok:
                return r.json().get("response", "").strip(), None
        
        # Handle errors
        error_msg = f"AI Error {r.status_code}: {r.text[:100]}"
        return None, error_msg
    except Exception as e:
        return None, str(e)

def ollama_ok():
    """Checks if the AI service is reachable."""
    try:
        # For AI Gateway/OpenAI compat, we check /models or just a quick ping
        if "gateway.ai.cloudflare.com" in OLLAMA_BASE:
            return True # Assume OK if configured, or do a more expensive check later
        return requests.get(f"{OLLAMA_BASE}/api/tags", timeout=5, headers=get_cf_headers()).ok
    except:
        return False


# ================= BINANCE API =================
def api(path, params=None):
    try:
        r = requests.get(BINANCE + path, params=params, timeout=10)
        # Handle "Restricted Location" (451) or "Forbidden" (403)
        if r.status_code in [451, 403]:
            return {"restricted": True, "code": r.status_code}, None
        if not r.ok:
            return None, f"Binance API Error {r.status_code}: {r.text}"
        return r.json(), None
    except Exception as e:
        return None, str(e)

def get_mexc_ticker(symbols):
    """Fallback to MEXC Public API (often more reliable for cloud IPs)"""
    try:
        # MEXC uses BaseCurrency+QuoteCurrency (e.g., BTCUSDT)
        r = requests.get("https://www.mexc.com/open/api/v2/market/ticker", timeout=8)
        if not r.ok: return None
        
        mexc_data = {item['symbol']: item for item in r.json().get('data', [])}
        results = []
        for s in symbols:
            if s in mexc_data:
                d = mexc_data[s]
                results.append({
                    "symbol": s,
                    "lastPrice": str(d.get("last", 0)),
                    "priceChangePercent": str(d.get("change_rate", 0)),
                    "volume": str(d.get("amount", 0)),
                    "highPrice": str(d.get("high", "---")),
                    "lowPrice": str(d.get("low", "---")),
                    "source": "MEXC (Fallback)"
                })
        return results if results else None
    except:
        return None

def get_cg_ticker_fallback(binance_symbols):
    """Fetches simple price data from CG and formats it as Binance 24hr ticker."""
    # First, try MEXC as it's more 'Binance-like' and faster
    mexc = get_mexc_ticker(binance_symbols)
    if mexc: return mexc

    cg_ids = [BINANCE_TO_CG_MAP.get(s) for s in binance_symbols if BINANCE_TO_CG_MAP.get(s)]
    if not cg_ids: return []
    
    ids_param = ",".join(cg_ids)
    url = f"https://api.coingecko.com/api/v3/simple/price"
    params = {
        "ids": ids_param,
        "vs_currencies": "usd",
        "include_24hr_vol": "true",
        "include_24hr_change": "true"
    }
    
    try:
        r = requests.get(url, params=params, timeout=10)
        if not r.ok:
             print(f"⚠️ CG Fallback API Error: {r.status_code}")
        else:
            cg_data = r.json()
            fallback_results = []
            cg_to_binance = {v: k for k, v in BINANCE_TO_CG_MAP.items()}
            for cg_id, data in cg_data.items():
                b_sym = cg_to_binance.get(cg_id)
                if not b_sym: continue
                fallback_results.append({
                    "symbol": b_sym,
                    "lastPrice": str(data.get("usd", 0)),
                    "priceChangePercent": str(round(data.get("usd_24h_change", 0), 2)),
                    "volume": str(data.get("usd_24h_vol", 0)),
                    "highPrice": "---",
                    "lowPrice": "---",
                    "source": "CoinGecko (Fallback)"
                })
            if fallback_results:
                return fallback_results
    except Exception as e:
        print(f"❌ CG Fallback Exception: {e}")
    
    # Final Emergency Fallback (Hardcoded) if even CG fails/rate-limits
    return [
        {"symbol": "BTCUSDT", "lastPrice": "65420.50", "priceChangePercent": "1.2", "volume": "35000000000", "highPrice": "66000", "lowPrice": "64000", "source": "Emergency Fallback"},
        {"symbol": "ETHUSDT", "lastPrice": "3480.12", "priceChangePercent": "-0.5", "volume": "12000000000", "highPrice": "3550", "lowPrice": "3420", "source": "Emergency Fallback"},
        {"symbol": "BNBUSDT", "lastPrice": "592.30", "priceChangePercent": "0.8", "volume": "2000000000", "highPrice": "600", "lowPrice": "580", "source": "Emergency Fallback"}
    ]


# ================= DETECT COINS =================
def detect(text):
    t = text.lower()
    found = []
    pairs = {
        "BTC": "bitcoin btc",
        "ETH": "ethereum eth",
        "XRP": "ripple xrp",
        "SOL": "solana sol",
        "ADA": "cardano ada",
        "DOGE": "dogecoin doge"
    }
    for s, words in pairs.items():
        for w in words.split():
            if w in t:
                found.append(s)
                break
    return found


# ================= RSS =================
def rss(url, name):
    try:
        feed = feedparser.parse(url)
        results = []
        for e in feed.entries[:15]:
            results.append({
                "id": hash(e.link),
                "title": e.title,
                "url": e.link,
                "source": name,
                "published_at": e.get("published", ""),
                "currencies": detect(e.title),
                "votes": 0
            })
        return results
    except:
        return []


# ================= CRYPTOPANIC =================
def cp():
    try:
        r = requests.get(
            "https://cryptopanic.com/api/free/v1/posts/",
            params={
                "auth_token": "public",
                "currencies": "BTC,ETH,SOL",
                "kind": "news",
                "filter": "hot"
            },
            timeout=10
        )
        if r.ok:
            results = []
            for item in r.json().get("results", [])[:20]:
                src = item.get("source", {})
                currencies = item.get("currencies") or []
                votes = item.get("votes") or {}
                results.append({
                    "id": item.get("id"),
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "source": src.get("title", "Unknown") if isinstance(src, dict) else "Unknown",
                    "published_at": item.get("published_at", ""),
                    "currencies": [c.get("code") for c in currencies if isinstance(c, dict) and c.get("code")],
                    "votes": votes.get("positive", 0) - votes.get("negative", 0)
                })
            return results
    except:
        return []
    return []


# ================= MARKET EVENTS =================
def impact_from_title(title):
    t = (title or "").lower()
    high = ["fed", "sec", "etf", "cpi", "rate", "ban", "hack", "liquidation"]
    medium = ["listing", "upgrade", "partnership", "regulation", "outage"]
    if any(k in t for k in high):
        return 3
    if any(k in t for k in medium):
        return 2
    return 1


def format_hhmm(entry):
    ts = entry.get("published_parsed") or entry.get("updated_parsed")
    if not ts:
        return "--:--"
    return time.strftime("%H:%M", ts)


def get_market_events():
    global EVENTS, EVENTS_TIME

    if EVENTS and (time.time() - EVENTS_TIME) < 300:
        return EVENTS

    feeds = [
        ("https://www.federalreserve.gov/feeds/press_all.xml", "FED", "US"),
        ("https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk", "CR"),
        ("https://cointelegraph.com/rss", "CoinTelegraph", "CR"),
    ]

    events = []
    for url, source, country in feeds:
        try:
            feed = feedparser.parse(url)
            for e in feed.entries[:8]:
                title = e.get("title", "").strip()
                if not title:
                    continue
                events.append({
                    "time": format_hhmm(e),
                    "country": country,
                    "name": title,
                    "impact": impact_from_title(title),
                    "source": source,
                    "url": e.get("link", ""),
                    "published_at": e.get("published", e.get("updated", ""))
                })
        except:
            continue

    events.sort(key=lambda x: (x.get("impact", 1), x.get("published_at", "")), reverse=True)
    EVENTS = events[:12]
    EVENTS_TIME = time.time()
    return EVENTS


# ================= GET NEWS =================
def get_news():
    global NEWS, NEWS_TIME

    if NEWS and (time.time() - NEWS_TIME) < 300:
        return NEWS

    all_n = []

    with ThreadPoolExecutor(max_workers=4) as ex:
        feeds = [
            ("https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"),
            ("https://cointelegraph.com/rss", "CoinTelegraph"),
            ("https://bitcoinist.com/feed/", "Bitcoinist")
        ]
        for url, name in feeds:
            all_n.extend(ex.submit(rss, url, name).result() or [])

    all_n.extend(cp() or [])

    seen = set()
    uniq = []
    for n in all_n:
        if n["url"] not in seen:
            seen.add(n["url"])
            uniq.append(n)

    uniq.sort(key=lambda x: (x.get("votes", 0), x.get("published_at", "")), reverse=True)

    NEWS = uniq
    NEWS_TIME = time.time()

    return NEWS

# ================= COINGECKO API =================
def get_cg(path, params=None):
    global CG_CACHE
    now = time.time()
    cache_key = f"{path}_{str(params)}"
    
    if cache_key in CG_CACHE:
        entry, exp = CG_CACHE[cache_key]
        if now < exp:
            return entry, None

    try:
        r = requests.get(COINGECKO + path, params=params, timeout=12)
        if r.ok:
            data = r.json()
            CG_CACHE[cache_key] = (data, now + 300) # 5 min cache
            return data, None
        
        print(f"⚠️ CG API Failure: {path} - Status {r.status_code}")
        if r.status_code == 429:
             print("🛑 CoinGecko Rate Limited (429). Using fallback data.")
        
        return None, f"CG Error: {r.status_code}"
    except Exception as e:
        print(f"❌ CG Exception: {str(e)}")
        return None, str(e)


# ================= ROUTES =================
@app.route("/health")
def health():
    return jsonify({"status": "ok", "ollama": ollama_ok()})


# ================= DATABASE INTROSPECTION =================
# @app.route("/api/admin/db/tables")
# def db_tables():
#     try:
#         db = get_db()
#         tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
#         result = []
#         for t in tables:
#             count = db.execute(f"SELECT COUNT(*) FROM {t['name']}").fetchone()[0]
#             result.append({"name": t["name"], "count": count})
#         return jsonify({"tables": result})
#     except Exception as e:
#         return jsonify({"error": str(e)}), 50000


# @app.route("/api/admin/db/data")
# def db_data():
#     table = request.args.get("table")
#     if not table: return jsonify({"error": "No table"}), 400
#     try:
#         db = get_db()
#         cursor = db.execute(f"SELECT * FROM {table} LIMIT 100")
#         columns = [description[0] for description in cursor.description]
#         rows = [list(row) for row in cursor.fetchall()]
#         return jsonify({"columns": columns, "rows": rows})
#     except Exception as e:
#         return jsonify({"error": str(e)}), 50000



@app.route("/api/ticker/24hr")
def ticker():
    global MARKET_CACHE
    now = time.time()
    default_symbols = "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOTUSDT,AVAXUSDT,DOGEUSDT,LINKUSDT"
    syms_str = request.args.get("symbols", default_symbols)
    syms = [s.strip().upper() for s in syms_str.split(",")]

    # Cache check (60 sec TTL for ticker)
    if MARKET_CACHE["ticker"]["data"] and (now - MARKET_CACHE["ticker"]["time"]) < 60:
        return jsonify(MARKET_CACHE["ticker"]["data"])

    data, err = api("/ticker/24hr", {
        "symbols": '["' + '","'.join(syms) + '"]'
    })

    # If restricted or error, use fallback
    if err or (isinstance(data, dict) and data.get("restricted")):
        print(f"⚠️ Binance Restricted/Error: Using Fallbacks for /ticker")
        data = get_cg_ticker_fallback(syms)

    MARKET_CACHE["ticker"]["data"] = data
    MARKET_CACHE["ticker"]["time"] = now
    return jsonify(data)


@app.route("/api/ticker/top")
def top():
    global MARKET_CACHE
    now = time.time()
    syms = list(BINANCE_TO_CG_MAP.keys())

    # Cache check (5 min TTL for top)
    if MARKET_CACHE["top"]["data"] and (now - MARKET_CACHE["top"]["time"]) < 300:
        return jsonify(MARKET_CACHE["top"]["data"])

    data, err = api("/ticker/24hr", {
        "symbols": '["' + '","'.join(syms) + '"]'
    })

    # If restricted, use fallback
    if err or (isinstance(data, dict) and data.get("restricted")):
        print("⚠️ Binance Restricted/Error: Using Fallbacks for /top")
        data = get_cg_ticker_fallback(syms)
        MARKET_CACHE["top"]["data"] = data
        MARKET_CACHE["top"]["time"] = now
        return jsonify(data)

    if not isinstance(data, list):
        data = get_cg_ticker_fallback(syms)
        MARKET_CACHE["top"]["data"] = data
        MARKET_CACHE["top"]["time"] = now
        return jsonify(data)

    results = []
    for item in data:
        if not isinstance(item, dict):
            continue
        last = float(item.get("lastPrice", 0))
        high = float(item.get("highPrice", 0))
        low = float(item.get("lowPrice", 0))
        vol = float(item.get("quoteVolume", 0))
        volatility = ((high - low) / low * 100) if low > 0 else 0
        
        results.append({
            "symbol": item.get("symbol"),
            "lastPrice": last,
            "volume": vol,
            "volatility": round(volatility, 2),
            "priceChangePercent": float(item.get("priceChangePercent", 0))
        })

    sorted_by_vol = sorted(results, key=lambda x: x["volume"], reverse=True)
    MARKET_CACHE["top"]["data"] = sorted_by_vol[:20]
    MARKET_CACHE["top"]["time"] = now
    return jsonify(MARKET_CACHE["top"]["data"])


@app.route("/api/klines")
def klines():
    sym = request.args.get("symbol", "BTCUSDT").upper()
    interval = request.args.get("interval", "1h")
    limit = int(request.args.get("limit", 300))

    data, err = api("/klines", {
        "symbol": sym,
        "interval": interval,
        "limit": limit
    })

    if err:
        print(f"DEBUG [klines]: {err}")
        return jsonify({"error": err}), 502

    if not isinstance(data, list):
        print(f"DEBUG [klines]: Expected list, got {type(data)} - {data}")
        return jsonify({"error": "Binance API rejected cloud request (IP blocked/Rate limited)", "details": str(data)}), 502

    return jsonify([
        {
            "time": c[0],
            "open": float(c[1]),
            "high": float(c[2]),
            "low": float(c[3]),
            "close": float(c[4]),
            "volume": float(c[5])
        }
        for c in data
    ])


@app.route("/api/news")
def news():
    try:
        limit = int(request.args.get("limit", 25))
        all_news = get_news()
        return jsonify({"news": all_news[:limit], "total": len(all_news)})
    except Exception as e:
        return jsonify({"news": [], "total": 0, "error": str(e)}), 200


@app.route("/api/news/sentiment")
def sentiment():
    all_n = get_news()

    bullish_words = ["bullish","pump","surge","rally","moon","growth","etf"]
    bearish_words = ["bearish","dump","crash","decline","ban","hack"]

    bc = sum(1 for n in all_n[:20] if any(w in n["title"].lower() for w in bullish_words))
    rc = sum(1 for n in all_n[:20] if any(w in n["title"].lower() for w in bearish_words))

    total = bc + rc
    score = 50 if total == 0 else int((bc / total) * 100)

    sentiment = "Neutral"
    if score > 60:
        sentiment = "Bullish"
    elif score < 40:
        sentiment = "Bearish"

    return jsonify({
        "sentiment": sentiment,
        "score": score,
        "bullish_count": bc,
        "bearish_count": rc
    })


@app.route("/api/events")
def events():
    limit = int(request.args.get("limit", 8))
    return jsonify({"events": get_market_events()[:limit]})


@app.route("/api/news/summary", methods=["POST"])
def summary():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing data"}), 400

    title = data.get("title", "")
    prompt = f"Summarize this crypto news headline in exactly 10 words: {title}"
    
    response, error = call_ai_api(prompt, timeout=15)
    if response:
        return jsonify({"summary": response})
    
    return jsonify({"summary": "AI summary currently unavailable"})


@app.route("/api/ai/search", methods=["POST"])
def ai_search():
    data = request.get_json() or {}
    query = (data.get("query") or "").strip()
    symbol = (data.get("symbol") or "").strip().upper()

    if not query:
        return jsonify({"error": "Missing query"}), 400

    system_prompt = f"You are a local crypto terminal assistant. Symbol context: {symbol or 'N/A'}."
    
    # Primary Call
    response, error = call_ai_api(query, system_prompt=system_prompt, timeout=45)
    
    if response:
        return jsonify({"answer": response, "model": OLLAMA_MODEL})
    
    # Fallback Call
    if OLLAMA_FALLBACK_MODEL and OLLAMA_FALLBACK_MODEL != OLLAMA_MODEL:
        fb_response, fb_error = call_ai_api(query, model=OLLAMA_FALLBACK_MODEL, system_prompt=system_prompt, timeout=45)
        if fb_response:
            return jsonify({
                "answer": fb_response,
                "model": OLLAMA_FALLBACK_MODEL,
                "warning": error
            })

    return jsonify({"error": error or "AI request failed"}), 502


@app.route("/api/ollama/status")
@app.route("/api/ai/status")
def ai_status_check():
    """Endpoint for frontend to check AI connectivity."""
    is_up = ollama_ok()
    return jsonify({
        "status": "online" if is_up else "offline",
        "model": OLLAMA_MODEL,
        "endpoint": OLLAMA_BASE,
        "provider": "Cloudflare/Ollama"
    })
    return jsonify({
        "available": ok,
        "mode": "Gateway/OpenAI" if "/v1" in OLLAMA_BASE or "gateway" in OLLAMA_BASE else "Local/Ollama",
        "url": OLLAMA_BASE,
        "model": OLLAMA_MODEL
    })


# ================= BOT API =================
@app.route("/api/bot/status")
def bot_status():
    return jsonify({
        "bots": [
            {"id": "rsi_bot", "name": "RSI Scalper", "status": "active", "profit": "+2.4%"},
            {"id": "grid_bot", "name": "Grid Trader", "status": "inactive", "profit": "0.0%"},
            {"id": "arbitrage", "name": "Arb Finder", "status": "error", "profit": "-0.5%"}
        ]
    })


@app.route("/api/bot/signals")
def bot_signals():
    # Simulated signals based on randomness for demo
    import random
    symbols = ["BTC", "ETH", "SOL", "AVAX"]
    signals = []
    for s in symbols:
        val = random.randint(0, 100)
        sig = "NEUTRAL"
        if val > 70: sig = "BUY"
        elif val < 30: sig = "SELL"
        signals.append({"symbol": s, "rsi": val, "signal": sig})
    return jsonify({"signals": signals})


@app.route("/api/bot/backtest", methods=["POST"])
def bot_backtest():
    data = request.get_json() or {}
    strategy = data.get("strategy", "Crossover")
    symbol = data.get("symbol", "BTCUSDT")
    days = int(data.get("days", 30))
    
    # Mock backtest result
    import random
    profit = random.uniform(-5.0, 15.0)
    trades = random.randint(10, 50)
    win_rate = random.randint(40, 75)
    
    return jsonify({
        "strategy": strategy,
        "symbol": symbol,
        "days": days,
        "profit_pct": round(profit, 2),
        "total_trades": trades,
        "win_rate": f"{win_rate}%",
        "max_drawdown": f"-{round(random.uniform(1, 8), 1)}%"
    })


@app.route("/api/bot/logs")
def bot_logs():
    return jsonify({
        "logs": [
            {"time": "09:45:12", "bot": "RSI Scalper", "msg": "Buy signal detected on BTC/USDT"},
            {"time": "09:40:05", "bot": "RSI Scalper", "msg": "Closed position ETH/USDT +1.2%"},
            {"time": "09:30:00", "bot": "System", "msg": "Market analyzer synchronized"},
            {"time": "09:12:44", "bot": "System", "msg": "Strategy engine started"}
        ]
    })


# ================= MARKET TERMINAL API =================
@app.route("/api/market/global")
def market_global():
    data, err = get_cg("/global")
    if err or not isinstance(data, dict):
        return jsonify({
            "total_mcap": "$2.64T", "mcap_change": "+1.2%", "vol_24h": "$84.2B",
            "btc_dom": "52.1%", "eth_dom": "17.2%", "active_coins": "12,430",
            "warning": "Using fallback data due to CG error"
        })

    mcap = sum(g.get("total_market_cap", {}).values())
    vol = sum(g.get("total_volume", {}).values())
    
    def fmt(n):
        if n > 1e12: return f"${round(n/1e12, 2)}T"
        if n > 1e9: return f"${round(n/1e9, 2)}B"
        return f"${round(n/1e6, 2)}M"

    return jsonify({
        "total_mcap": fmt(g.get("total_market_cap", {}).get("usd", 2600000000000)),
        "mcap_change": f"{round(g.get('market_cap_change_percentage_24h_usd', 0), 1)}%",
        "vol_24h": fmt(g.get("total_volume", {}).get("usd", 80000000000)),
        "btc_dom": f"{round(g.get('market_cap_percentage', {}).get('btc', 52), 1)}%",
        "eth_dom": f"{round(g.get('market_cap_percentage', {}).get('eth', 17), 1)}%",
        "active_coins": f"{g.get('active_cryptocurrencies', 0):,}"
    })

@app.route("/api/market/list")
def market_list():
    cat = request.args.get("category", "all").lower()
    mapping = {
        "defi": "decentralized-finance-defi",
        "layer1": "layer-1",
        "infrastructure": "infrastructure",
        "memes": "meme-token",
        "ai": "artificial-intelligence",
        "gaming": "gaming",
        "nft": "nft",
        "storage": "storage",
        "dex": "decentralized-exchange"
    }
    
    cg_cat = mapping.get(cat)
    params = {
        "vs_currency": "usd",
        "order": "market_cap_desc",
        "per_page": 100,
        "page": 1,
        "sparkline": True,
        "price_change_percentage": "24h,7d"
    }
    if cg_cat:
        params["category"] = cg_cat

    data, err = get_cg("/coins/markets", params)
    if err or not isinstance(data, list):
        print(f"⚠️ CG Market List Error: {err}")
        # Return a larger hardcoded set as emergency fallback
        fallback = [
            {"symbol": "BTCUSDT", "name": "Bitcoin", "price": 65420.50, "chg_24h": +1.2, "chg_7d": -2.4, "volume": 35e9, "mcap": 1.28e12, "rank": 1, "sparkline": []},
            {"symbol": "ETHUSDT", "name": "Ethereum", "price": 3480.12, "chg_24h": -0.5, "chg_7d": +1.8, "volume": 12e9, "mcap": 418e9, "rank": 2, "sparkline": []},
            {"symbol": "BNBUSDT", "name": "BNB", "price": 592.30, "chg_24h": +0.8, "chg_7d": +5.2, "volume": 2e9, "mcap": 91e9, "rank": 4, "sparkline": []},
            {"symbol": "SOLUSDT", "name": "Solana", "price": 145.67, "chg_24h": -2.1, "chg_7d": -8.4, "volume": 4e9, "mcap": 64e9, "rank": 5, "sparkline": []},
            {"symbol": "XRPUSDT", "name": "XRP", "price": 0.62, "chg_24h": +0.1, "chg_7d": -1.2, "volume": 1e9, "mcap": 34e9, "rank": 6, "sparkline": []},
            {"symbol": "ADAUSDT", "name": "Cardano", "price": 0.45, "chg_24h": -1.5, "chg_7d": -4.2, "volume": 500e6, "mcap": 16e9, "rank": 9, "sparkline": []},
            {"symbol": "AVAXUSDT", "name": "Avalanche", "price": 38.20, "chg_24h": +2.4, "chg_7d": -10.5, "volume": 800e6, "mcap": 14e9, "rank": 11, "sparkline": []},
            {"symbol": "DOTUSDT", "name": "Polkadot", "price": 7.12, "chg_24h": -1.2, "chg_7d": -3.8, "volume": 200e6, "mcap": 10e9, "rank": 14, "sparkline": []},
            {"symbol": "DOGEUSDT", "name": "Dogecoin", "price": 0.16, "chg_24h": +5.4, "chg_7d": +12.1, "volume": 1.2e9, "mcap": 23e9, "rank": 8, "sparkline": []},
            {"symbol": "LINKUSDT", "name": "Chainlink", "price": 18.45, "chg_24h": +0.3, "chg_7d": -5.1, "volume": 400e6, "mcap": 10e9, "rank": 13, "sparkline": []}
        ]
        return jsonify(fallback)

    results = []
    for coin in data:

        if not isinstance(coin, dict): continue
        symbol = coin.get("symbol", "").upper()
        # Map to Binance ticker for chart switching
        binance_sym = symbol + "USDT"
        
        # Get sparkline
        spark = coin.get("sparkline_in_7d", {}).get("price", [])
        
        results.append({
            "symbol": binance_sym,
            "name": coin.get("name", ""),
            "price": coin.get("current_price", 0) or 0,
            "chg_24h": round(coin.get("price_change_percentage_24h", 0) or 0, 2),
            "chg_7d": round(coin.get("price_change_percentage_7d_in_currency", 0) or 0, 2),
            "volume": coin.get("total_volume", 0) or 0,
            "mcap": coin.get("market_cap", 0) or 0,
            "rank": coin.get("market_cap_rank", 0) or 0,
            "sparkline": spark
        })

    return jsonify(results)


# ================= WHALE WATCH API =================
@app.route("/api/wallets/top")
def wallets_top():
    # Curated Top 50 Wallets (BTC & ETH)
    wallets = [
        {"rank": 1, "owner": "Binance-Cold", "addr": "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo", "balance": "248,597 BTC", "val": "$16.4B", "last_active": "2h ago", "type": "btc"},
        {"rank": 2, "owner": "Bitfinex-Cold", "addr": "bc1qgdjqv0c7q38g3yK7p7P9v3kE2X4W8F6v5Z", "balance": "178,010 BTC", "val": "$11.7B", "last_active": "5h ago", "type": "btc"},
        {"rank": 3, "owner": "MicroStrategy", "addr": "1LQoWist8KueUXUAtX4fP8i7LDF5qQ3W", "balance": "158,245 BTC", "val": "$10.4B", "last_active": "1d ago", "type": "btc"},
        {"rank": 4, "owner": "Mt. Gox Hack", "addr": "1FeexV6bAHb8ybZjqQMjJrcCrH41xXWM", "balance": "79,957 BTC", "val": "$5.2B", "last_active": "11yrs ago", "type": "btc"},
        {"rank": 5, "owner": "Satoshi-Era", "addr": "1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf", "balance": "68,000 BTC", "val": "$4.5B", "last_active": "15yrs ago", "type": "btc"},
        {"rank": 6, "owner": "Beacon-Deposit", "addr": "0x00000000219ab540356cBB839Cbe05303d7705Fa", "balance": "32,450,120 ETH", "val": "$105.2B", "last_active": "1m ago", "type": "eth"},
        {"rank": 7, "owner": "Arbitrum-Bridge", "addr": "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a", "balance": "2,840,000 ETH", "val": "$9.2B", "last_active": "12m ago", "type": "eth"},
        {"rank": 8, "owner": "Kraken-Cold", "addr": "0x2B1a8D9345D14E1BCEa2C6f05F4A87C1f7D6B", "balance": "1,240,000 ETH", "val": "$4.0B", "last_active": "4h ago", "type": "eth"},
        # ... Adding more to reach approx Top 50 for frontend rendering 
    ]
    # Filler for Top 50 demo
    for i in range(len(wallets)+1, 51):
        chain = "eth" if i % 2 == 0 else "btc"
        wallets.append({
            "rank": i, "owner": f"Unknown Whale #{i}", "addr": f"0x{i}...{i*7}", "balance": f"{50000-i*100:,.0f} {chain.upper()}",
            "val": f"${(50000-i*100)*0.065:,.1f}M", "last_active": f"{i%24}h ago", "type": chain
        })
    return jsonify(wallets)

@app.route("/api/wallets/institutions")
def wallets_institutions():
    return jsonify([
        {"name": "BlackRock (IBIT)", "ticker": "IBIT", "inflow": "+$245.2M", "total": "$22.4B", "status": "ACCUMULATING", "vol": "$1.4B", "position": "310,230 BTC", "stance": "LONG"},
        {"name": "Fidelity (FBTC)", "ticker": "FBTC", "inflow": "+$182.1M", "total": "$12.8B", "status": "ACCUMULATING", "vol": "$940M", "position": "180,420 BTC", "stance": "LONG"},
        {"name": "MicroStrategy", "ticker": "MSTR", "inflow": "+$0", "total": "$10.4B", "status": "HOLDING", "vol": "$15M", "position": "214,400 BTC", "stance": "HOLD"},
        {"name": "Grayscale (GBTC)", "ticker": "GBTC", "inflow": "-$42.5M", "total": "$15.8B", "status": "DISTRIBUTING", "vol": "$820M", "position": "260,110 BTC", "stance": "SHORT"},
        {"name": "Ark Invest", "ticker": "ARKB", "inflow": "+$12.4M", "total": "$2.1B", "status": "ACCUMULATING", "vol": "$110M", "position": "38,500 BTC", "stance": "LONG"}
    ])

@app.route("/api/dashboard/intel")
def dashboard_intel():
    return jsonify({
        "flow": {
            "assets": [
                {"coin": "BTC", "valStr": "-$240.5M", "pct": -82, "status": "Accumulation", "actor": "WHALES", "trend7d": "7D: -$1.1B"},
                {"coin": "ETH", "valStr": "+$84.2M", "pct": 45, "status": "Distribution", "actor": "RETAIL", "trend7d": "7D: +$300M"},
                {"coin": "SOL", "valStr": "-$12.5M", "pct": -20, "status": "Accumulation", "actor": "WHALES", "trend7d": "7D: -$50M"}
            ],
            "stablecoin": {"label": "Dry Powder", "valStr": "$1.2B", "pct": 85, "status": "Deployable"}
        },
        "liquidity": {
            "book_depth": "$4.2B",
            "buy_wall": "$62,400 (Top)",
            "sell_wall": "$68,000 (Top)"
        },
        "mined": [
            {"coin": "BTC", "pct": 93.8, "supply": "19.7M / 21M", "hash": "SHA-256"},
            {"coin": "ETH", "pct": 100, "supply": "120M / No Cap", "hash": "Ethash/PoS"},
            {"coin": "DOGE", "pct": 100, "supply": "144B / No Cap", "hash": "Scrypt"},
            {"coin": "LTC", "pct": 89.2, "supply": "74.5M / 84M", "hash": "Scrypt"},
            {"coin": "BCH", "pct": 94.1, "supply": "19.7M / 21M", "hash": "SHA-256d"}
        ],
        "health": {
            "hashrate": "620.4 EH/s",
            "active_addr": "840.2K",
            "avg_fee": "$2.40"
        }
    })

@app.route("/api/wallets/alerts")
def wallets_alerts():
    return jsonify({
        "alerts": [
            {"time": "12:15", "from": "Unknown", "to": "Binance", "val": "1,240 BTC ($81.2M)", "action": "INFLOW"},
            {"time": "12:05", "from": "Coinbase", "to": "Unknown Whale", "val": "3,400 ETH ($11.2M)", "action": "OUTFLOW"},
            {"time": "11:58", "from": "Unknown", "to": "Coinbase", "val": "540 BTC ($36.4M)", "action": "INFLOW"},
            {"time": "11:45", "from": "Binance", "to": "Unknown", "val": "24,500 ETH ($79.6M)", "action": "OUTFLOW"},
            {"time": "11:12", "from": "Unknown", "to": "Unknown Whale", "val": "500 BTC ($32.8M)", "action": "MOVE"}
        ],
        "exchange_flows": [
            {"exchange": "Binance", "net_24h": "-$142M", "sentiment": "BULLISH", "vol_24h": "$18.2B", "funding": "0.015%", "oi": "$6.4B", "irate": "4.2%"},
            {"exchange": "Coinbase", "net_24h": "+$45M", "sentiment": "BEARISH", "vol_24h": "$3.1B", "funding": "0.010%", "oi": "$1.2B", "irate": "3.5%"},
            {"exchange": "Kraken", "net_24h": "-$22M", "sentiment": "BULLISH", "vol_24h": "$1.8B", "funding": "0.011%", "oi": "$800M", "irate": "3.8%"},
            {"exchange": "Bybit", "net_24h": "+$12M", "sentiment": "BEARISH", "vol_24h": "$5.4B", "funding": "0.018%", "oi": "$3.1B", "irate": "4.5%"}
        ]
    })

# ================= NEWS TERMINAL API (LIVE WIRES) =================
TERMINAL_NEWS_CACHE = {}
TERMINAL_NEWS_TIME = {}

def get_impact_label(title):
    t = (title or "").lower()
    # High impact keywords
    high = ["fed", "sec", "cpi", "rate", "ban", "hack", "liquidation", "crash", "war", "hike", "halt"]
    # Medium impact keywords
    medium = ["listing", "upgrade", "partnership", "regulation", "outage", "earnings", "partnership", "acquire"]
    
    if any(k in t for k in high): return "HIGH"
    if any(k in t for k in medium): return "MEDIUM"
    return "LOW"

@app.route("/api/news/terminal")
def news_terminal():
    cat = request.args.get('category', 'crypto')
    now = time.time()
    
    # 5-minute memory cache per category
    if cat in TERMINAL_NEWS_CACHE and (now - TERMINAL_NEWS_TIME.get(cat, 0)) < 300:
        return jsonify(TERMINAL_NEWS_CACHE[cat])

    feeds = {
        "geopolitics": [
            ("https://www.federalreserve.gov/feeds/press_all.xml", "FED"),
            ("https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=401&id=100003114", "CNBC World"),
            ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC Global"),
            ("https://www.reuters.com/arc/outboundfeeds/rss/", "Reuters")
        ],
        "general": [
            ("https://techcrunch.com/feed/", "TechCrunch"),
            ("https://www.theverge.com/rss/index.xml", "The Verge"),
            ("https://feeds.npr.org/1019/rss.xml", "NPR Tech"),
            ("https://wired.com/feed/rss", "Wired")
        ],
        "crypto": [
            ("https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"),
            ("https://cointelegraph.com/rss", "CoinTelegraph"),
            ("https://blockworks.co/feed", "Blockworks"),
            ("https://cryptopanic.com/api/free/v1/posts/?auth_token=public&filter=hot", "CryptoPanic")
        ]
    }

    selected_feeds = feeds.get(cat, [])
    aggregated = []

    def fetch_feed(url, source_name):
        try:
            # Special case for CryptoPanic API if URL is recognized
            if "cryptopanic.com" in url:
                r = requests.get(url, timeout=5)
                if r.ok:
                    items = r.json().get("results", [])[:10]
                    return [{
                        "time": time.strftime("%H:%M"),
                        "title": i.get("title"),
                        "impact": get_impact_label(i.get("title")),
                        "desc": f"Source: {source_name} Aggregator. Trending Market Sentiment.",
                        "id": "BTC" if "BTC" in (i.get("title") or "").upper() else ("ETH" if "ETH" in (i.get("title") or "").upper() else None)
                    } for i in items]
                return []
            
            # Standard RSS processing
            feed = feedparser.parse(url)
            results = []
            for entry in feed.entries[:8]:
                title = entry.get("title", "").strip()
                desc = entry.get("summary", "") or entry.get("description", "")
                # Clean HTML tags from description
                desc = desc.split('<')[0] if '<' in desc else desc
                desc = desc[:150] + "..." if len(desc) > 150 else desc
                
                # Format time
                ts = entry.get("published_parsed") or entry.get("updated_parsed")
                time_str = time.strftime("%H:%M", ts) if ts else time.strftime("%H:%M")
                
                results.append({
                    "time": time_str,
                    "title": title,
                    "impact": get_impact_label(title),
                    "desc": desc,
                    "id": "BTC" if ("BITCOIN" in title.upper() or "BTC" in title.upper()) else ("ETH" if ("ETHEREUM" in title.upper() or "ETH" in title.upper()) else None)
                })
            return results
        except Exception as e:
            print(f"Feed error ({source_name}): {e}")
            return []

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(fetch_feed, f[0], f[1]) for f in selected_feeds]
        for future in futures:
            aggregated.extend(future.result())

    # Sort by time (most recent first)
    aggregated.sort(key=lambda x: x["time"], reverse=True)
    
    # Store in cache
    TERMINAL_NEWS_CACHE[cat] = aggregated
    TERMINAL_NEWS_TIME[cat] = now
    
    return jsonify(aggregated)

@app.route("/api/ai/bias")
def ai_bias():
    prompt = """Provide an ultra-condensed, highly technical 3-sentence market bias evaluation. 
    Context: BTC at $66K, -$240M whale accumulation, $68K sell wall. 
    Bias must be BULLISH, BEARISH, or NEUTRAL."""
    
    response, error = call_ai_api(prompt, timeout=15)
    
    if response:
        return jsonify({"status": "success", "bias": response})
    
    return jsonify({"status": "error", "message": error or "AI Bridge connection failed"}), 503

# ================= AUTH & USER PERSISTENCE =================
@app.route("/api/auth/register", methods=["POST"])
def register():
    data = request.json
    u, e, p = data.get("username"), data.get("email"), data.get("password")
    if not u or not p: return jsonify({"error": "Missing fields"}), 400
    
    conn = get_db()
    try:
        conn.execute("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", 
                     (u, e, generate_password_hash(p)))
        conn.commit()
        return jsonify({"success": True})
    except sqlite3.IntegrityError:
        return jsonify({"error": "User already exists"}), 400
    finally:
        conn.close()

@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.json
    u, p = data.get("username"), data.get("password")
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (u,)).fetchone()
    conn.close()
    
    if user and check_password_hash(user["password"], p):
        # In a real app, use JWT. For this local demo, we'll return the user_id as a 'token'.
        return jsonify({"success": True, "token": user["id"], "username": user["username"]})
    return jsonify({"error": "Invalid credentials"}), 401

@app.route("/api/auth/wallet", methods=["POST"])
def wallet_login():
    data = request.json
    addr = data.get("address") # 0x...
    if not addr: return jsonify({"error": "Missing wallet address"}), 400
    
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE wallet_address = ?", (addr,)).fetchone()
    
    if not user:
        # Register new wallet-based user
        username = addr[:6] + "..." + addr[-4:]
        try:
            cur = conn.execute("INSERT INTO users (username, wallet_address) VALUES (?, ?)", (username, addr))
            conn.commit()
            user_id = cur.lastrowid
        except sqlite3.IntegrityError:
            # Race condition or user exists
            user = conn.execute("SELECT * FROM users WHERE wallet_address = ?", (addr,)).fetchone()
            user_id = user["id"]
            username = user["username"]
        else:
            user_id = user_id
    else:
        user_id = user["id"]
        username = user["username"]
        
    conn.close()
    return jsonify({"success": True, "token": user_id, "username": username, "method": "wallet"})

@app.route("/api/auth/social/<provider>")
def social_login_gateway(provider):
    # Simulator: In a real app, this redirects to Google/GitHub/Facebook OAuth URL.
    # Here, we redirect to a simulated 'External Provider' page.
    return f"""
    <html>
        <body style="background:#000; color:#4AF6C3; font-family:monospace; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh;">
            <h2>{provider.upper()} IDENTITY HANDSHAKE</h2>
            <p>Redirecting to terminal callback in 2 seconds...</p>
            <div style="border:1px solid #4AF6C3; width:200px; height:10px;"><div style="background:#4AF6C3; width:50%; height:100%;"></div></div>
            <script>
                setTimeout(() => {{
                    window.location.href = '/api/auth/callback/{provider}?code=mock_code_123&state=abc';
                }}, 2000);
            </script>
        </body>
    </html>
    """

@app.route("/api/auth/callback/<provider>")
def social_callback(provider):
    # Process the mock identity token
    provider_id = f"social_{provider}_789"
    username = f"{provider}_Trader"
    
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE provider = ? AND provider_id = ?", (provider, provider_id)).fetchone()
    
    if not user:
        # Register new federated user
        try:
            cur = conn.execute("INSERT INTO users (username, provider, provider_id) VALUES (?, ?, ?)", (username, provider, provider_id))
            conn.commit()
            user_id = cur.lastrowid
        except sqlite3.IntegrityError:
            user = conn.execute("SELECT * FROM users WHERE provider = ? AND provider_id = ?", (provider, provider_id)).fetchone()
            user_id = user["id"]
    else:
        user_id = user["id"]
        username = user["username"]
        
    conn.close()
    # In this simulator, we redirect back to the frontend with the token
    return f"""
    <script>
        localStorage.setItem('bt_token', '{user_id}');
        localStorage.setItem('bt_user', '{username}');
        window.location.href = '{request.host_url}';
    </script>
    """

@app.route("/api/user/watchlist", methods=["GET", "POST"])
def user_watchlist():
    user_id = request.headers.get("Authorization")
    if not user_id: return jsonify({"error": "Unauthorized"}), 401
    
    conn = get_db()
    if request.method == "POST":
        symbols = request.json.get("symbols", [])
        conn.execute("DELETE FROM watchlist WHERE user_id = ?", (user_id,))
        for s in symbols:
            conn.execute("INSERT INTO watchlist (user_id, symbol) VALUES (?, ?)", (user_id, s))
        conn.commit()
    
    rows = conn.execute("SELECT symbol FROM watchlist WHERE user_id = ?", (user_id,)).fetchall()
    conn.close()
    return jsonify([row["symbol"] for row in rows])

@app.route("/api/user/trades", methods=["GET", "POST"])
def user_trades():
    user_id = request.headers.get("Authorization")
    if not user_id: return jsonify({"error": "Unauthorized"}), 401
    
    conn = get_db()
    if request.method == "POST":
        t = request.json
        conn.execute("INSERT INTO trades (user_id, symbol, side, price, amount) VALUES (?, ?, ?, ?, ?)",
                     (user_id, t["symbol"], t["side"], t["price"], t["amount"]))
        conn.commit()
    
    rows = conn.execute("SELECT * FROM trades WHERE user_id = ? ORDER BY timestamp DESC", (user_id,)).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])

@app.route("/api/user/bots", methods=["GET", "POST"])
def user_bots():
    user_id = request.headers.get("Authorization")
    if not user_id: return jsonify({"error": "Unauthorized"}), 401
    
    conn = get_db()
    if request.method == "POST":
        b = request.json
        conn.execute("INSERT INTO fav_bots (user_id, bot_name, config) VALUES (?, ?, ?)",
                     (user_id, b["name"], b["config"]))
        conn.commit()
    
    rows = conn.execute("SELECT * FROM fav_bots WHERE user_id = ?", (user_id,)).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])

GOOGLE_CLIENT_ID = "294364190338-np9qurh35idekm5lemiffpg8nodncpja.apps.googleusercontent.com"

@app.route("/api/auth/google", methods=["POST"])
def google_auth():
    data = request.json
    id_token = data.get("credential")
    if not id_token: return jsonify({"error": "Missing Google Token"}), 400
    
    # Verify token with Google's tokeninfo endpoint
    try:
        resp = requests.get(f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}", timeout=10)
        user_info = resp.json()
        
        if "error" in user_info:
            print(f"❌ Google Token Verification Error: {user_info.get('error_description', 'No description')}")
            return jsonify({"error": f"Invalid Google Token: {user_info.get('error')}"}), 401
            
        # Security: Verify audience matches our Client ID
        if user_info.get("aud") != GOOGLE_CLIENT_ID:
            print(f"❌ Audience mismatch! Expected {GOOGLE_CLIENT_ID}, got {user_info.get('aud')}")
            return jsonify({"error": "Security Mismatch: Audience (Client ID) does not match terminal configuration."}), 401
            
        # Extract Google Identity
        google_sub = user_info.get("sub")
        email = user_info.get("email")
        name = user_info.get("name", "Google User")
        
        conn = get_db()
        cursor = conn.cursor()
        
        # 1. Check if this Google account is already linked
        cursor.execute("SELECT * FROM users WHERE provider = 'google' AND provider_id = ?", (google_sub,))
        user_row = cursor.fetchone()
        
        if not user_row:
            # 2. Not linked. Check if a user with this email already exists
            cursor.execute("SELECT * FROM users WHERE email = ?", (email,))
            email_match = cursor.fetchone()
            
            if email_match:
                # Link Google ID to existing email account
                user_id = email_match["id"]
                username = email_match["username"]
                cursor.execute("UPDATE users SET provider = 'google', provider_id = ? WHERE id = ?", (google_sub, user_id))
                conn.commit()
            else:
                # 3. Completely new user. Handle Username Collision
                base_username = name
                final_username = name
                counter = 1
                
                # Ensure username is unique
                while True:
                    cursor.execute("SELECT id FROM users WHERE username = ?", (final_username,))
                    if not cursor.fetchone():
                        break
                    final_username = f"{base_username}_{counter}"
                    counter += 1
                
                try:
                    # Provide a secure random dummy password to satisfy NOT NULL constraints if they exist in the DB
                    dummy_password = generate_password_hash(os.urandom(24).hex())
                    cursor.execute("INSERT INTO users (username, email, password, provider, provider_id) VALUES (?, ?, ?, 'google', ?)", 
                                 (final_username, email, dummy_password, google_sub))
                    conn.commit()
                    user_id = cursor.lastrowid
                    username = final_username
                except sqlite3.IntegrityError as e:
                    # Final fallback if something else failed (like race condition)
                    return jsonify({"error": f"Security Handshake Error: {str(e)}"}), 500
        else:
            user_id = user_row["id"]
            username = user_row["username"]
            
        conn.close()
        return jsonify({"success": True, "token": user_id, "username": username, "method": "google"})
        
    except Exception as e:
        return jsonify({"error": f"Internal Identity Error: {str(e)}"}), 500

# ================= RUN =================
if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 8080))
    print(f"🚀 Crypto Terminal Server running at http://0.0.0.0:{port}")
    app.run(debug=False, host="0.0.0.0", port=port, threaded=True)