/* CONFIG */
const SERVER = window.location.origin;
const API    = SERVER + '/api';

const SYMBOLS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','DOTUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT'];
let SYMBOLS_WATCHLIST = [];
const LABELS  = {
    BTCUSDT:'BTC/USDT', ETHUSDT:'ETH/USDT', BNBUSDT:'BNB/USDT',
    SOLUSDT:'SOL/USDT', XRPUSDT:'XRP/USDT', ADAUSDT:'ADA/USDT',
    DOTUSDT:'DOT/USDT', AVAXUSDT:'AVAX/USDT', DOGEUSDT:'DOGE/USDT', 
LINKUSDT:'LINK/USDT'
};
const NAMES = {
    BTCUSDT:'BITCOIN', ETHUSDT:'ETHEREUM', BNBUSDT:'BNB', 
SOLUSDT:'SOLANA', XRPUSDT:'RIPPLE',
    ADAUSDT:'CARDANO', DOTUSDT:'POLKADOT', AVAXUSDT:'AVALANCHE', 
DOGEUSDT:'DOGECOIN', LINKUSDT:'CHAINLINK'
};

let activeSymbol   = 'BTCUSDT';
let activeInterval = '1h';
let chartType      = 'candle';
let serverOnline   = false;
let wasServerOnline = false;
let aiFilterEnabled = false;
let newsFilter = 'all';
let newsCache = [];
let aiSummaries = {};
let aiBusy = false;

const store = {};
SYMBOLS.forEach(s => {
    store[s] = { price: 0, chgPct: 0, chgAbs: 0, high: 0, low: 0, vol: 
0, open: 0 };
});

/* CLOCK */
setInterval(() => {
    const now = new Date();
    document.getElementById('clockEl').textContent = 
now.toUTCString().slice(5, 25) + ' UTC';
}, 1000);

/* FORMAT */
function fmtPrice(v, sym) {
    v = parseFloat(v);
    if (!v || isNaN(v)) return '—';
    if (sym && sym.startsWith('XRP')) return v.toFixed(4);
    if (sym && ['DOGEUSDT', 'SHIBUSDT'].includes(sym)) return 
v.toFixed(5);
    if (v >= 1000) return v.toLocaleString('en-US', 
{minimumFractionDigits:2, maximumFractionDigits:2});
    return v.toFixed(3);
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
}

/* SERVER */
async function checkServer() {
    try {
        const r = await fetch(SERVER + '/health', { signal: 
AbortSignal.timeout(3000) });
        if (r.ok) {
            const data = await r.json();
            serverOnline = true;
            document.getElementById('serverDot').className   = 
'server-dot online';
            document.getElementById('serverLabel').textContent = 'LIVE';
            document.getElementById('statusDot').style.background  = 
'var(--bloomberg-green)';
            document.getElementById('statusText').textContent = 
'Connected';

            if (data.ollama) {
                document.getElementById('aiBadge').classList.add('active');
                document.getElementById('aiStatus').textContent = 'AI ON';
            }
            if (!wasServerOnline) {
                if (activeTab === 'market') updateMarketDashboard();
                if (activeTab === 'whale') updateWhaleDashboard();
            }
            wasServerOnline = true;
            return true;
        }
    } catch(e) {
        console.log('Server offline, using public Binance API');
    }
    serverOnline = false;
    wasServerOnline = false;
    document.getElementById('serverDot').className    = 'server-dot offline';
    document.getElementById('serverLabel').textContent = 'SERVER OFFLINE';
    document.getElementById('statusDot').style.background = 
'var(--bloomberg-red)';
    document.getElementById('statusText').textContent = 'Disconnected (Binance)';
    return false;
}

