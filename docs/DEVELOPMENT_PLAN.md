# HyperMind Development Plan

## Product Vision

**HyperMind** is a collective intelligence trading system that learns from the best traders on Hyperliquid. Instead of relying on traditional technical analysis or blindly copy-trading single wallets, HyperMind:

1. **Aggregates wisdom** from top-performing traders (crowd intelligence)
2. **Learns patterns** from their collective behavior
3. **Self-improves** by analyzing past AI signal performance
4. **Filters noise** - doesn't blindly copy, but intelligently decides when/who to follow

### Core Value Proposition

> "Be as smart as the smartest traders by learning from their collective behavior"

- **Not copy-trading**: We don't blindly follow one trader
- **Consensus-based**: Signals generated when multiple top traders align
- **Self-learning**: AI improves by analyzing its own past performance
- **Risk-aware**: Filters out noise and low-confidence signals

---

## Current State (Phase 1 Complete)

### What's Built
- [x] **Leaderboard Scanner** (`hl-scout`): Scans top 1000 traders, scores by composite metrics
- [x] **Real-time Fill Tracking** (`hl-stream`): WebSocket feeds for top N traders
- [x] **Position Tracking**: Current positions for tracked addresses
- [x] **Dashboard**: Live clock, BTC/ETH prices, top performers, live fills
- [x] **Streaming Aggregation**: Smart grouping of fills within time windows
- [x] **Custom Account Tracking**: Add up to 3 custom addresses to monitor

### Architecture
```
hl-scout (4101) → Leaderboard scanning, scoring, candidate publishing
     ↓
hl-sage (4103)  → Score computation (Python/FastAPI)
     ↓
hl-stream (4102) → Real-time feeds, dashboard, WebSocket
     ↓
hl-decide (4104) → Signal generation, outcome tracking (to be enhanced)
```

---

## Phase 2: Consensus Signal Engine (MVP Core)

### Goal
Generate actionable trading signals when multiple top traders take the same position.

### Tasks

#### 2.1 Consensus Detection Service
- [ ] Create consensus detector in `hl-decide`
- [ ] Define consensus rules:
  - Same symbol (BTC/ETH)
  - Same direction (LONG/SHORT)
  - Within time window (configurable, default 5 min)
  - Minimum trader count threshold (configurable, default 3)
- [ ] Track "pending consensus" state for partial matches
- [ ] Emit consensus event when threshold met

#### 2.2 Signal Generation
- [ ] Generate signal from consensus event
- [ ] Calculate entry price (avg of trigger entries)
- [ ] Calculate stop-loss (based on trader SLs or ATR)
- [ ] Calculate take-profit (based on R:R ratio)
- [ ] Assign initial confidence score (based on trader quality)

#### 2.3 Database Schema
```sql
-- Consensus signals
CREATE TABLE signals (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  direction VARCHAR(10) NOT NULL, -- 'LONG' or 'SHORT'
  entry_price NUMERIC,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  confidence NUMERIC, -- 0-1 score
  trigger_count INT,
  trigger_addresses TEXT[],
  status VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(20), -- 'hit_tp', 'hit_sl', 'expired', 'manual'
  outcome_pnl_percent NUMERIC,
  metadata JSONB
);

-- Signal-trader attribution
CREATE TABLE signal_triggers (
  id SERIAL PRIMARY KEY,
  signal_id INT REFERENCES signals(id),
  address VARCHAR(42) NOT NULL,
  fill_hash VARCHAR(66),
  entry_price NUMERIC,
  position_size NUMERIC,
  triggered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for active signals lookup
CREATE INDEX idx_signals_status ON signals(status) WHERE status = 'active';
CREATE INDEX idx_signals_created ON signals(created_at DESC);
```

#### 2.4 Signal API
- [ ] `GET /api/signals` - List signals (active, historical)
- [ ] `GET /api/signals/:id` - Signal details with triggers
- [ ] `GET /api/signals/active` - Current active signals
- [ ] WebSocket broadcast for new signals

#### 2.5 Dashboard Integration
- [ ] Replace mock AI signals with real signals
- [ ] Show signal status (active/hit_tp/hit_sl/expired)
- [ ] Show which traders triggered each signal
- [ ] Show entry/SL/TP levels
- [ ] Real-time signal updates via WebSocket

