// Theme management
const themeButtons = document.querySelectorAll('.theme-toggle button');
let currentTheme = localStorage.getItem('theme') || 'auto';
let currentSymbol = 'BTCUSDT'; // Track current chart symbol

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme, reloadChart = false) {
  const effectiveTheme = theme === 'auto' ? getSystemTheme() : theme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);

  // Update active button
  themeButtons.forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
  });

  currentTheme = theme;
  localStorage.setItem('theme', theme);

  // Reload chart with new theme if requested
  if (reloadChart && typeof renderChart === 'function') {
    renderChart(currentSymbol);
  }
}

// Initialize theme
applyTheme(currentTheme);

// Listen to system theme changes when in auto mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentTheme === 'auto') {
    applyTheme('auto', true);
  }
});

// Theme toggle buttons
themeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    applyTheme(btn.getAttribute('data-theme'), true);
  });
});

const statusEl = document.getElementById('dashboard-status');
const addressTable = document.getElementById('address-table');
const fillsTable = document.getElementById('fills-table');
const decisionsList = document.getElementById('decisions-list');
const recommendationCard = document.getElementById('recommendation-card');
const symbolButtons = document.querySelectorAll('.toggle-group button');
const lastRefreshEl = document.getElementById('last-refresh');
const refreshBtn = document.getElementById('refresh-btn');
const customCountEl = document.getElementById('custom-count');
const customAddressInput = document.getElementById('custom-address-input');
const customNicknameInput = document.getElementById('custom-nickname-input');
const addCustomBtn = document.getElementById('add-custom-btn');
const customErrorEl = document.getElementById('custom-accounts-error');

const API_BASE = '/dashboard/api';
const SCOUT_API = '/api'; // hl-scout API base (proxied via hl-stream)
const TOP_TABLE_LIMIT = 13; // 10 system + up to 3 custom
let fillsCache = [];
let dashboardPeriod = 30;
let addressMeta = {};
let customAccountCount = 0;
const MAX_CUSTOM_ACCOUNTS = 3;
let positionsReady = false; // Track whether positions have been loaded

// Fills time range tracking
let fillsOldestTime = null;
let fillsNewestTime = null;
let isLoadingMore = false;
let hasMoreFills = true;

// Fill aggregation settings
const AGGREGATION_WINDOW_MS = 60000; // 1 minute

function placeholder(text = 'No live data') {
  return `<span class="placeholder">${text}</span>`;
}