async function apiFetch(path) {
    const r = await fetch(API + path, { signal: 
AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    document.getElementById('lastUpdate').textContent =
        'Last Update: ' + new Date().toLocaleTimeString();
    return r.json();
}

/* BINANCE PUBLIC API FALLBACK */
async function fetchBinanceTicker() {
    try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=["${SYMBOLS.join('","')}"]`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!r.ok) throw new Error('Binance API error');
        const data = await r.json();
        data.forEach(item => {
            const s = item.symbol;
            if (!store[s]) return;
            store[s].price  = parseFloat(item.lastPrice);
            store[s].chgPct = parseFloat(item.priceChangePercent);
            store[s].chgAbs = parseFloat(item.priceChange);
            store[s].high   = parseFloat(item.highPrice);
            store[s].low    = parseFloat(item.lowPrice);
            store[s].vol    = parseFloat(item.quoteVolume);
            store[s].open   = parseFloat(item.openPrice);
        });
        updateDOM();
        document.getElementById('lastUpdate').textContent =
            'Last Update: ' + new Date().toLocaleTimeString();
    } catch(e) {
        console.error('Binance ticker error:', e);
    }
}

async function fetchBinanceKlines(sym, interval, limit = 300) {
    try {
        const r = await fetch(
            `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`,
            { signal: AbortSignal.timeout(10000) }
        );
        if (!r.ok) throw new Error('Klines error');
        const data = await r.json();
        return data.map(c => ({
            time:  c[0],
            open:  parseFloat(c[1]),
            high:  parseFloat(c[2]),
            low:   parseFloat(c[3]),
            close: parseFloat(c[4])
        }));
    } catch(e) {
        console.error('Klines error:', e);
        return [];
    }
}

/* BUILD DOM */
function buildTicker() {
    const row = document.getElementById('tickerScroll');
    const items = SYMBOLS.map(sym => `
        <div class="ticker-item" data-ticker-item="${sym}" 
onclick="switchSymbol('${sym}')">
            <span class="ticker-symbol">${LABELS[sym]}</span>
            <span class="ticker-price"  data-tp="${sym}">—</span>
            <span class="ticker-change" data-tc="${sym}">—</span>
            <span class="ticker-change-percent" 
data-tpct="${sym}">—</span>
        </div>`).join('');
    row.innerHTML = items + items;
}

function buildMarketGrid() {
    document.getElementById('marketGrid').innerHTML = 
SYMBOLS.slice(0,4).map(sym => `
        <div class="market-card" onclick="switchSymbol('${sym}')">
            <div class="market-card-left">
                <div class="market-card-title">${NAMES[sym]}</div>
                <div class="market-card-change" data-mc="${sym}">
                    <svg width="10" height="10" viewBox="0 0 24 24" 
fill="none" stroke="currentColor" stroke-width="2" data-ma="${sym}">
                        <polyline points="18 15 12 9 6 15"/>
                    </svg>
                    <span data-mt="${sym}">—</span>
                </div>
            </div>
            <div class="market-card-value" data-mv="${sym}">—</div>
        </div>`).join('');
}

function buildWatchlist() {
    const grid = document.getElementById('watchlistGrid');
    if (!grid) return;
    if (SYMBOLS_WATCHLIST.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px; font-size:11px;">No cryptos in watchlist.<br>Click + to add.</div>';
        return;
    }
    grid.innerHTML = SYMBOLS_WATCHLIST.map(sym => `
        <div class="watchlist-item" data-wl-item="${sym}" onclick="switchSymbol('${sym}')">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 4px;">
                <div style="display:flex; flex-direction:column; gap:2px;">
                    <span style="font-size:12px; font-weight:800; color:var(--text-primary); letter-spacing:0.5px;">${LABELS[sym] ? LABELS[sym].split('/')[0] : sym}</span>
                    <span style="font-size:9px; color:var(--text-muted);">Vol 24h</span>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
                    <span class="watchlist-badge" data-wb="${sym}">—</span>
                </div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                <div style="display:flex; flex-direction:column; gap:1px;">
                    <div class="watchlist-price" style="font-size:14px; font-weight:700; margin-bottom:0;" data-wp="${sym}">—</div>
                    <div class="watchlist-change" style="font-size:10px;" data-wc="${sym}">—</div>
                </div>
                <!-- Sparkline Canvas container -->
                <div style="width: 55px; height: 25px; margin-left:8px; opacity: 0.8;">
                    <canvas class="wl-sparkline" width="110" height="50" style="width:55px; height:25px;" data-wscanvas="${sym}"></canvas>
                </div>
            </div>
        </div>`).join('');
}

function buildMovers() {
    const table = document.getElementById('moversTable');
    if (!table) return;
    table.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:20px;">Loading...</td></tr>';
}

function buildCalendar() {
    document.getElementById('calendarContent').innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:12px 0;">Loading market events...</div>';
}

function renderCalendar(events) {
    const el = document.getElementById('calendarContent');
    if (!events || !events.length) {
        el.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:12px 0;">No market events available</div>';
        return;
    }
    el.innerHTML = events.map(e => {
        const impact = Number(e.impact || 1);
        const lvl = impact === 3 ? 'high' : impact === 2 ? 'medium' : 'low';
        const dots = [0, 1, 2].map(i => `<span class="impact-dot ${i < impact ? lvl : ''}"></span>`).join('');
        const title = e.source ? `${e.name} (${e.source})` : e.name;
        const linkStart = e.url ? `<a href="${e.url}" target="_blank" style="color:inherit;text-decoration:none;">` : '';
        const linkEnd = e.url ? '</a>' : '';
        return `<div class="calendar-event">
            <span class="calendar-time">${e.time || '--:--'}</span>
            <span class="calendar-country">${e.country || 'GL'}</span>
            <span class="calendar-event-name">${linkStart}${title}${linkEnd}</span>
            <div class="calendar-impact">${dots}</div>
        </div>`;
    }).join('');
}

async function fetchMarketEvents() {
    if (!serverOnline) {
        document.getElementById('calendarContent').innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:12px 0;">Connect server for live market events</div>';
        return;
    }
    try {
        const data = await apiFetch('/events?limit=7');
        renderCalendar(data.events || []);
    } catch (e) {
        console.error('Market events error:', e);
        document.getElementById('calendarContent').innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:12px 0;">Failed to load market events</div>';
    }
}

/* UPDATE DOM */
function updateDOM() {
    SYMBOLS.forEach(sym => {
        const d = store[sym];
        const up = d.chgPct >= 0;
        const sgn = up ? '+' : '';
        const pos = up ? 'positive' : 'negative';
        const pStr = '$' + fmtPrice(d.price, sym);
        const pctStr = sgn + d.chgPct.toFixed(2) + '%';

        const tp = document.querySelector(`[data-tp="${sym}"]`);
        if (tp) {
            tp.textContent = pStr;
            const tc = document.querySelector(`[data-tc="${sym}"]`);
            tc.textContent = sgn + d.chgPct.toFixed(2);
            tc.className = 'ticker-change ' + pos;
            const tpct = document.querySelector(`[data-tpct="${sym}"]`);
            tpct.textContent = pctStr;
            tpct.className = 'ticker-change-percent ' + pos;
        }

        const mv = document.querySelector(`[data-mv="${sym}"]`);
        if (mv) {
            mv.textContent = pStr;
            const mc = document.querySelector(`[data-mc="${sym}"]`);
            mc.className = 'market-card-change ' + pos;
            const mt = document.querySelector(`[data-mt="${sym}"]`);
            mt.textContent = sgn + d.chgPct.toFixed(2) + '%';
            const arrow = document.querySelector(`[data-ma="${sym}"] polyline`);
            if (arrow) arrow.setAttribute('points', up ? '18 15 12 9 6 15' : '6 9 12 15 18 9');
        }

        const wb = document.querySelector(`[data-wb="${sym}"]`);
        if (wb) {
            wb.textContent = pctStr;
            wb.className = 'watchlist-badge ' + pos;
            const wp = document.querySelector(`[data-wp="${sym}"]`);
            const wc = document.querySelector(`[data-wc="${sym}"]`);
            wc.textContent = sgn + d.chgPct.toFixed(2) + '% today';
            wc.className = 'watchlist-change ' + pos;

            const item = document.querySelector(`[data-wl-item="${sym}"]`);
            if (item) {
                item.className = 'watchlist-item' + (sym === activeSymbol ? ' active' : '');
                
                // Track previous price to trigger flash animations
                if (d.lastRenderPrice && d.price !== d.lastRenderPrice) {
                    item.classList.remove('flash-up', 'flash-down');
                    void item.offsetWidth; // trigger reflow
                    item.classList.add(d.price > d.lastRenderPrice ? 'flash-up' : 'flash-down');
                }
                d.lastRenderPrice = d.price;
            }

            // Draw advanced sparkline
            const canvas = document.querySelector(`[data-wscanvas="${sym}"]`);
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                let cx = 0; 
                let cy = up ? 40 : 10;
                ctx.beginPath();
                ctx.moveTo(cx, cy);

                // Generate simulated jagged drift
                Math.seedrandom ? Math.seedrandom(sym + d.price) : null; // Consistentish drift per price point
                for (let i=1; i<10; i++) {
                    cx += 11;
                    let drift = (up ? -3 : 3) + ((Math.sin(d.price + i) * 15));
                    cy = Math.max(5, Math.min(45, cy + drift));
                    ctx.lineTo(cx, cy);
                }
                ctx.lineTo(110, up ? 10 : 40);

                ctx.strokeStyle = up ? '#4AF6C3' : '#FF433D';
                ctx.lineWidth = 2.5;
                ctx.lineJoin = 'round';
                ctx.stroke();

                // Gradient Fill
                ctx.lineTo(110, 50);
                ctx.lineTo(0, 50);
                const grad = ctx.createLinearGradient(0, 0, 0, 50);
                grad.addColorStop(0, up ? 'rgba(74,246,195,0.3)' : 'rgba(255,67,61,0.3)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                ctx.fill();
            }
            if (wp) wp.textContent = pStr;
        }
    });

    const d = store[activeSymbol];
    const up = d.chgPct >= 0;
    const sgn = up ? '+' : '';
    document.getElementById('chartPrice').textContent = '$' + 
fmtPrice(d.price, activeSymbol);
    const chgEl = document.getElementById('chartChg');
    chgEl.textContent = sgn + d.chgPct.toFixed(2) + '%';
    chgEl.className = 'chart-chg ' + (up ? 'positive' : 'negative');
}

function updateMovers(data) {
    const gainers = data.gainers || data || [];
    const tbody = document.getElementById('moversTable');
    if (!tbody) return;
    if (!gainers.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted);text-align:center;padding:20px;">No data available</td></tr>';
        return;
    }
    tbody.innerHTML = gainers.slice(0, 10).map(item => {
        const sym = item.symbol || item.s || 'UNKNOWN';
        const price = parseFloat(item.lastPrice || item.c || 0);
        const chg = parseFloat(item.priceChangePercent || item.p || 0);
        const up = chg >= 0;
        const pos = up ? 'change-positive' : 'change-negative';
        const sgn = up ? '+' : '';
        return `<tr onclick="switchSymbol('${sym}')">
            <td><span class="stock-symbol">${sym.replace('USDT','')}</span></td>
            <td class="price">$${fmtPrice(price, sym)}</td>
            <td class="${pos}">${sgn}${chg.toFixed(2)}</td>
            <td class="${pos}">${sgn}${chg.toFixed(2)}%</td>
        </tr>`;
    }).join('');
}

/* NEWS */
async function fetchNews() {
    const container = document.getElementById('newsContainer');
    container.innerHTML = `
        <div class="news-loading">
            <div class="news-loading-spinner"></div>
            <span>Fetching live news...</span>
        </div>`;

    if (!serverOnline) {
        container.innerHTML = `<div 
style="color:var(--text-muted);text-align:center;padding:40px;">
            <p style="font-size:11px">Server offline.<br>Connect to 
the terminal server for news.</p>
        </div>`;
        return;
    }

    try {
        const data = await apiFetch('/news?limit=25');

        newsCache = data.news || [];
        renderNews(newsCache);
        fetchSentiment();
    } catch(e) {
        console.error('News fetch error:', e);
        container.innerHTML = `
            <div 
style="color:var(--text-muted);text-align:center;padding:40px;">
                <p style="font-size:11px">Failed to load news.<br>Check 
server connection.</p>
            </div>`;
    }
}

async function fetchSentiment() {
    try {
        const data = await apiFetch('/news/sentiment');
        const score = data.score || 50;
        const sentiment = data.sentiment || 'Neutral';

        const fill = document.getElementById('sentimentFill');
        const value = document.getElementById('sentimentValue');

        fill.style.width = score + '%';
        value.textContent = Math.round(score) + '%';

        if (sentiment === 'Bullish') {
            fill.style.background = 'var(--bloomberg-green)';
            value.className = 'sentiment-value bullish';
        } else if (sentiment === 'Bearish') {
            fill.style.background = 'var(--bloomberg-red)';
            value.className = 'sentiment-value bearish';
        } else {
            fill.style.background = 'var(--bloomberg-amber)';
            value.className = 'sentiment-value neutral';
        }
    } catch(e) {
        console.error('Sentiment error:', e);
    }
}

function renderNews(news) {
    const container = document.getElementById('newsContainer');

    if (!news || news.length === 0) {
        container.innerHTML = `<div 
style="color:var(--text-muted);text-align:center;padding:40px;"><p 
style="font-size:11px">No news available</p></div>`;
        return;
    }

    container.innerHTML = news.map((item, idx) => {
        const currencies = item.currencies || [];
        const currenciesHtml = currencies.slice(0, 3).map(c => `<span class="news-currency-tag">${c}</span>`).join('');
        const summary = aiSummaries[item.id] || '';
        const summaryClass = summary ? ' news-summary ai' : 'news-summary';

        return `
            <div class="news-item" onclick="openNewsModal(${idx})">
                <div class="news-meta">
                    <span class="news-source">${item.source || 
'News'}</span>
                    <span 
class="news-time">${timeAgo(item.published_at)}</span>
                    ${currenciesHtml ? `<div 
class="news-currencies">${currenciesHtml}</div>` : ''}
                </div>
                <div class="news-headline">
                    <a href="${item.url}" target="_blank" 
onclick="event.stopPropagation()">${item.title}</a>
                </div>
                ${summary ? `<div 
class="${summaryClass}">${summary}</div>` : ''}
            </div>`;
    }).join('');
}

function openNewsModal(idx) {
    const item = newsCache[idx];
    if (!item) return;

    document.getElementById('modalTitle').textContent = item.title;
    document.getElementById('modalSource').textContent = item.source || 
'News Source';
    document.getElementById('modalTime').textContent = item.published_at 
? new Date(item.published_at).toLocaleString() : '';
    document.getElementById('modalLink').href = item.url;
    document.getElementById('newsModal').classList.add('open');

    if (serverOnline) getAISummary(idx);
}

async function getAISummary(idx) {
    const item = newsCache[idx];
    if (!item || aiSummaries[item.id]) return;

    try {
        const data = await fetch(API + '/news/summary', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: item.title, url: item.url })
        }).then(r => r.json());

        if (data.summary) {
            aiSummaries[item.id] = data.summary;
            renderNews(newsCache);
        }
    } catch(e) {
        console.error('AI summary error:', e);
    }
}

function closeNewsModal() {
    document.getElementById('newsModal').classList.remove('open');
}

function setNewsFilter(filter) {
    newsFilter = filter;
    document.getElementById('btnAllNews').classList.toggle('active', 
filter === 'all');
    document.getElementById('btnCryptoNews').classList.toggle('active', 
filter === 'crypto');
    fetchNews();
}

function toggleAIFilter() {
    aiFilterEnabled = !aiFilterEnabled;
    document.getElementById('btnAIFilter').classList.toggle('active', 
aiFilterEnabled);
    fetchNews();
}

function addChatMessage(role, text) {
    const chat = document.getElementById('chatMessages');
    if (!chat) return;
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function clearAIChat() {
    const chat = document.getElementById('chatMessages');
    if (!chat) return;
    chat.innerHTML = '<div class="message system">Model: minimax-m2.7 (cloud)</div>';
}

async function sendAIQuery(rawQuery) {
    const input = document.getElementById('chatInput');
    const btn = document.getElementById('chatSendBtn');
    const query = (rawQuery || (input ? input.value : '') || '').trim();
    if (!query || aiBusy) return;
    aiBusy = true;
    if (btn) btn.disabled = true;
    if (input) input.value = '';
    addChatMessage('user', query);

    try {
        const r = await fetch(API + '/ai/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, symbol: activeSymbol })
        });
        const data = await r.json();
        addChatMessage('ai', data.answer || data.error || 'No response');
    } catch (e) {
        addChatMessage('system', 'AI request failed. Check server/model connection.');
    } finally {
        aiBusy = false;
        if (btn) btn.disabled = false;
    }
}

function setActiveTab(tab) {
    const views = {
        'home':   document.getElementById('homeView'),
        'ai':     document.getElementById('aiView'),
        'bot':    document.getElementById('botView'),
        'market': document.getElementById('marketView'),
        'whale':  document.getElementById('whaleView')
    };
    
    // Update nav links
    document.querySelectorAll('.nav-links .nav-link[data-tab]').forEach(n => {
        n.classList.toggle('active', n.dataset.tab === tab);
    });

    // Update sidebar icons
    document.querySelectorAll('.sidebar-icon').forEach(icon => {
        icon.classList.remove('active');
    });
    // Find icons by mapping or simple index for demo
    const icons = document.querySelectorAll('.sidebar-icon');
    if (tab === 'home' && icons[0]) icons[0].classList.add('active');
    if (tab === 'bot') {
        document.getElementById('btnBotView').classList.add('active');
    }
    if (tab === 'whale') {
        const w = Array.from(icons).find(i => i.title === 'Whale Watch');
        if (w) w.classList.add('active');
    }

    // Show/Hide views
    Object.keys(views).forEach(v => {
        if (views[v]) {
            views[v].classList.toggle('hidden', v !== tab);
        }
    });

    if (tab === 'market') {
        updateMarketDashboard();
    }
    if (tab === 'bot') {
        updateBotDashboard();
    }
    if (tab === 'whale') {
        updateWhaleDashboard();
    }
}

document.querySelectorAll('.nav-links .nav-link[data-tab]').forEach(link => {
    link.addEventListener('click', e => {
        e.preventDefault();
        setActiveTab(link.dataset.tab || 'home');
    });
});

document.getElementById('newsModal').addEventListener('click', 
function(e) {
    if (e.target === this) closeNewsModal();
});

/* WATCHLIST CUSTOM LOGIC */
function openMarketForAdd() {
    setActiveTab('market');
    const search = document.getElementById('searchInput');
    if (search) {
        search.focus();
        search.placeholder = "Type symbol (e.g. LINKUSDT) to add...";
        search.style.borderColor = "var(--bloomberg-orange)";
        // Scroll to search area (top of terminal-container)
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

function addToWatchlist(symbol) {
    symbol = symbol.toUpperCase().trim();
    if (!symbol) return;
    if (!SYMBOLS_WATCHLIST.includes(symbol)) {
        SYMBOLS_WATCHLIST.push(symbol);
        if (!SYMBOLS.includes(symbol)) SYMBOLS.push(symbol);
        
        // Ensure store entry exists
        if (!store[symbol]) {
            store[symbol] = { price: 0, chgPct: 0, chgAbs: 0, high: 0, low: 0, vol: 0, open: 0 };
        }
        
        buildWatchlist();
        fetchTicker(); // Refresh data
        addChatMessage('system', `Added ${symbol} to watchlist.`);
    } else {
        addChatMessage('system', `${symbol} is already in your watchlist.`);
    }
}

// Update search listener to handle adding to watchlist if specifically requested via button flow
document.getElementById('searchInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') {
        const val = e.target.value.toUpperCase().trim();
        if (val) {
            // Check if we came from "Add Crypto" button
            if (e.target.placeholder.includes("add")) {
                addToWatchlist(val);
                e.target.placeholder = "Search symbol (e.g. AVAX) then Enter";
                e.target.style.borderColor = "var(--border-color)";
            } else {
                switchSymbol(val);
            }
            e.target.value = '';
        }
    }
});
async function fetchTicker() {
    if (serverOnline) {
        try {
            const data = await apiFetch('/ticker/24hr?symbols=' + 
SYMBOLS.join(','));
            data.forEach(item => {
                const s = item.symbol;
                if (!store[s]) return;
                store[s].price  = parseFloat(item.lastPrice);
                store[s].chgPct = parseFloat(item.priceChangePercent);
                store[s].chgAbs = parseFloat(item.priceChange);
                store[s].high   = parseFloat(item.highPrice);
                store[s].low    = parseFloat(item.lowPrice);
                store[s].vol    = parseFloat(item.quoteVolume);
                store[s].open   = parseFloat(item.openPrice);
            });
            updateDOM();
        } catch(e) {
            console.error('Server ticker failed, using Binance:', e);
            await fetchBinanceTicker();
        }
    } else {
        await fetchBinanceTicker();
    }
}

async function fetchTopMovers() {
    const fetchBinanceTopMovers = async () => {
        const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOTUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT"]', {
            signal: AbortSignal.timeout(5000)
        });
        const data = await r.json();
        const sorted = data.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));
        updateMovers(sorted);
    };

    if (!serverOnline) {
        try {
            await fetchBinanceTopMovers();
        } catch(e) {
            console.error('Top movers error:', e);
        }
        return;
    }
    try {
        const data = await apiFetch('/ticker/top');
        updateMovers(data);
    } catch(e) {
        console.error('fetchTopMovers:', e);
        await fetchBinanceTopMovers();
    }
}


// /* CHART */
let lwChart = null, candleSeries = null, lineSeries = null;

function initChart() {
    const el = document.getElementById('lwChart');
    lwChart = LightweightCharts.createChart(el, {
        layout:    { background: { color: '#111111' }, textColor: '#666' 
},
        grid:      { vertLines: { color: '#1e1e1e' }, horzLines: { 
color: '#1e1e1e' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2a2a2a' },
        timeScale: { borderColor: '#2a2a2a', timeVisible: true, 
secondsVisible: false },
    });
    const ro = new ResizeObserver(() => {
        if (lwChart && el.clientWidth && el.clientHeight) {
            lwChart.applyOptions({ width: el.clientWidth, height: 
el.clientHeight });
        }
    });
    ro.observe(el);
    lwChart.applyOptions({ width: el.clientWidth, height: 
el.clientHeight });
}

function clearSeries() {
    if (candleSeries) { lwChart.removeSeries(candleSeries); candleSeries 
= null; }
    if (lineSeries)   { lwChart.removeSeries(lineSeries);   lineSeries   
= null; }
}

async function loadChart() {
    try {
        let data;
        if (serverOnline) {
            try {
                data = await apiFetch(`/klines?symbol=${activeSymbol}&interval=${activeInterval}&limit=300`);
            } catch(e) {
                console.error('Server klines failed, using Binance:', 
e);
                data = await fetchBinanceKlines(activeSymbol, 
activeInterval);
            }
        } else {
            data = await fetchBinanceKlines(activeSymbol, 
activeInterval);
        }
        
        clearSeries();
        if (!data || !data.length) {
            console.warn('No chart data available');
            return;
        }
        
        if (chartType === 'candle') {
            candleSeries = lwChart.addCandlestickSeries({
                upColor:'#4AF6C3', downColor:'#FF433D',
                borderUpColor:'#4AF6C3', borderDownColor:'#FF433D',
                wickUpColor:'#4AF6C3', wickDownColor:'#FF433D',
            });
            candleSeries.setData(data.map(c => ({
                time: Math.floor(c.time/1000),
                open: c.open, high: c.high, low: c.low, close: c.close
            })));
        } else {
            lineSeries = lwChart.addLineSeries({ color:'#0068FF', 
lineWidth:2 });
            lineSeries.setData(data.map(c => ({
                time: Math.floor(c.time/1000), value: c.close
            })));
        }
        lwChart.timeScale().fitContent();
        if (data.length) {
            const last = data[data.length-1];
            store[activeSymbol].price = last.close;
            updateDOM();
        }
    } catch(e) { console.error('loadChart:', e); }
}

/* WEBSOCKETS */
let wsKline = null, wsTicker = null;

function openKlineStream(sym, interval) {
    if (wsKline) { wsKline.close(); wsKline = null; }
    const symbol = sym.toLowerCase();
    wsKline = new WebSocket(`wss://stream.binance.com:9443/ws/${symbol}@kline_${interval}`);
    wsKline.onmessage = evt => {
        try {
            const k = JSON.parse(evt.data).k;
            const candle = {
                time: Math.floor(k.t/1000),
                open: parseFloat(k.o), high: parseFloat(k.h),
                low:  parseFloat(k.l), close: parseFloat(k.c),
            };
            if (chartType === 'candle' && candleSeries) 
candleSeries.update(candle);
            if (chartType === 'line'   && lineSeries)   
lineSeries.update({ time: candle.time, value: candle.close });
            store[sym].price = candle.close;
            if (sym === activeSymbol) {
                document.getElementById('chartPrice').textContent = '$' 
+ fmtPrice(candle.close, sym);
            }
        } catch(e) {
            console.error('Kline parse error:', e);
        }
    };
    wsKline.onerror = (e) => console.error('Kline WebSocket error:', e);
    wsKline.onclose = () => {
        if (activeSymbol === sym && activeInterval === interval) {
            setTimeout(() => openKlineStream(sym, interval), 3000);
        }
    };
}

function openTickerStream() {
    if (wsTicker) { wsTicker.close(); wsTicker = null; }
    const streams = SYMBOLS.map(s => s.toLowerCase() + 
'@miniTicker').join('/');
    wsTicker = new 
WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
    wsTicker.onmessage = evt => {
        try {
            const d = JSON.parse(evt.data).data;
            if (!d || !store[d.s]) return;
            const s = d.s;
            const open  = parseFloat(d.o);
            const close = parseFloat(d.c);
            store[s].price  = close;
            store[s].open   = open;
            store[s].high   = parseFloat(d.h);
            store[s].low    = parseFloat(d.l);
            store[s].vol    = parseFloat(d.q);
            store[s].chgPct = open > 0 ? ((close - open) / open) * 100 : 
0;
            store[s].chgAbs = close - open;
            updateDOM();
        } catch(e) {
            console.error('Ticker parse error:', e);
        }
    };
    wsTicker.onerror = (e) => console.error('Ticker WebSocket error:', 
e);
    wsTicker.onclose = () => setTimeout(openTickerStream, 3000);
}

/* SWITCH SYMBOL */
function switchSymbol(sym) {
    activeSymbol = sym;
    document.getElementById('chartSym').textContent = LABELS[sym];
    document.getElementById('chartPanelTitle').textContent = LABELS[sym];
    updateDOM();
    loadChart();
    openKlineStream(sym, activeInterval);
}

/* CONTROLS */
document.querySelectorAll('[data-interval]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-interval]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeInterval = btn.dataset.interval;
        loadChart();
        openKlineStream(activeSymbol, activeInterval);
    });
});