### Open Questions (Phase 2)
> These need clarification before implementation:

1. **Consensus threshold**: How many top traders need to align?
   - Fixed number (3, 5)?
   - Percentage of tracked (10%, 20%)?
   - Dynamic based on market conditions?

2. **Time window**: How close must trades be to count as consensus?
   - 1 minute? 5 minutes? 15 minutes?
   - Should window adjust based on volatility?

3. **Top N definition**: Which traders to track for consensus?
   - Top 10 by score?
   - Top 50?
   - Dynamic based on recent performance?

4. **Position type**: What triggers a signal?
   - Only new positions (from flat)?
   - Add-to-position also counts?
   - Size threshold (minimum position size)?

5. **Conflict handling**: What if top traders are split?
   - 3 go long, 2 go short - no signal?
   - Require clear majority?

6. **Signal expiry**: How long is a signal valid?
   - Time-based (1 hour, 4 hours)?
   - Price-based (if price moves X% without entry)?

---

## Phase 3: Performance Feedback Loop

### Goal
Track signal outcomes and surface performance metrics to measure system quality.

### Tasks

#### 3.1 Outcome Tracking
- [ ] Monitor price after signal generation
- [ ] Detect TP/SL hits
- [ ] Calculate actual P/L for each signal
- [ ] Track time-to-result (how long to hit TP/SL)

#### 3.2 Performance Metrics
- [ ] Signal win rate (% hitting TP vs SL)
- [ ] Average profit per signal
- [ ] Profit factor (gross profit / gross loss)
- [ ] Maximum drawdown
- [ ] Sharpe ratio of signals
- [ ] Average holding time

#### 3.3 Signal Grading
- [ ] Grade each signal: A (>2R), B (1-2R), C (0-1R), F (loss)
- [ ] Track grade distribution over time
- [ ] Identify patterns in high-grade vs low-grade signals

#### 3.4 Trader Contribution Analysis
- [ ] Track which traders' triggers correlate with winning signals
- [ ] Identify "alpha traders" whose presence improves signal quality
- [ ] Weight future consensus by trader quality

#### 3.5 Dashboard Metrics
- [ ] Performance summary card (win rate, profit factor, etc.)
- [ ] Signal history with outcomes
- [ ] Equity curve visualization
- [ ] Trader leaderboard by signal contribution

### Open Questions (Phase 3)

1. **TP/SL calculation**: How to set realistic levels?
   - Fixed R:R ratio (1:2, 1:3)?
   - Based on ATR?
   - Based on trader's actual SL/TP?

2. **Partial profits**: Handle scaling out?
   - Track partial TP hits?
   - Or just final outcome?

3. **Benchmark**: What to compare against?
   - Buy and hold BTC?
   - Random entry signals?

---

## Phase 4: AI Learning Layer

### Goal
AI learns from historical signal performance to improve future signal quality.

### Tasks

#### 4.1 Feature Engineering
- [ ] Signal context features:
  - Time of day, day of week
  - Market volatility (ATR, VIX equivalent)
  - Trend strength (ADX)
  - Recent price action
- [ ] Trader features:
  - Trader's recent win rate
  - Trader's average hold time
  - Trader's typical position size
  - Trader's style (scalper, swing, etc.)
- [ ] Consensus features:
  - Number of triggers
  - Quality of triggering traders
  - Speed of consensus formation
  - Position size distribution

#### 4.2 Model Training
- [ ] Collect labeled dataset (signal → outcome)
- [ ] Train classifier: signal → probability of success
- [ ] Cross-validate on historical data
- [ ] Regular retraining schedule (weekly?)

#### 4.3 Confidence Scoring
- [ ] AI adds confidence score to each signal
- [ ] Higher confidence = stronger consensus + favorable conditions
- [ ] Surface confidence in dashboard

#### 4.4 Dynamic Threshold Adjustment
- [ ] AI adjusts consensus thresholds based on conditions
- [ ] Tighter thresholds in choppy markets
- [ ] Looser thresholds in trending markets