function fmtPercent(value) {
  if (!Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function fmtUsdShort(value) {
  if (!Number.isFinite(value)) return 'N/A';
  if (value === 0) return '$0';
  const sign = value > 0 ? '+' : '-';
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
  if (!entry || !Number.isFinite(entry.size) || Math.abs(entry.size) < 0.0001) {
    // This function is only called for actual position entries
    // Empty/invalid entries should show "No BTC/ETH position"
    return placeholder('No BTC/ETH position');
  }
  const size = Number(entry.size);
  const symbol = (entry.symbol || '').toUpperCase();
  const direction = size >= 0 ? 'holding-long' : 'holding-short';
  const magnitude = Math.abs(size);
  const precision = magnitude >= 1 ? 2 : 3;
  const signed = `${size >= 0 ? '+' : '-'}${magnitude.toFixed(precision)} ${symbol || ''}`.trim();
  return `<span class="holding-chip ${direction}" title="Live Hyperliquid position">${signed}</span>`;
}

function normalizeHoldings(raw = {}) {
  const normalized = {};
  Object.entries(raw).forEach(([addr, positions]) => {
    if (!addr) return;
    const key = addr.toLowerCase();
    // Handle both old format (single position object) and new format (array of positions)
    if (Array.isArray(positions)) {
      normalized[key] = positions.map(pos => ({
        symbol: (pos?.symbol || '').toUpperCase(),
        size: Number(pos?.size ?? 0),
      }));
    } else {
      // Legacy single position format
      normalized[key] = [{
        symbol: (positions?.symbol || '').toUpperCase(),
        size: Number(positions?.size ?? 0),
      }];
    }
  });
  return normalized;
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

// Aggregate fills within a time window (same address, symbol, side/action)
function aggregateFills(fills) {
  if (!fills.length) return [];

  const aggregated = [];
  let currentGroup = null;

  // Sort by time descending (newest first)
  const sorted = [...fills].sort((a, b) => new Date(b.time_utc) - new Date(a.time_utc));

  for (const fill of sorted) {
    const fillTime = new Date(fill.time_utc).getTime();
    const symbol = (fill.symbol || 'BTC').toUpperCase();
    const action = fill.action || '';
    const address = fill.address;

    // Check if this fill should be grouped with current group
    if (currentGroup) {
      const groupTime = new Date(currentGroup.time_utc).getTime();
      const timeDiff = Math.abs(groupTime - fillTime);
      const sameAddress = currentGroup.address === address;
      const sameSymbol = currentGroup.symbol === symbol;
      const sameAction = currentGroup.action === action;

      if (sameAddress && sameSymbol && sameAction && timeDiff <= AGGREGATION_WINDOW_MS) {
        // Add to current group
        currentGroup.fills.push(fill);
        currentGroup.totalSize += Math.abs(fill.size_signed || 0);
        currentGroup.totalPnl += fill.closed_pnl_usd || 0;
        if (fill.price_usd) {
          currentGroup.prices.push(fill.price_usd);
        }
        // Update time range
        if (fillTime < new Date(currentGroup.oldest_time).getTime()) {
          currentGroup.oldest_time = fill.time_utc;
        }
        continue;
      }
    }

    // Finalize current group and start new one
    if (currentGroup) {
      finalizeGroup(currentGroup);
      aggregated.push(currentGroup);
    }

    // Start new group
    currentGroup = {
      time_utc: fill.time_utc,
      oldest_time: fill.time_utc,
      address: address,
      symbol: symbol,
      action: action,
      fills: [fill],
      totalSize: Math.abs(fill.size_signed || 0),
      totalPnl: fill.closed_pnl_usd || 0,
      prices: fill.price_usd ? [fill.price_usd] : [],
      previous_position: fill.previous_position,
      isAggregated: false,
    };
  }

  // Don't forget the last group
  if (currentGroup) {
    finalizeGroup(currentGroup);
    aggregated.push(currentGroup);
  }

  return aggregated;
}

function finalizeGroup(group) {
  group.isAggregated = group.fills.length > 1;
  group.fillCount = group.fills.length;
  group.avgPrice = group.prices.length > 0
    ? group.prices.reduce((a, b) => a + b, 0) / group.prices.length
    : null;
  // Determine signed size based on action
  const isShort = group.action.toLowerCase().includes('short');
  const isDecrease = group.action.toLowerCase().includes('decrease') || group.action.toLowerCase().includes('close');
  group.size_signed = isShort || isDecrease ? -group.totalSize : group.totalSize;
  group.closed_pnl_usd = group.totalPnl || null;
  group.price_usd = group.avgPrice;
}

// Update time range display
function updateTimeRangeDisplay() {
  const timeRangeEl = document.getElementById('fills-time-range');
  if (!timeRangeEl) return;

  if (!fillsNewestTime && !fillsOldestTime) {
    timeRangeEl.textContent = 'No fills yet';
    return;
  }

  const formatTimeShort = (ts) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const newestStr = fillsNewestTime ? formatTimeShort(fillsNewestTime) : 'now';
  const oldestStr = fillsOldestTime ? formatTimeShort(fillsOldestTime) : '—';

  timeRangeEl.textContent = `${oldestStr} → ${newestStr}`;
}

// Show/hide load history button based on fills state
function updateLoadHistoryVisibility() {
  const container = document.getElementById('fills-load-history');
  if (!container) return;

  // Hide if we have fills or if there's no more history
  if (fillsCache.length > 0 || !hasMoreFills) {
    container.classList.add('hidden');
  } else {
    container.classList.remove('hidden');
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function fmtScore(score) {
  if (!Number.isFinite(score)) return '—';
  if (score === 0) return '0';
  // Display score with appropriate precision
  if (Math.abs(score) >= 100) return score.toFixed(1);
  if (Math.abs(score) >= 1) return score.toFixed(2);
  return score.toFixed(4);
}

function renderAddresses(stats = [], profiles = {}, holdings = {}) {
  const rows = (stats || []).slice(0, TOP_TABLE_LIMIT);
  if (!rows.length) {
    addressTable.innerHTML = `<tr><td colspan="6">${placeholder('No live leaderboard data')}</td></tr>`;
    return;
  }
  addressTable.innerHTML = rows
    .map((row) => {
      const txCount = profiles[row.address]?.txCount || 0;
      const winRateCell = typeof row.winRate === 'number' ? fmtPercent(row.winRate) : placeholder();
      const tradesValue =
        typeof row.statClosedPositions === 'number'
          ? row.statClosedPositions
          : typeof row.executedOrders === 'number'
            ? row.executedOrders
            : null;
      const tradesCell = tradesValue === null ? placeholder() : tradesValue;
      const holdingKey = row.address?.toLowerCase() || '';
      const holdingPositions = holdings[holdingKey] || [];
      const holdingCell = holdingPositions.length > 0
        ? holdingPositions.map(pos => formatHolding(pos)).join(' ')
        : placeholder('No BTC/ETH position');
      const pnlCell = typeof row.realizedPnl === 'number' ? fmtUsdShort(row.realizedPnl) : placeholder();
      const scoreCell = typeof row.score === 'number' ? fmtScore(row.score) : placeholder();
      const isCustom = row.isCustom === true;
      const customIndicator = isCustom ? '<span class="custom-star" title="Custom tracked account">★</span>' : '';
      const removeBtn = isCustom ? `<button class="remove-custom-btn" data-address="${row.address}" title="Remove custom account">×</button>` : '';
      const nicknameDisplay = row.remark
        ? `<span class="nickname-display" data-address="${row.address}" data-nickname="${escapeHtml(row.remark)}" title="Click to edit nickname">${escapeHtml(row.remark)}</span>`
        : (isCustom ? `<span class="nickname-display nickname-empty" data-address="${row.address}" data-nickname="" title="Click to add nickname">+ Add nickname</span>` : '');
      return `
        <tr class="${isCustom ? 'custom-row' : ''}">
          <td data-label="Address" title="Hyperliquid tx count: ${txCount}">
            <span class="custom-indicator">
              ${customIndicator}
              <a href="https://hypurrscan.io/address/${row.address}" target="_blank" rel="noopener noreferrer">
                ${shortAddress(row.address)}
              </a>
              ${removeBtn}
            </span>
            <div class="addr-remark">${nicknameDisplay}</div>
          </td>
          <td data-label="Win Rate">${winRateCell}</td>
          <td data-label="Trades">${tradesCell}</td>
          <td data-label="Holdings" class="holds-cell">
            ${holdingCell}
          </td>
          <td data-label="Realized PnL">${pnlCell}</td>
          <td data-label="Score" class="score-cell">${scoreCell}</td>
        </tr>
      `;
    })
    .join('');

  // Attach event listeners for remove buttons
  document.querySelectorAll('.remove-custom-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const address = btn.dataset.address;
      if (address) removeCustomAccount(address);
    });
  });

  // Attach event listeners for nickname editing (custom accounts only)
  document.querySelectorAll('.nickname-display').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const address = el.dataset.address;
      const currentNickname = el.dataset.nickname || '';
      if (address) showNicknameEditor(el, address, currentNickname);
    });
  });
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
  const winRateText = typeof rec.winRate === 'number' ? fmtPercent(rec.winRate) : 'N/A (no live data)';
  const realizedText = typeof rec.realizedPnl === 'number' ? fmtUsdShort(rec.realizedPnl) : 'N/A (no live data)';
  const weightText = typeof rec.weight === 'number' ? `${(rec.weight * 100).toFixed(1)}%` : 'N/A';
  recommendationCard.innerHTML = `
    <span>Focus address</span>
    <strong>${remark ? `${remark} (${shortAddress(rec.address)})` : rec.address}</strong>
    <span>Win rate: ${winRateText} • Realized: ${realizedText}</span>
    ${
      featured
        ? `<span>Latest fill: ${featured.side.toUpperCase()} ${featured.size} @ ${featured.priceUsd}</span>`
        : ''
    }
    <span>Weight: ${weightText}</span>
    ${profile ? `<span>Total HL transactions: ${profile.txCount || 0}</span>` : ''}
    <em>${rec.message}</em>
  `;
}