document.getElementById('btnCandle').addEventListener('click', () => {
    if (chartType === 'candle') return;
    chartType = 'candle';
    document.getElementById('btnCandle').classList.add('active');
    document.getElementById('btnLine').classList.remove('active');
    loadChart();
});

document.getElementById('btnLine').addEventListener('click', () => {
    if (chartType === 'line') return;
    chartType = 'line';
    document.getElementById('btnLine').classList.add('active');
    document.getElementById('btnCandle').classList.remove('active');
    loadChart();
});

document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const raw = e.target.value.trim().toUpperCase();
    if (!raw) return;
    const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
    if (!SYMBOLS.includes(sym)) {
        SYMBOLS.push(sym);
        LABELS[sym] = raw.endsWith('USDT') ? raw : raw + '/USDT';
        NAMES[sym]  = raw.replace('USDT','');
        store[sym]  = { price:0, chgPct:0, chgAbs:0, high:0, low:0, vol:0, open:0 };
        buildTicker(); buildMarketGrid(); buildWatchlist();
    }
    e.target.value = '';
    switchSymbol(sym);
    fetchTicker();
});

document.getElementById('chatInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendAIQuery();
});

/* INIT */
async function init() {
    // Build UI first
    buildTicker();
    buildMarketGrid();
    buildWatchlist();
    buildMovers();
    buildCalendar();
    initChart();
    
    // Check server status
    await checkServer();
    
    // Load data (works with or without server)
    await Promise.all([
        fetchTicker(),
        fetchTopMovers(),
        serverOnline ? fetchNews() : Promise.resolve(),
        fetchMarketEvents(),
        serverOnline ? updateMarketDashboard() : Promise.resolve(),
        serverOnline ? updateWhaleDashboard() : Promise.resolve(),
        serverOnline ? updateDashboardIntel() : Promise.resolve()
    ]);
    
    // Load chart and start WebSockets (uses Binance directly)
    await loadChart();
    openTickerStream();
    openKlineStream(activeSymbol, activeInterval);
    
    // Set up intervals
    setInterval(checkServer, 30000);
    setInterval(() => { fetchTicker(); fetchTopMovers(); }, 30000);
    setInterval(fetchMarketEvents, 180000);
    setInterval(fetchNews, 120000);
    setInterval(() => {
    // Refresh the 4-blocks dashboard intel if we are on home tab
    if (activeTab === 'home') {
        updateDashboardIntel();
    }
}, 30000);
}

