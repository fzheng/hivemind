"""
HL-Decide Service

Generates trading signals based on consensus scores from hl-sage.
Tracks signal outcomes and persists results for performance analysis.

Key responsibilities:
- Consume `b.scores.v1` and `c.fills.v1` events from NATS
- Generate trading signals when score and fill events align
- Publish `d.signals.v1` events for signal emission
- Track and close positions after timeout
- Publish `d.outcomes.v1` events with P&L results
- Persist tickets and outcomes to PostgreSQL

@module hl-decide
"""

import asyncio
import json
import os
from datetime import datetime, timedelta
from typing import Dict
from uuid import uuid4
from collections import OrderedDict

import asyncpg
import nats
from fastapi import FastAPI
from prometheus_client import Counter, Histogram, generate_latest, CollectorRegistry, CONTENT_TYPE_LATEST
from starlette.responses import Response

from contracts.py.models import FillEvent, ScoreEvent, SignalEvent, OutcomeEvent

SERVICE_NAME = "hl-decide"
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
DB_URL = os.getenv("DATABASE_URL", "postgresql://hlbot:hlbotpassword@localhost:5432/hlbot")
MAX_SCORES = int(os.getenv("MAX_SCORES", "500"))
MAX_FILLS = int(os.getenv("MAX_FILLS", "500"))

app = FastAPI(title="hl-decide", version="0.1.0")
scores: OrderedDict[str, ScoreEvent] = OrderedDict()
fills: OrderedDict[str, FillEvent] = OrderedDict()
pending_outcomes: Dict[str, asyncio.Task] = {}  # Track pending outcome tasks by ticket_id
registry = CollectorRegistry()
signal_counter = Counter("decide_signals_total", "Signals emitted", registry=registry)
outcome_counter = Counter("decide_outcomes_total", "Outcomes emitted", registry=registry)
decision_latency = Histogram(
    "decide_latency_seconds",
    "Latency between receiving score and emitting signal",
    registry=registry,
    buckets=(0.01, 0.05, 0.1, 0.5),
)


async def ensure_stream(js, name: str, subjects):
    """
    Ensures a NATS JetStream stream exists, creating it if necessary.

    Args:
        js: JetStream client
        name: Stream name
        subjects: List of subject patterns to capture
    """
    try:
        await js.stream_info(name)
    except Exception:
        await js.add_stream(name=name, subjects=subjects)


def pick_side(score: ScoreEvent) -> str:
    """
    Determines trading direction based on score value.

    Args:
        score: ScoreEvent containing the consensus score

    Returns:
        "long" if score >= 0, "short" otherwise
    """
    return "long" if score.score >= 0 else "short"