function renderFills(list) {
  // Filter to BTC/ETH only
  const btcEthFills = list.filter(fill => {
    const symbol = (fill.symbol || 'BTC').toUpperCase();
    return symbol === 'BTC' || symbol === 'ETH';
  });

  // Update time range tracking
  if (btcEthFills.length > 0) {
    const times = btcEthFills.map(f => new Date(f.time_utc).getTime()).filter(t => !isNaN(t));
    if (times.length > 0) {
      const newestInBatch = new Date(Math.max(...times)).toISOString();
      const oldestInBatch = new Date(Math.min(...times)).toISOString();

      if (!fillsNewestTime || new Date(newestInBatch) > new Date(fillsNewestTime)) {
        fillsNewestTime = newestInBatch;
      }
      if (!fillsOldestTime || new Date(oldestInBatch) < new Date(fillsOldestTime)) {
        fillsOldestTime = oldestInBatch;
      }
    }
    updateTimeRangeDisplay();
  }

  // Aggregate fills
  const aggregated = aggregateFills(btcEthFills);

  const rows = aggregated
    .map((fill) => {
      const symbol = (fill.symbol || 'BTC').toUpperCase();
      const sizeVal = fill.isAggregated ? fill.totalSize : Math.abs(fill.size_signed || 0);
      const sizeSign = fill.size_signed >= 0 ? '+' : '-';
      const size = typeof sizeVal === 'number' ? `${sizeSign}${sizeVal.toFixed(5)} ${symbol}` : '—';
      const prev = typeof fill.previous_position === 'number' ? `${fill.previous_position.toFixed(5)} ${symbol}` : '—';
      const price = fill.isAggregated && fill.avgPrice
        ? `~${fmtUsdShort(fill.avgPrice)}`
        : fmtUsdShort(fill.price_usd ?? null);
      const pnl = fmtUsdShort(fill.closed_pnl_usd ?? null);
      const action = fill.action || '—';
      const sideClass = action.toLowerCase().includes('short') ? 'sell' : 'buy';

      // Show aggregation indicator
      const aggBadge = fill.isAggregated
        ? `<span class="agg-badge" title="${fill.fillCount} fills aggregated">×${fill.fillCount}</span>`
        : '';

      return `
        <tr class="${fill.isAggregated ? 'aggregated-row' : ''}">
          <td data-label="Time">${fmtDateTime(fill.time_utc)}</td>
          <td data-label="Address"><a href="https://hypurrscan.io/address/${fill.address}" target="_blank" rel="noopener noreferrer">${shortAddress(fill.address)}</a></td>
          <td data-label="Action"><span class="pill ${sideClass}">${action}</span>${aggBadge}</td>
          <td data-label="Size">${size}</td>
          <td data-label="Previous Position">${prev}</td>
          <td data-label="Price">${price}</td>
          <td data-label="Closed PnL">${pnl}</td>
        </tr>
      `;
    })
    .join('');

  fillsTable.innerHTML = rows;

  // Show empty state if no fills
  if (!fillsTable.innerHTML.trim()) {
    fillsTable.innerHTML = `<tr><td colspan="7" class="placeholder">No BTC/ETH fills yet</td></tr>`;
  }

  // Update load history button visibility
  updateLoadHistoryVisibility();
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

function updateLastRefreshDisplay(lastRefresh) {
  if (lastRefresh) {
    const date = new Date(lastRefresh);
    lastRefreshEl.textContent = `Last updated: ${date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  } else {
    lastRefreshEl.textContent = 'Last updated: —';
  }
}

function updateCustomAccountCount(count, max) {
  customAccountCount = count;
  customCountEl.textContent = count;
  // Disable add button if at max
  addCustomBtn.disabled = count >= max;
}

// Check positions status and poll until ready
const MAX_POSITION_POLL_RETRIES = 30; // Max 30 retries (60 seconds total)
let positionPollRetries = 0;

async function checkPositionsStatus() {
  try {
    const data = await fetchJson(`${API_BASE}/positions-status`);
    positionsReady = data.positionsReady === true;
    return positionsReady;
  } catch (err) {
    console.error('Failed to check positions status:', err);
    return false;
  }
}

async function pollPositionsUntilReady() {
  const isReady = await checkPositionsStatus();
  if (!isReady && positionPollRetries < MAX_POSITION_POLL_RETRIES) {
    positionPollRetries++;
    // Poll every 2 seconds until positions ready or max retries reached
    setTimeout(async () => {
      await checkPositionsStatus();
      await refreshSummary();
      if (!positionsReady && positionPollRetries < MAX_POSITION_POLL_RETRIES) {
        pollPositionsUntilReady();
      } else if (positionPollRetries >= MAX_POSITION_POLL_RETRIES) {
        console.warn('Position polling max retries reached, continuing without positions');
      }
    }, 2000);
  }
}

async function refreshSummary() {
  try {
    const summaryUrl = `${API_BASE}/summary?period=${dashboardPeriod}&limit=${TOP_TABLE_LIMIT}`;
    const data = await fetchJson(summaryUrl);
    const rows = Array.isArray(data.stats)
      ? data.stats
      : Array.isArray(data.selected)
        ? data.selected
        : [];
    const holdings = normalizeHoldings(data.holdings || {});
    addressMeta = {};
    rows.forEach((row) => {
      if (!row?.address) return;
      addressMeta[row.address.toLowerCase()] = { remark: row.remark || null };
    });
    renderAddresses(rows, data.profiles || {}, holdings);
    renderRecommendation(data);
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    // Update last refresh display
    updateLastRefreshDisplay(data.lastRefresh);

    // Update custom account count
    if (typeof data.customAccountCount === 'number') {
      updateCustomAccountCount(data.customAccountCount, data.maxCustomAccounts || MAX_CUSTOM_ACCOUNTS);
    }
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
          .forEach((e) => {
            const symbol = (e.symbol || 'BTC').toUpperCase();
            // Only process BTC and ETH fills
            if (symbol !== 'BTC' && symbol !== 'ETH') return;

            const sizeSigned = e.size ?? e.payload?.size ?? 0;
            const startPos = e.startPosition ?? e.payload?.startPosition ?? null;
            const row = {
              time_utc: e.at,
              address: e.address,
              action: e.action || e.payload?.action || '',
              size_signed: Number(sizeSigned),
              previous_position: startPos != null ? Number(startPos) : null,
              price_usd: e.priceUsd ?? e.payload?.priceUsd ?? null,
              closed_pnl_usd: e.realizedPnlUsd ?? e.payload?.realizedPnlUsd ?? null,
              symbol
            };
            pushFill(row);
          });
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
    // Determine current theme
    const effectiveTheme = currentTheme === 'auto' ? getSystemTheme() : currentTheme;
    const tvTheme = effectiveTheme === 'light' ? 'light' : 'dark';

    document.getElementById('tradingview_chart').innerHTML = '';
    // eslint-disable-next-line no-undef
    new TradingView.widget({
      autosize: true,
      symbol: `BINANCE:${symbol}`,
      interval: '60',
      timezone: 'Etc/UTC',
      theme: tvTheme,
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
      currentSymbol = btn.dataset.symbol || 'BTCUSDT';
      renderChart(currentSymbol);
    });
  });
}

// Period controls removed - now fixed to 30 days

// Show error message in custom accounts section
function showCustomError(message) {
  customErrorEl.textContent = message;
  customErrorEl.classList.add('show');
  setTimeout(() => {
    customErrorEl.classList.remove('show');
  }, 5000);
}

// Clear error message
function clearCustomError() {
  customErrorEl.classList.remove('show');
  customErrorEl.textContent = '';
}

// Validate Ethereum address format
function isValidEthAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Add a custom account
async function addCustomAccount() {
  clearCustomError();
  const address = customAddressInput.value.trim();
  const nickname = customNicknameInput.value.trim();

  if (!address) {
    showCustomError('Please enter an Ethereum address');
    return;
  }

  if (!isValidEthAddress(address)) {
    showCustomError('Invalid Ethereum address format (must be 0x + 40 hex characters)');
    return;
  }

  if (customAccountCount >= MAX_CUSTOM_ACCOUNTS) {
    showCustomError(`Maximum of ${MAX_CUSTOM_ACCOUNTS} custom accounts allowed`);
    return;
  }

  addCustomBtn.disabled = true;
  addCustomBtn.textContent = 'Adding...';

  try {
    const res = await fetch(`${API_BASE}/custom-accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, nickname: nickname || undefined })
    });

    const data = await res.json();

    if (!res.ok) {
      showCustomError(data.error || 'Failed to add custom account');
      return;
    }

    // Clear inputs on success
    customAddressInput.value = '';
    customNicknameInput.value = '';

    // Refresh the summary to show the new account
    await refreshSummary();
  } catch (err) {
    console.error('Add custom account error:', err);
    showCustomError('Failed to add custom account');
  } finally {
    addCustomBtn.disabled = customAccountCount >= MAX_CUSTOM_ACCOUNTS;
    addCustomBtn.textContent = 'Add';
  }
}