init();
/* BOT LOGIC */
async function updateBotDashboard() {
    if (!serverOnline) return;
    try {
        const [status, signals, logs] = await Promise.all([
            apiFetch('/bot/status'),
            apiFetch('/bot/signals'),
            apiFetch('/bot/logs')
        ]);
        
        renderBots(status.bots);
        renderSignals(signals.signals);
        renderLogs(logs.logs);
    } catch (e) {
        console.error('Bot dashboard error:', e);
    }
}

function renderBots(bots) {
    const container = document.getElementById('botsList');
    if (!container) return;
    container.innerHTML = bots.map(bot => `
        <div class="bot-card" style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div style="font-size:12px; font-weight:700;">${bot.name}</div>
                <div style="font-size:10px; color:var(--text-muted);">ID: ${bot.id.toUpperCase()}</div>
            </div>
            <div style="text-align:right;">
                <div style="font-size:12px; color:var(--bloomberg-green); font-weight:700;">${bot.profit}</div>
                <span class="bot-status-tag status-${bot.status}">${bot.status}</span>
            </div>
        </div>
    `).join('');
}

function renderSignals(signals) {
    const container = document.getElementById('analyzerContainer');
    if (!container) return;
    container.innerHTML = signals.map(s => `
        <div class="signal-gauge">
            <div class="signal-label">${s.symbol}/USDT</div>
            <div style="display:flex; gap:15px; align-items:center;">
                <div style="font-size:10px; color:var(--text-muted);">RSI: ${s.rsi}</div>
                <div class="signal-value signal-${s.signal.toLowerCase()}">${s.signal}</div>
            </div>
        </div>
    `).join('');
}