#### 4.5 A/B Testing Framework
- [ ] Compare AI-filtered signals vs raw consensus signals
- [ ] Track performance differential
- [ ] Gradual rollout of AI improvements

### Open Questions (Phase 4)

1. **Model type**: What ML approach?
   - Logistic regression (simple, interpretable)?
   - Gradient boosting (XGBoost)?
   - Neural network?

2. **Training data**: How much history needed?
   - Minimum 100 signals?
   - 6 months of data?

3. **Feedback delay**: How to handle delayed outcomes?
   - Some signals take days to resolve
   - Online learning vs batch retraining?

---

## Phase 5: Advanced Intelligence

### Goal
Sophisticated pattern recognition and portfolio-level risk management.

### Tasks

#### 5.1 Trader Pattern Analysis
- [ ] Classify trader styles (scalper, day trader, swing)
- [ ] Identify trader's preferred setups
- [ ] Track trader's performance by market condition
- [ ] Detect trader behavior changes

#### 5.2 Market Regime Detection
- [ ] Classify market state (trending, ranging, volatile)
- [ ] Adjust signal parameters by regime
- [ ] Warn when regime changes

#### 5.3 Position Sizing
- [ ] Kelly criterion or fractional Kelly
- [ ] Size based on confidence score
- [ ] Account for correlation between signals

#### 5.4 Portfolio Management
- [ ] Max concurrent signals limit
- [ ] Exposure limits per symbol
- [ ] Drawdown-based position reduction

#### 5.5 Execution Optimization
- [ ] Optimal entry timing (TWAP, VWAP)
- [ ] Slippage estimation
- [ ] Execution quality tracking

---

## Technical Debt & Improvements

### Code Quality
- [ ] Add unit tests for consensus detection
- [ ] Add integration tests for signal flow
- [ ] Improve error handling in hl-decide
- [ ] Add circuit breakers for external API calls

### Performance
- [ ] Optimize fill aggregation for high-volume periods
- [ ] Add caching for leaderboard data
- [ ] Database query optimization for signal lookups

### Observability
- [ ] Add signal generation metrics
- [ ] Add consensus detection metrics
- [ ] Alerting for system health issues

---

## Configuration Reference

### Environment Variables (to be added)

```bash
# Consensus settings
CONSENSUS_MIN_TRADERS=3          # Minimum traders for consensus
CONSENSUS_TIME_WINDOW_MS=300000  # 5 minutes
CONSENSUS_TOP_N=20               # Track top N traders for consensus

# Signal settings
SIGNAL_DEFAULT_RR_RATIO=2        # Risk:Reward ratio for TP
SIGNAL_EXPIRY_HOURS=4            # Signal validity period
SIGNAL_MIN_CONFIDENCE=0.6        # Minimum confidence to emit signal

# AI settings (Phase 4)
AI_MODEL_PATH=/models/signal_classifier.pkl
AI_RETRAIN_INTERVAL_HOURS=168    # Weekly retraining
AI_MIN_TRAINING_SAMPLES=100
```

---

## Milestones

| Milestone | Target | Status |
|-----------|--------|--------|
| Phase 1: Foundation | - | ✅ Complete |
| Phase 2: MVP Signal Engine | TBD | 🔲 Not started |
| Phase 3: Performance Tracking | TBD | 🔲 Not started |
| Phase 4: AI Learning | TBD | 🔲 Not started |
| Phase 5: Advanced Features | TBD | 🔲 Not started |

---

## How to Resume Development

When resuming work on this project:

1. **Check this document** for current phase and open questions
2. **Review open questions** - ask for clarification if needed
3. **Check `docs/` folder** for additional context
4. **Run `docker compose up`** to start all services
5. **Dashboard**: http://localhost:4102/dashboard

### Key Files by Phase

**Phase 2 (Signal Engine)**:
- `services/hl-decide/app/main.py` - Signal generation logic
- `docker/postgres-init/` - New migration for signals table
- `services/hl-stream/public/dashboard.js` - Signal display

**Phase 3 (Performance)**:
- `services/hl-decide/app/main.py` - Outcome tracking
- New dashboard components for metrics

**Phase 4 (AI)**:
- New Python module for ML model
- Training pipeline scripts

---

*Last updated: November 2025*