// Remove a custom account
async function removeCustomAccount(address) {
  if (!address) return;

  try {
    const res = await fetch(`${API_BASE}/custom-accounts/${encodeURIComponent(address)}`, {
      method: 'DELETE'
    });

    if (!res.ok) {
      const data = await res.json();
      console.error('Remove custom account error:', data.error);
      return;
    }

    // Refresh the summary to update the table
    await refreshSummary();
  } catch (err) {
    console.error('Remove custom account error:', err);
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show inline nickname editor
function showNicknameEditor(el, address, currentNickname) {
  // Create inline editor
  const container = el.parentElement;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentNickname;
  input.className = 'nickname-input';
  input.placeholder = 'Enter nickname';
  input.maxLength = 32;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'nickname-save-btn';
  saveBtn.textContent = 'Save';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'nickname-cancel-btn';
  cancelBtn.textContent = 'Cancel';

  const editorWrapper = document.createElement('div');
  editorWrapper.className = 'nickname-editor';
  editorWrapper.appendChild(input);
  editorWrapper.appendChild(saveBtn);
  editorWrapper.appendChild(cancelBtn);

  // Hide original display, show editor
  el.style.display = 'none';
  container.appendChild(editorWrapper);
  input.focus();
  input.select();

  // Save handler
  const save = async () => {
    const newNickname = input.value.trim();
    saveBtn.disabled = true;
    saveBtn.textContent = '...';

    const success = await updateNickname(address, newNickname);
    if (success) {
      editorWrapper.remove();
      await refreshSummary();
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      input.focus();
    }
  };

  // Cancel handler
  const cancel = () => {
    editorWrapper.remove();
    el.style.display = '';
  };

  saveBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', cancel);

  // Enter to save, Escape to cancel
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

// Update nickname via API
async function updateNickname(address, nickname) {
  try {
    const res = await fetch(`${API_BASE}/custom-accounts/${encodeURIComponent(address)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: nickname || null })
    });

    if (!res.ok) {
      const data = await res.json();
      console.error('Update nickname error:', data.error);
      showCustomError(data.error || 'Failed to update nickname');
      return false;
    }

    return true;
  } catch (err) {
    console.error('Update nickname error:', err);
    showCustomError('Failed to update nickname');
    return false;
  }
}

// Trigger manual leaderboard refresh
async function triggerLeaderboardRefresh() {
  refreshBtn.disabled = true;
  refreshBtn.classList.add('loading');

  try {
    const res = await fetch(`${API_BASE}/leaderboard/refresh`, {
      method: 'POST'
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Refresh error:', data.error);
      statusEl.textContent = 'Refresh failed';
      return;
    }

    // Poll for refresh completion
    statusEl.textContent = 'Refreshing leaderboard...';
    pollRefreshStatus();
  } catch (err) {
    console.error('Refresh error:', err);
    statusEl.textContent = 'Refresh failed';
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('loading');
  }
}

// Poll refresh status until complete
async function pollRefreshStatus() {
  try {
    const data = await fetchJson(`${API_BASE}/leaderboard/refresh-status`);

    if (data.status === 'refreshing') {
      setTimeout(pollRefreshStatus, 2000);
      return;
    }

    // Refresh complete
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('loading');

    if (data.status === 'idle') {
      statusEl.textContent = 'Refresh complete';
      await refreshSummary();
    }
  } catch (err) {
    console.error('Poll refresh status error:', err);
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('loading');
    statusEl.textContent = 'Refresh status unknown';
  }
}

// Initialize custom accounts controls
function initCustomAccountsControls() {
  addCustomBtn.addEventListener('click', addCustomAccount);

  // Allow Enter key to submit
  customAddressInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addCustomAccount();
  });
  customNicknameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addCustomAccount();
  });
}

// Initialize refresh button
function initRefreshButton() {
  refreshBtn.addEventListener('click', triggerLeaderboardRefresh);
}

// Infinite scroll for fills
async function loadMoreFills() {
  if (isLoadingMore || !hasMoreFills) return;

  isLoadingMore = true;
  const loadMoreEl = document.getElementById('fills-load-more');
  if (loadMoreEl) loadMoreEl.style.display = 'flex';

  try {
    const beforeTime = fillsOldestTime || new Date().toISOString();
    const url = `${API_BASE}/fills/backfill?before=${encodeURIComponent(beforeTime)}&limit=30`;
    const data = await fetchJson(url);

    if (data.fills && data.fills.length > 0) {
      // Append to cache
      fillsCache = [...fillsCache, ...data.fills];
      hasMoreFills = data.hasMore;

      // Update oldest time
      if (data.oldestTime) {
        fillsOldestTime = data.oldestTime;
      }

      // Re-render with all fills (aggregation will be applied)
      renderFills(fillsCache);
      updateTimeRangeDisplay();
    } else {
      hasMoreFills = false;
    }

    // Show "no more" message if we've reached the end
    if (!hasMoreFills && loadMoreEl) {
      loadMoreEl.innerHTML = '<span class="no-more-fills">No more fills to load</span>';
      loadMoreEl.style.display = 'block';
    }
  } catch (err) {
    console.error('Load more fills error:', err);
    hasMoreFills = false;
  } finally {
    isLoadingMore = false;
    if (hasMoreFills) {
      const loadMoreEl = document.getElementById('fills-load-more');
      if (loadMoreEl) loadMoreEl.style.display = 'none';
    }
  }
}

// Initialize infinite scroll
function initInfiniteScroll() {
  const container = document.getElementById('fills-scroll-container');
  if (!container) return;

  container.addEventListener('scroll', () => {
    // Check if we're near the bottom (within 50px)
    const { scrollTop, scrollHeight, clientHeight } = container;
    if (scrollHeight - scrollTop - clientHeight < 50) {
      loadMoreFills();
    }
  });
}

// Fetch historical fills from Hyperliquid API
async function fetchHistoricalFills() {
  try {
    const response = await fetch(`${API_BASE}/fills/fetch-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 50 })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error('Fetch historical fills error:', err);
    return null;
  }
}

// Initialize load history button
function initLoadHistoryButton() {
  const btn = document.getElementById('load-history-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Fetching from Hyperliquid...';

    // First, try to fetch historical fills from Hyperliquid API
    const result = await fetchHistoricalFills();

    if (result && result.fills && result.fills.length > 0) {
      // Update cache with fetched fills
      fillsCache = result.fills;
      hasMoreFills = result.hasMore;
      fillsOldestTime = result.oldestTime;
      renderFills(fillsCache);
      updateTimeRangeDisplay();
      btn.textContent = `Loaded ${result.inserted} new fills`;
    } else if (result && result.inserted === 0) {
      // No new fills, but API call succeeded - try loading from DB
      btn.textContent = 'Loading from DB...';
      await loadMoreFills();
      btn.textContent = 'No new fills found';
    } else {
      // API call failed, fall back to DB
      btn.textContent = 'Loading from DB...';
      await loadMoreFills();
    }

    updateLoadHistoryVisibility();
    btn.disabled = false;

    // Reset button text after a delay
    setTimeout(() => {
      btn.textContent = 'Load Historical Fills';
    }, 2000);
  });
}

async function init() {
  initChartControls();
  initCustomAccountsControls();
  initRefreshButton();
  initInfiniteScroll();
  initLoadHistoryButton();
  renderChart('BTCUSDT');
  // Check positions status FIRST before loading data
  await checkPositionsStatus();
  refreshSummary();
  refreshFills();
  refreshDecisions();
  connectWs();
  // Continue polling until positions are ready (if not already)
  if (!positionsReady) {
    pollPositionsUntilReady();
  }
  setInterval(refreshSummary, 30_000);
  setInterval(refreshFills, 20_000);
  setInterval(refreshDecisions, 45_000);
}

document.addEventListener('DOMContentLoaded', init);