function renderLogs(logs) {
    const container = document.getElementById('botLogs');
    if (!container) return;
    container.innerHTML = logs.map(l => `
        <div class="log-entry">
            <span class="log-time">[${l.time}]</span>
            <span class="log-bot">${l.bot}:</span>
            <span class="log-msg">${l.msg}</span>
        </div>
    `).join('');
}

async function runBacktest(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'SIMULATING...';
    
    const strategy = document.getElementById('btStrategy').value;
    const symbol = document.getElementById('btSymbol').value;
    const days = document.getElementById('btDays').value;
    
    try {
        const res = await fetch(API + '/bot/backtest', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ strategy, symbol, days })
        }).then(r => r.json());
        
        document.getElementById('btResults').innerHTML = `
            <div class="bot-card" style="border-color: var(--bloomberg-orange);">
                <div style="font-size:11px; font-weight:700; color:var(--bloomberg-orange); margin-bottom:10px;">RESULTS: ${res.strategy}</div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:11px;">
                    <div>Profit: <span style="color:${res.profit_pct >=0 ? 'var(--bloomberg-green)' : 'var(--bloomberg-red)'}">${res.profit_pct}%</span></div>
                    <div>Win Rate: ${res.win_rate}</div>
                    <div>Trades: ${res.total_trades}</div>
                    <div>Max DD: ${res.max_drawdown}</div>
                </div>
            </div>
        `;
    } catch (e) {
            alert('Backtest failed. Check server.');
    } finally {
        btn.disabled = false;
        btn.textContent = 'RUN SIMULATION';
    }
}
/* MARKET TERMINAL LOGIC */
let currentMarketData = [];
let currentCategory = 'all';
let marketSort = { key: 'mcap', dir: -1 };

async function updateMarketDashboard() {
    if (!serverOnline) {
        document.getElementById('marketTableBody').innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Connect to server for full market data terminal.</td></tr>';
        return;
    }
    await Promise.all([
        fetchMarketGlobal(),
        fetchMarketList(currentCategory)
    ]);
}

