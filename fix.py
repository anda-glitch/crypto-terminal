import os

filepath = '/Users/aranayabsarkar/experiments/crypto_terminal/testcrypto.html'
with open(filepath, 'r') as f:
    text = f.read()

# 1. Fonts link
text = text.replace(
    'href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wgt@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"',
    'href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"'
)
# 2. Scripts src
text = text.replace(
    'src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.ssrc="https://unpkg.com/lightweight-charts@4..3/dist/lightweight-charts.standalone.production.js"',
    'src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"'
)
# 3. Loading 1
text = text.replace(
    'Loading..style="color:var(--text-mted);text-align:center;padding:20px;">Loading...',
    'Loading...'
)
# 3. Loading 2
text = text.replace(
    'Loading..style="color:var(--text-muted);text-align:center;padding:20px">Loading...',
    'Loading...'
)
# 4. SYMBOLS array
text = text.replace(
    "['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOTUSDT','A['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUST','DOTUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT'];",
    "['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOTUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT'];"
)
# 5. apiFetch news
text = text.replace(
    "apiFetch(`/news?filter=${useFilter}&crypto_only=${cryptoOnly}&limit=25`);apiFetch(`/news?filter=${useFilter}&crypto_onl=${cryptoOnly}&limit=25`);",
    "apiFetch(`/news?filter=${useFilter}&crypto_only=${cryptoOnly}&limit=25`);"
)
# 6. apiFetch klines
text = text.replace(
    "apiFetch(`/klines?symbol=${activeSymbol}&interval=${activeInterval}&limitapiFetch(`/klines?symbol=${activeSymbol}&interal=${activeInterval}&limit=300`);",
    "apiFetch(`/klines?symbol=${activeSymbol}&interval=${activeInterval}&limit=300`);"
)
# 7. WebSocket 
text = text.replace(
    "WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@kline_${WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowrCase()}@kline_${interval}`);",
    "WebSocket(`wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@kline_${interval}`);"
)

with open(filepath, 'w') as f:
    f.write(text)
print("Done")