async def persist_ticket(conn, ticket_id: str, signal: SignalEvent):
    """
    Persists a signal ticket to the database.

    Args:
        conn: Database connection
        ticket_id: Unique ticket identifier
        signal: SignalEvent to persist
    """
    # Use model_dump_json() to properly serialize datetimes, then parse back for DB
    # This avoids TypeError from json.dumps on datetime objects
    payload_json = signal.model_dump_json()
    await conn.execute(
        """
        INSERT INTO tickets (id, ts, address, asset, side, payload)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        ticket_id,
        signal.signal_ts,
        signal.address,
        signal.asset,
        signal.side,
        payload_json,
    )


async def persist_outcome(conn, outcome: OutcomeEvent):
    """
    Persists a ticket outcome to the database.

    Args:
        conn: Database connection
        outcome: OutcomeEvent containing P&L and close reason
    """
    await conn.execute(
        """
        INSERT INTO ticket_outcomes (ticket_id, closed_ts, result_r, closed_reason, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (ticket_id) DO UPDATE SET
          closed_ts = EXCLUDED.closed_ts,
          result_r = EXCLUDED.result_r,
          closed_reason = EXCLUDED.closed_reason,
          notes = EXCLUDED.notes
        """,
        outcome.ticket_id,
        outcome.closed_ts,
        outcome.result_r,
        outcome.closed_reason,
        outcome.notes,
    )


async def calculate_pnl(signal: SignalEvent, entry_price: float, exit_price: float) -> float:
    """
    Calculate P&L as a fraction (R-multiple).
    For long: (exit - entry) / entry
    For short: (entry - exit) / entry
    """
    if entry_price <= 0 or exit_price <= 0:
        return 0.0

    if signal.side == "long":
        return (exit_price - entry_price) / entry_price
    else:  # short
        return (entry_price - exit_price) / entry_price


async def get_current_price(asset: str) -> float:
    """
    Fetch current price from the most recent fill for this asset.
    In a production system, this would query a price feed or market data API.
    """
    try:
        async with app.state.db.acquire() as conn:
            result = await conn.fetchrow(
                """
                SELECT payload->>'priceUsd' as price
                FROM hl_events
                WHERE type = 'trade' AND symbol = $1
                ORDER BY at DESC
                LIMIT 1
                """,
                asset
            )
            if result and result['price']:
                return float(result['price'])
    except Exception:
        pass
    return 0.0


async def emit_signal(address: str):
    """
    Emits a trading signal if both score and fill data are available.
    Creates a ticket and schedules outcome tracking.

    Args:
        address: Ethereum address to emit signal for
    """
    score = scores.get(address)
    fill = fills.get(address)
    if not score or not fill:
        return
    with decision_latency.time():
        signal_ts = datetime.utcnow()
        ticket_id = str(uuid4())

        # Store entry price in payload for later P&L calculation
        entry_price = fill.price if hasattr(fill, 'price') and fill.price else 0.0

        signal = SignalEvent(
            ticket_id=ticket_id,
            address=address,
            asset=fill.asset,
            side=pick_side(score),
            confidence=min(max(abs(score.score), 0.1), 1.0),
            score_ts=score.ts,
            signal_ts=signal_ts,
            expires_at=signal_ts + timedelta(seconds=10),
            reason="consensus",
            payload={"fill_id": fill.fill_id, "weight": score.weight, "entry_price": entry_price},
        )
        await app.state.js.publish("d.signals.v1", signal.model_dump_json().encode("utf-8"))
        async with app.state.db.acquire() as conn:
            await persist_ticket(conn, ticket_id, signal)
        signal_counter.inc()

        # Track the outcome task to prevent duplicates and ensure cleanup
        if ticket_id not in pending_outcomes:
            task = asyncio.create_task(schedule_close(ticket_id, signal))
            pending_outcomes[ticket_id] = task


async def schedule_close(ticket_id: str, signal: SignalEvent):
    """
    Schedules automatic position close after timeout period.
    Calculates P&L and publishes outcome event.

    Args:
        ticket_id: Unique ticket identifier
        signal: Original SignalEvent containing entry price
    """
    try:
        await asyncio.sleep(10)

        # Get entry price from signal payload
        entry_price = signal.payload.get('entry_price', 0.0) if isinstance(signal.payload, dict) else 0.0

        # Fetch current price
        exit_price = await get_current_price(signal.asset)

        # Calculate actual P&L
        result_r = await calculate_pnl(signal, entry_price, exit_price)

        outcome = OutcomeEvent(
            ticket_id=ticket_id,
            closed_ts=datetime.utcnow(),
            result_r=result_r,
            closed_reason="timebox",
            notes=f"Timeboxed exit: entry={entry_price:.2f}, exit={exit_price:.2f}, pnl_r={result_r:.4f}",
        )
        await app.state.js.publish("d.outcomes.v1", outcome.model_dump_json().encode("utf-8"))
        async with app.state.db.acquire() as conn:
            await persist_outcome(conn, outcome)
        outcome_counter.inc()
    finally:
        # Clean up the task from pending_outcomes to prevent memory leaks
        pending_outcomes.pop(ticket_id, None)


async def persist_score(address: str, score: ScoreEvent) -> None:
    """Persist score to database for recovery."""
    try:
        async with app.state.db.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO decide_scores (address, score, weight, rank, window_s, ts, meta, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                ON CONFLICT (address) DO UPDATE SET
                    score = EXCLUDED.score,
                    weight = EXCLUDED.weight,
                    rank = EXCLUDED.rank,
                    window_s = EXCLUDED.window_s,
                    ts = EXCLUDED.ts,
                    meta = EXCLUDED.meta,
                    updated_at = EXCLUDED.updated_at
                """,
                address.lower(),
                score.score,
                score.weight,
                score.rank,
                score.window_s,
                score.ts,
                json.dumps(score.meta) if isinstance(score.meta, dict) else "{}",
            )
    except Exception as e:
        print(f"[hl-decide] Failed to persist score for {address}: {e}")


async def persist_fill(address: str, fill: FillEvent) -> None:
    """Persist fill to database for recovery."""
    try:
        async with app.state.db.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO decide_fills (address, fill_id, asset, side, size, price, ts, meta, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                ON CONFLICT (address) DO UPDATE SET
                    fill_id = EXCLUDED.fill_id,
                    asset = EXCLUDED.asset,
                    side = EXCLUDED.side,
                    size = EXCLUDED.size,
                    price = EXCLUDED.price,
                    ts = EXCLUDED.ts,
                    meta = EXCLUDED.meta,
                    updated_at = EXCLUDED.updated_at
                """,
                address.lower(),
                fill.fill_id,
                fill.asset,
                fill.side,
                fill.size,
                fill.price if hasattr(fill, 'price') else None,
                fill.ts,
                json.dumps(fill.meta) if isinstance(fill.meta, dict) else "{}",
            )
    except Exception as e:
        print(f"[hl-decide] Failed to persist fill for {address}: {e}")


async def restore_state() -> tuple[int, int]:
    """Restore scores and fills from database on startup."""
    score_count = 0
    fill_count = 0
    try:
        async with app.state.db.acquire() as conn:
            # Restore scores
            score_rows = await conn.fetch(
                """
                SELECT address, score, weight, rank, window_s, ts, meta
                FROM decide_scores
                WHERE updated_at > NOW() - INTERVAL '24 hours'
                ORDER BY updated_at DESC
                LIMIT $1
                """,
                MAX_SCORES,
            )
            for row in score_rows:
                score = ScoreEvent(
                    address=row["address"],
                    score=float(row["score"]),
                    weight=float(row["weight"]),
                    rank=int(row["rank"]),
                    window_s=int(row["window_s"]),
                    ts=row["ts"],
                    meta=json.loads(row["meta"]) if row["meta"] else {},
                )
                scores[row["address"]] = score
                score_count += 1

            # Restore fills
            fill_rows = await conn.fetch(
                """
                SELECT address, fill_id, asset, side, size, price, ts, meta
                FROM decide_fills
                WHERE updated_at > NOW() - INTERVAL '24 hours'
                ORDER BY updated_at DESC
                LIMIT $1
                """,
                MAX_FILLS,
            )
            for row in fill_rows:
                fill = FillEvent(
                    fill_id=row["fill_id"],
                    address=row["address"],
                    asset=row["asset"],
                    side=row["side"],
                    size=float(row["size"]),
                    price=float(row["price"]) if row["price"] is not None else 0.0,
                    ts=row["ts"],
                    meta=json.loads(row["meta"]) if row["meta"] else {},
                )
                fills[row["address"]] = fill
                fill_count += 1

    except Exception as e:
        print(f"[hl-decide] Failed to restore state: {e}")

    return score_count, fill_count


def enforce_limits():
    """Enforce memory limits on scores and fills using LRU eviction."""
    while len(scores) > MAX_SCORES:
        scores.popitem(last=False)  # Remove oldest
    while len(fills) > MAX_FILLS:
        fills.popitem(last=False)  # Remove oldest


async def handle_score(msg):
    """
    Handles incoming score events from hl-sage.
    Updates score state and attempts to emit signal.

    Args:
        msg: NATS message containing ScoreEvent JSON
    """
    data = ScoreEvent.model_validate_json(msg.data.decode())
    # Move to end (most recently used)
    if data.address in scores:
        scores.move_to_end(data.address)
    scores[data.address] = data

    # Persist to database
    await persist_score(data.address, data)

    enforce_limits()
    await emit_signal(data.address)


async def handle_fill(msg):
    """
    Handles incoming fill events from hl-stream.
    Updates fill state and attempts to emit signal.

    Args:
        msg: NATS message containing FillEvent JSON
    """
    data = FillEvent.model_validate_json(msg.data.decode())
    # Move to end (most recently used)
    if data.address in fills:
        fills.move_to_end(data.address)
    fills[data.address] = data

    # Persist to database
    await persist_fill(data.address, data)

    enforce_limits()
    await emit_signal(data.address)


@app.on_event("startup")
async def startup():
    try:
        # Connect to database first
        app.state.db = await asyncpg.create_pool(DB_URL)

        # Restore state from database
        score_count, fill_count = await restore_state()
        print(f"[hl-decide] Restored {score_count} scores and {fill_count} fills from database")

        # Connect to NATS
        app.state.nc = await nats.connect(NATS_URL)
        app.state.js = app.state.nc.jetstream()
        await ensure_stream(app.state.js, "HL_D", ["d.signals.v1", "d.outcomes.v1"])
        await app.state.nc.subscribe("b.scores.v1", cb=handle_score)
        await app.state.nc.subscribe("c.fills.v1", cb=handle_fill)
    except Exception as e:
        print(f"[hl-decide] Fatal startup error: {e}")
        raise


@app.on_event("shutdown")
async def shutdown():
    if hasattr(app.state, "nc"):
        await app.state.nc.drain()
    if hasattr(app.state, "db"):
        await app.state.db.close()


@app.get("/healthz")
async def health():
    return {"status": "ok", "scores": len(scores), "fills": len(fills)}


@app.get("/metrics")
async def metrics():
    return Response(content=generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