async function fetchMarketGlobal() {
    try {
        const data = await apiFetch('/market/global');
        document.getElementById('mTotalCap').textContent = data.total_mcap || '—';
        document.getElementById('mTotalVol').textContent = data.vol_24h || '—';
        document.getElementById('mBtcDom').textContent   = data.btc_dom || '—';
        document.getElementById('mEthDom').textContent   = data.eth_dom || '—';
        document.getElementById('mActiveCoins').textContent = data.active_coins || '—';
    } catch (e) {
        console.error('Global stats error:', e);
    }
}

async function fetchMarketList(category) {
    const tbody = document.getElementById('marketTableBody');
    try {
        currentMarketData = await apiFetch(`/market/list?category=${category}`);
        if (!currentMarketData || currentMarketData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--text-muted)">No data found for this category.</td></tr>';
            return;
        }
        renderMarketTable();
    } catch (e) {
        console.error('Market list error:', e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--bloomberg-red)">Failed to load data: ${e.message}</td></tr>`;
    }
}

function renderMarketTable() {
    const tbody = document.getElementById('marketTableBody');
    if (!tbody) return;
    
    const mSync = document.getElementById('mSync');
    if (mSync) mSync.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    // Sort logic
    const sorted = [...currentMarketData].sort((a, b) => {
        let v1 = a[marketSort.key];
        let v2 = b[marketSort.key];
        return (v1 < v2 ? -1 : 1) * marketSort.dir;
    });

    tbody.innerHTML = sorted.map(coin => {
        const isStarred = SYMBOLS_WATCHLIST.includes(coin.symbol);
        const sparkPath = renderSparkline(coin.sparkline, coin.chg_7d >= 0);
        return `
        <tr onclick="selectMarketCoin('${coin.symbol}')" class="${activeSymbol === coin.symbol ? 'selected' : ''}">
            <td>
                <span class="m-star ${isStarred ? 'active' : ''}" 
onclick="toggleWatchlist('${coin.symbol}', event)">${isStarred ? '★' : '☆'}</span>
            </td>
            <td class="m-rank">${coin.rank}</td>
            <td>
                <div class="m-sym">${coin.name}</div>
                <div style="font-size:9px; color:var(--text-muted)">${coin.symbol}</div>
            </td>
            <td class="m-price">$${formatPrice(coin.price)}</td>
            <td class="${coin.chg_24h >= 0 ? 'm-up' : 'm-down'}">${coin.chg_24h > 0 ? '+' : ''}${coin.chg_24h}%</td>
            <td class="${coin.chg_7d >= 0 ? 'm-up' : 'm-down'}">${coin.chg_7d > 0 ? '+' : ''}${coin.chg_7d}%</td>
            <td class="m-mcap">$${formatLargeNumber(coin.mcap)}</td>
            <td class="m-vol">$${formatLargeNumber(coin.volume)}</td>
            <td>
                <svg width="100" height="20" style="overflow:visible">
                    <path d="${sparkPath}" fill="none" stroke="${coin.chg_7d >= 0 ? 'var(--bloomberg-green)' : 'var(--bloomberg-red)'}" stroke-width="1.5" />
                </svg>
            </td>
        </tr>
`;
    }).join('');
}

function renderSparkline(prices, isPositive) {
    if (!prices || prices.length < 2) return "M 0 10 L 100 10";
    const width = 100;
    const height = 20;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    
    return prices.map((p, i) => {
        const x = (i / (prices.length - 1)) * width;
        const y = height - ((p - min) / range) * height;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
}

function formatPrice(p) {
    if (p >= 1) return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p > 0.01) return p.toFixed(4);
    return p.toFixed(8);
}

function formatLargeNumber(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
    return n.toLocaleString();
}

function sortMarket(key) {
    if (marketSort.key === key) {
        marketSort.dir *= -1;
    } else {
        marketSort.key = key;
        marketSort.dir = -1;
    }
    renderMarketTable();
}

function loadMarketCategory(cat, el) {
    currentCategory = cat;
    document.querySelectorAll('.menu-cat').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    fetchMarketList(cat);
}

function selectMarketCoin(symbol) {
    if (!symbol) return;
    switchSymbol(symbol);
    renderMarketTable(); // Update selection styling
    addChatMessage('system', `Market context switched to ${symbol}`);
}

function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    if (SYMBOLS_WATCHLIST.includes(symbol)) {
        SYMBOLS_WATCHLIST = SYMBOLS_WATCHLIST.filter(s => s !== symbol);
        addChatMessage('system', `Removed ${symbol} from watchlist.`);
    } else {
        SYMBOLS_WATCHLIST.push(symbol);
        if (!SYMBOLS.includes(symbol)) SYMBOLS.push(symbol);
        if (!store[symbol]) {
            store[symbol] = { price: 0, chgPct: 0, chgAbs: 0, high: 0, low: 0, vol: 0, open: 0 };
        }
        addChatMessage('system', `Added ${symbol} to watchlist.`);
    }
    buildWatchlist();
    renderMarketTable(); 
    fetchTicker(); // Get price for new entry
}

let marketRefreshInterval = null;
function startMarketAutoRefresh() {
    if (marketRefreshInterval) clearInterval(marketRefreshInterval);
    marketRefreshInterval = setInterval(() => {
        if (activeTab === 'market') {
            updateMarketDashboard();
        }
    }, 60000);
}

// Update setActiveTab to track the current tab globally for refresh logic
let activeTab = 'home';
const originalSetActiveTab = setActiveTab;
setActiveTab = function(tab) {
    activeTab = tab;
    originalSetActiveTab(tab);
    if (tab === 'market') startMarketAutoRefresh();
    if (tab === 'whale') updateWhaleDashboard();
}

