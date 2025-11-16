const statusEl = document.getElementById('dashboard-status');
const addressTable = document.getElementById('address-table');
const fillsFeed = document.getElementById('fills-feed');
const decisionsList = document.getElementById('decisions-list');
const recommendationCard = document.getElementById('recommendation-card');
const symbolButtons = document.querySelectorAll('.toggle-group button');
const periodButtons = document.querySelectorAll('.period-toggle button');

const API_BASE = '/dashboard/api';
let fillsCache = [];
let dashboardPeriod = 30;
let addressMeta = {};

function fmtPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtUsdShort(value) {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '-';
  const abs = Math.abs(value);
  const formatter = (num, suffix) => `${sign}$${num.toFixed(num >= 10 ? 1 : 2)}${suffix}`;
  if (abs >= 1e9) return formatter(abs / 1e9, 'B');
  if (abs >= 1e6) return formatter(abs / 1e6, 'M');
  if (abs >= 1e3) return formatter(abs / 1e3, 'K');
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function shortAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatHolding(entry) {
  if (!entry || !Number.isFinite(entry.size) || Math.abs(entry.size) < 0.001) return '';
  const direction = entry.size > 0 ? 'holding-long' : 'holding-short';
  const symbol = entry.symbol?.toUpperCase() || 'BTC';
  if (symbol !== 'BTC' && symbol !== 'ETH') return '';
  return `<span class="holding-chip ${direction}">${symbol}</span>`;
}

function formatActionLabel(fill) {
  const action = fill.action ? String(fill.action).toLowerCase() : '';
  const map = {
    'open long': 'OPEN LONG',
    'increase long': 'ADD LONG',
    'close long (close all)': 'CLOSE LONG',
    'decrease long': 'CLOSE LONG',
    'open short': 'OPEN SHORT',
    'increase short': 'ADD SHORT',
    'close short (close all)': 'CLOSE SHORT',
    'decrease short': 'CLOSE SHORT',
  };
  if (map[action]) return map[action];
  if (fill.side === 'buy') return 'OPEN LONG';
  if (fill.side === 'sell') return 'OPEN SHORT';
  return action ? action.toUpperCase() : 'TRADE';
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function renderAddresses(stats = [], profiles = {}, holdings = {}) {
  addressTable.innerHTML = stats
    .map(
      (row) => `
        <tr>
          <td title="Hyperliquid tx count: ${(profiles[row.address]?.txCount) || 0}">
            <a href="https://hyperbot.network/trader/${row.address}" target="_blank" rel="noopener noreferrer">
              ${shortAddress(row.address)}
            </a>
            ${row.remark ? `<div class="addr-remark">${row.remark}</div>` : ''}
          </td>
          <td>${fmtPercent(row.winRate ?? 0)}</td>
          <td>${row.executedOrders ?? row.trades ?? 0}</td>
          <td>${(row.efficiency ?? 0).toFixed(2)}</td>
          <td class="holds-cell">
            ${formatHolding(holdings[row.address?.toLowerCase()]) || '—'}
          </td>
          <td>${fmtUsdShort(row.realizedPnl ?? row.pnl7d ?? 0)}</td>
        </tr>
      `
    )
    .join('');
}

function renderRecommendation(summary) {
  if (!summary?.recommendation) {
    recommendationCard.innerHTML = '<p>No signal yet.</p>';
    return;
  }
  const rec = summary.recommendation;
  const featured = summary.featured;
  const profile = summary.profiles?.[rec.address];
  const remark = addressMeta[rec.address?.toLowerCase()]?.remark || '';
  recommendationCard.innerHTML = `
    <span>Focus address</span>
    <strong>${remark ? `${remark} (${shortAddress(rec.address)})` : rec.address}</strong>
    <span>Win rate: ${fmtPercent(rec.winRate || 0)} • Realized: ${fmtUsdShort(rec.realizedPnl || 0)}</span>
    ${
      featured
        ? `<span>Latest fill: ${featured.side.toUpperCase()} ${featured.size} @ ${featured.priceUsd}</span>`
        : ''
    }
    <span>Weight: ${(rec.weight * 100).toFixed(1)}%</span>
    ${profile ? `<span>Total HL transactions: ${profile.txCount || 0}</span>` : ''}
    <em>${rec.message}</em>
  `;
}

function renderFills(list) {
  fillsFeed.innerHTML = list
    .map(
      (fill) => `
        <li>
          <span class="fill-meta">
            <a href="https://hyperbot.network/trader/${fill.address}" target="_blank" rel="noopener noreferrer">
              ${fill.remark ? `${fill.remark} (${shortAddress(fill.address)})` : shortAddress(fill.address)}
            </a>
            <span class="fill-sub">${fmtDateTime(fill.at)} • ${formatActionLabel(fill)}</span>
          </span>
          <span class="fill-stats">
            <span class="pill ${fill.side}">${fill.side === 'buy' ? 'LONG' : 'SHORT'}</span>
            ${fill.size.toFixed(3)} @ ${fill.priceUsd}
          </span>
        </li>
      `
    )
    .join('');
}

function renderDecisions(list) {
  decisionsList.innerHTML = list
    .map(
      (d) => `
        <li>
          <span class="decision-meta"><strong>${d.address}</strong> · ${d.asset} · ${fmtTime(d.ts)}</span>
          <span class="decision-status ${d.status === 'open' ? 'status-open' : 'status-closed'}">
            ${d.side.toUpperCase()} ${d.status === 'closed' && d.result != null ? `(${d.result.toFixed(2)})` : ''}
          </span>
        </li>
      `
    )
    .join('');
}

async function refreshSummary() {
  try {
    const data = await fetchJson(`${API_BASE}/summary?period=${dashboardPeriod}`);
    const rows = data.selected || data.stats || [];
    const holdings = data.holdings || {};
    addressMeta = {};
    rows.forEach((row) => {
      addressMeta[row.address.toLowerCase()] = { remark: row.remark || null };
    });
    renderAddresses(rows, data.profiles || {}, holdings);
    renderRecommendation(data);
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    statusEl.textContent = 'Failed to load summary';
    console.error(err);
  }
}

async function refreshFills() {
  try {
    const data = await fetchJson(`${API_BASE}/fills?limit=40`);
    fillsCache = data.fills || [];
    renderFills(fillsCache);
  } catch (err) {
    console.error(err);
  }
}

async function refreshDecisions() {
  try {
    const data = await fetchJson(`${API_BASE}/decisions?limit=20`);
    renderDecisions(data.decisions || []);
  } catch (err) {
    console.error(err);
  }
}

function pushFill(fill) {
  fillsCache.unshift(fill);
  fillsCache = fillsCache.slice(0, 40);
  renderFills(fillsCache);
}

function connectWs() {
  const wsUrl = (location.origin.startsWith('https') ? 'wss://' : 'ws://') + location.host + '/ws';
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      const events = payload.events || payload.batch || payload;
      if (Array.isArray(events)) {
        events
          .filter((e) => e.type === 'trade')
          .forEach((e) =>
            pushFill({
              address: e.address,
              at: e.at,
              side: e.side,
              size: e.size ?? e.payload?.size ?? 0,
              priceUsd: e.priceUsd ?? e.payload?.priceUsd ?? 0,
              action: e.action || e.payload?.action || null,
              remark: addressMeta[e.address.toLowerCase()]?.remark || null
            })
          );
      }
    } catch (err) {
      console.error('ws parse', err);
    }
  });
  ws.addEventListener('close', () => {
    setTimeout(connectWs, 2000);
  });
}

function renderChart(symbol) {
  const draw = () => {
    document.getElementById('tradingview_chart').innerHTML = '';
    // eslint-disable-next-line no-undef
    new TradingView.widget({
      autosize: true,
      symbol: `BINANCE:${symbol}`,
      interval: '60',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      container_id: 'tradingview_chart',
      withdateranges: true,
      hide_side_toolbar: false
    });
  };
  if (window.TradingView && window.TradingView.widget) {
    draw();
  } else {
    setTimeout(() => renderChart(symbol), 400);
  }
}

function initChartControls() {
  symbolButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      symbolButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderChart(btn.dataset.symbol || 'BTCUSDT');
    });
  });
}

function initPeriodControls() {
  periodButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      periodButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      dashboardPeriod = Number(btn.dataset.period || 30);
      refreshSummary();
    });
  });
}

function init() {
  initChartControls();
  initPeriodControls();
  renderChart('BTCUSDT');
  refreshSummary();
  refreshFills();
  refreshDecisions();
  connectWs();
  setInterval(refreshSummary, 30_000);
  setInterval(refreshFills, 20_000);
  setInterval(refreshDecisions, 45_000);
}

document.addEventListener('DOMContentLoaded', init);