// ================= WHALE WATCH LOGIC =================
async function updateWhaleDashboard() {
    if (!serverOnline) {
        document.getElementById('whaleTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">Connect to server for on-chain whale tracking.</td></tr>';
        return;
    }
    try {
        const [topWallets, alertData, instData] = await Promise.all([
            apiFetch('/wallets/top'),
            apiFetch('/wallets/alerts'),
            apiFetch('/wallets/institutions')
        ]);
        renderWhaleTable(topWallets);
        renderWhaleIntel(instData, alertData.exchange_flows);
        renderWhaleAlerts(alertData.alerts);
    } catch (e) {
        console.error('Whale watch error:', e);
    }
}

function renderWhaleIntel(institutions, exchanges) {
    const instList = document.getElementById('whaleInstList');
    const exchList = document.getElementById('whaleExchList');
    if (!instList || !exchList) return;
    
    // Render Institutions
    instList.innerHTML = institutions.map(i => `
        <div class="intel-card">
            <div class="intel-label" style="display:flex; justify-content:space-between;">
                <span>${i.name}</span>
                <span class="badge ${i.stance === 'LONG' ? 'badge-in' : (i.stance === 'SHORT' ? 'badge-out' : 'badge-btc')}" style="font-size:7px">${i.stance}</span>
            </div>
            <div class="intel-val ${i.inflow.startsWith('+') ? 'm-up' : 'm-down'}">${i.inflow} <span style="font-size:8px; color:var(--text-muted); font-weight:normal;">Net Flow</span></div>
            
            <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:2px;">
                <span>Vol: <span style="color:var(--text-primary)">${i.vol}</span></span>
                <span>Pos: <span style="color:var(--text-primary)">${i.position}</span></span>
            </div>
            
            <div style="font-size:8px; font-weight:900; margin-top:4px; color:${i.status === 'ACCUMULATING' ? 'var(--bloomberg-green)' : 'var(--text-muted)'}">${i.status}</div>
        </div>
    `).join('');
    
    // Render Exchanges
    exchList.innerHTML = exchanges.map(ex => `
        <div class="intel-card" style="border-left: 2px solid ${ex.sentiment === 'BULLISH' ? 'var(--bloomberg-green)' : 'var(--bloomberg-red)'}">
            <div class="intel-label" style="display:flex; justify-content:space-between;">
                <span>${ex.exchange}</span>
                <span class="badge ${ex.sentiment === 'BULLISH' ? 'badge-in' : 'badge-out'}" style="font-size:7px">${ex.sentiment}</span>
            </div>
            <div class="intel-val ${ex.net_24h.startsWith('+') ? 'm-down' : 'm-up'}">${ex.net_24h} <span style="font-size:8px; color:var(--text-muted); font-weight:normal;">Net Flow</span></div>
            
            <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:2px;">
                <span>Vol: <span style="color:var(--text-primary)">${ex.vol_24h}</span></span>
                <span>OI: <span style="color:var(--text-primary)">${ex.oi}</span></span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--text-muted); margin-top:2px;">
                <span>Fund: <span style="color:var(--text-primary)">${ex.funding}</span></span>
                <span>Rate: <span style="color:var(--text-primary)">${ex.irate}</span></span>
            </div>
        </div>
    `).join('');
}

function renderWhaleTable(data) {
    const tbody = document.getElementById('whaleTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = data.map(w => `
        <tr>
            <td style="color:var(--text-muted)">#${w.rank}</td>
            <td class="w-owner">${w.owner}</td>
            <td class="w-addr" onclick="openExplorer('${w.addr}', '${w.type}')">${w.addr.substring(0,6)}...${w.addr.substring(w.addr.length-4)}</td>
            <td><span class="badge ${w.type==='btc' ? 'badge-btc' : 'badge-eth'}">${w.balance}</span></td>
            <td style="font-weight:700">${w.val}</td>
            <td style="color:var(--text-muted); font-size:9px">${w.last_active}</td>
        </tr>
    `).join('');
}

function renderWhaleAlerts(alerts) {
    const list = document.getElementById('whaleAlertsList');
    if (!list) return;
    
    list.innerHTML = alerts.map(a => `
        <div class="alert-item">
            <div class="alert-header">
                <span class="badge ${a.action==='INFLOW' ? 'badge-in' : (a.action==='OUTFLOW' ? 'badge-out' : 'badge-btc')} alert-tag" style="font-size:8px">${a.action}</span>
                <span class="alert-time">${a.time}</span>
            </div>
            <div class="alert-val" style="font-size:10px">${a.val}</div>
            <div class="alert-path" style="font-size:8px">${a.from} <span style="color:var(--bloomberg-orange)">➔</span> ${a.to}</div>
        </div>
    `).join('');
}

function openExplorer(addr, type) {
    const url = type === 'btc' 
        ? `https://www.blockchain.com/explorer/addresses/btc/${addr}`
        : `https://etherscan.io/address/${addr}`;
    window.open(url, '_blank');
}

// ================= DASHBOARD INTEL (4 BLOCKS) LOGIC =================
async function updateDashboardIntel() {
    if (!serverOnline) return;
    try {
        const intel = await apiFetch('/dashboard/intel');
        if (!intel) return;

        // Block 1: Flow (Advanced Delta & Actor Tags)
        const f = document.getElementById('dbFlowContent');
        if (f) {
            let flowHtml = intel.flow.assets.map(item => {
                const isPos = item.pct > 0;
                const barColor = isPos ? 'var(--bloomberg-green)' : 'var(--bloomberg-red)';
                const w = Math.abs(item.pct);
                const leftBar  = isPos ? '' : `<div style="width:${w}%; height:100%; background:${barColor}; margin-left:auto; border-radius:1px 0 0 1px;"></div>`;
                const rightBar = isPos ? `<div style="width:${w}%; height:100%; background:${barColor}; border-radius:0 1px 1px 0;"></div>` : '';
                const badgeClass = item.actor === 'WHALES' ? 'badge-in' : 'badge-out';
                
                return `
                    <div style="display:flex; flex-direction:column; gap:4px; margin-bottom:6px;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                            <div style="display:flex; align-items:center; gap:6px;">
                                <span style="font-weight:700; color:var(--text-primary); font-size:11px;">${item.coin}</span>
                                <span class="badge ${badgeClass}" style="font-size:7px; padding:2px 4px; letter-spacing:0.5px;">${item.actor}</span>
                            </div>
                            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
                                <span class="${isPos ? 'm-up' : 'm-down'}" style="font-weight:700; font-size:11px;">${item.valStr}</span>
                                <span style="font-size:8px; color:var(--text-muted);">${item.trend7d}</span>
                            </div>
                        </div>
                        <div style="display:flex; width:100%; height:4px; gap:2px;">
                            <div style="flex:1; background:rgba(255,255,255,0.05); border-radius:2px;">${leftBar}</div>
                            <div style="flex:1; background:rgba(255,255,255,0.05); border-radius:2px;">${rightBar}</div>
                        </div>
                    </div>
                `;
            }).join('');

            // Add Stablecoin "Dry Powder" Pipeline Gauge
            flowHtml += `
            <div style="margin-top:auto; padding-top:6px; border-top:1px dashed #333; display:flex; flex-direction:column; gap:3px;">
                <div style="display:flex; justify-content:space-between; font-size:9px;">
                    <span style="font-weight:800; color:var(--text-muted);">${intel.flow.stablecoin.label.toUpperCase()}</span>
                    <span style="color:var(--bloomberg-green); font-weight:700;">${intel.flow.stablecoin.valStr}</span>
                </div>
                <div style="width:100%; height:6px; background:#1a1a1a; border-radius:1px; overflow:hidden; border:1px solid #333;">
                    <div style="width:${intel.flow.stablecoin.pct}%; height:100%; background:linear-gradient(90deg, #111 0%, var(--bloomberg-green) 100%);"></div>
                </div>
            </div>`;
            
            f.innerHTML = flowHtml;
        }

        // Block 2: Liquidity (Advanced Vertically Elongated Map)
        const l = document.getElementById('dbLiqContent');
        if (l) l.innerHTML = `
            <div style="flex: 1; display: flex; flex-direction: column; gap: 8px; margin-top:4px;">
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; padding-bottom:6px; margin-bottom:6px;">
                    <span style="font-size:9px; color:var(--text-muted);">GLOBAL DEPTH</span>
                    <span style="font-size:11px; font-weight:700; color:var(--text-primary);">${intel.liquidity.book_depth}</span>
                </div>

                <!-- Mini Heatmap Array -->
                <div style="display:flex; justify-content:space-between; align-items:stretch; margin-bottom:8px; gap:2px; height:6px;">
                    <div style="flex:1; background:rgba(255,67,61,0.9); border-radius:1px; box-shadow:0 0 4px rgba(255,67,61,0.4);"></div>
                    <div style="flex:1; background:rgba(255,67,61,0.6); border-radius:1px;"></div>
                    <div style="flex:1.5; background:rgba(255,67,61,0.2); border-radius:1px;"></div>
                    <div style="flex:0.5; background:#333; border-radius:1px;"></div>
                    <div style="flex:2; background:rgba(74,246,195,0.2); border-radius:1px;"></div>
                    <div style="flex:1; background:rgba(74,246,195,0.6); border-radius:1px;"></div>
                    <div style="flex:1; background:rgba(74,246,195,0.9); border-radius:1px; box-shadow:0 0 4px rgba(74,246,195,0.4);"></div>
                </div>
                
                <!-- Order Book Walls -->
                <div style="display:flex; flex-direction:column; gap:2px; font-size:9px;">
                    <div style="display:flex; justify-content:space-between; color:var(--bloomberg-red);"><span style="font-family:var(--font-mono); font-weight:700;">ASK WALL</span><span>${intel.liquidity.sell_wall}</span></div>
                    <div style="height:6px; width:100%; background:#222; border-radius:1px; display:flex; justify-content:flex-end;">
                        <div style="height:100%; width:85%; background:rgba(255, 67, 61, 0.5); border-right:1px solid var(--bloomberg-red);"></div>
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:2px; font-size:9px; margin-bottom:8px;">
                    <div style="height:6px; width:100%; background:#222; border-radius:1px; display:flex; justify-content:flex-start;">
                        <div style="height:100%; width:70%; background:rgba(74, 246, 195, 0.4); border-left:1px solid var(--bloomberg-green);"></div>
                    </div>
                    <div style="display:flex; justify-content:space-between; color:var(--bloomberg-green);"><span style="font-family:var(--font-mono); font-weight:700;">BID WALL</span><span>${intel.liquidity.buy_wall}</span></div>
                </div>

                <!-- Recent Liquidations Feed & Mini Chart -->
                <div style="display:flex; justify-content:space-between; align-items:flex-end; border-bottom:1px dashed #333; padding-bottom:4px; margin-top:auto;">
                    <div style="font-size:9px; font-weight:800; color:var(--text-muted);">RECENT LIQUIDATIONS</div>
                    <div style="display:flex; gap:2px; height:12px; align-items:flex-end; opacity:0.8;">
                        <div style="width:3px; height:100%; background:var(--bloomberg-green);"></div>
                        <div style="width:3px; height:60%; background:var(--bloomberg-red);"></div>
                        <div style="width:3px; height:30%; background:var(--bloomberg-red);"></div>
                        <div style="width:3px; height:80%; background:var(--bloomberg-green);"></div>
                        <div style="width:3px; height:50%; background:var(--bloomberg-red);"></div>
                        <div style="width:3px; height:75%; background:var(--bloomberg-green);"></div>
                        <div style="width:3px; height:100%; background:var(--bloomberg-green);"></div>
                    </div>
                </div>
                <div style="display:flex; flex-direction:column; gap:6px; font-size:9px; margin-top:4px; overflow-y:auto; padding-right:4px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:var(--text-primary); padding:2px 4px; background:rgba(255,67,61,0.2); border-left:2px solid var(--bloomberg-red);">SHORT</span><span style="font-weight:700;">$2.4M (BTC)</span><span style="color:var(--text-muted);">1m ago</span></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:var(--text-primary); padding:2px 4px; background:rgba(74,246,195,0.2); border-left:2px solid var(--bloomberg-green);">LONG</span><span style="font-weight:700;">$890K (ETH)</span><span style="color:var(--text-muted);">4m ago</span></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:var(--text-primary); padding:2px 4px; background:rgba(74,246,195,0.2); border-left:2px solid var(--bloomberg-green);">LONG</span><span style="font-weight:700;">$5.1M (SOL)</span><span style="color:var(--text-muted);">12m ago</span></div>
                    <div style="display:flex; justify-content:space-between; align-items:center;"><span style="color:var(--text-primary); padding:2px 4px; background:rgba(255,67,61,0.2); border-left:2px solid var(--bloomberg-red);">SHORT</span><span style="font-weight:700;">$150K (DOGE)</span><span style="color:var(--text-muted);">14m ago</span></div>
                </div>
            </div>
        `;

        // Block 3: Supply
        const s = document.getElementById('dbSupplyContent');
        if (s) s.innerHTML = intel.mined.map(item => `
            <div class="supply-item">
                <div class="intel-box-row" style="align-items:flex-end;">
                    <span style="font-weight:700; color:var(--bloomberg-orange);">${item.coin} <span style="font-size:8px; font-weight:500; color:var(--text-muted); padding-left:4px;">${item.hash}</span></span>
                    <span style="color:var(--text-muted)">${item.pct}%</span>
                </div>
                <div class="supply-bar-bg"><div class="supply-bar-fill" style="width:${item.pct}%;"></div></div>
            </div>
        `).join('');

        // Block 4: Health
        const h = document.getElementById('dbHealthContent');
        if (h) h.innerHTML = `
            <div class="intel-box-row"><span style="color:var(--text-muted)">Total Hashrate</span><span style="color:var(--text-primary);font-weight:700;">${intel.health.hashrate}</span></div>
            <div class="intel-box-row"><span style="color:var(--text-muted)">Active Addresses (24h)</span><span style="color:var(--text-primary);font-weight:700;">${intel.health.active_addr}</span></div>
            <div class="intel-box-row"><span style="color:var(--text-muted)">Avg Tx Fee</span><span style="color:var(--text-primary);font-weight:700;">${intel.health.avg_fee}</span></div>
        `;
        
        // Trigger AI bias engine if hasn't been triggered yet
        if (!document.getElementById('aiInsightBox').dataset.loaded) {
            document.getElementById('aiInsightBox').dataset.loaded = 'true';
            fetchMarketBias();
        }
    } catch (e) {
        console.error("Failed to load dashboard intel blocks:", e);
    }
}

async function fetchMarketBias() {
    const box = document.getElementById('aiInsightBox');
    const glow = document.getElementById('aiBiasGlow');
    const content = document.getElementById('aiBiasContent');
    if (!box) return;

    box.classList.add('ai-pulsing');
    glow.style.color = 'var(--bloomberg-blue)';
    glow.textContent = 'INFERENCING LOCAL WEIGHTS (M2.7)...';
    content.textContent = 'Transmitting order book depths, funding rates, and on-chain liquidations to local daemon...';

    try {
        const data = await apiFetch('/ai/bias');
        box.classList.remove('ai-pulsing');
        
        if (data && data.status === 'success') {
            const raw = data.bias;
            // Parse overarching sentiment explicitly if the model printed it
            if(raw.toUpperCase().includes('BULLISH')) {
                glow.style.color = 'var(--bloomberg-green)';
                glow.textContent = 'SYSTEM BIAS: BULLISH';
            } else if(raw.toUpperCase().includes('BEARISH')) {
                glow.style.color = 'var(--bloomberg-red)';
                glow.textContent = 'SYSTEM BIAS: BEARISH';
            } else {
                glow.style.color = 'var(--bloomberg-amber)';
                glow.textContent = 'SYSTEM BIAS: CHOP / NEUTRAL';
            }
            content.innerHTML = raw.replace(/\n/g, '<br/>');
        } else {
            glow.style.color = 'var(--bloomberg-red)';
            glow.textContent = 'INFERENCE FAILED';
            content.textContent = data ? data.message : 'No response from daemon.';
        }
    } catch(e) {
        box.classList.remove('ai-pulsing');
        glow.style.color = 'var(--bloomberg-red)';
        glow.textContent = 'INFERENCE FAILED';
        content.textContent = 'Connection to localhost:11434 refused. Ensure Ollama is running.';
    }
}
