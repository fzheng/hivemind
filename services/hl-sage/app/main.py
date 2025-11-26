import os
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Any
from collections import OrderedDict

import asyncpg
import nats
from fastapi import FastAPI, HTTPException, Query
from prometheus_client import Counter, Histogram, generate_latest, CollectorRegistry, CONTENT_TYPE_LATEST
from starlette.responses import Response

from contracts.py.models import CandidateEvent, ScoreEvent, FillEvent

SERVICE_NAME = "hl-sage"
OWNER_TOKEN = os.getenv("OWNER_TOKEN", "dev-owner")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")
DB_URL = os.getenv("DATABASE_URL", "postgresql://hlbot:hlbotpassword@localhost:5432/hlbot")
MAX_TRACKED_ADDRESSES = int(os.getenv("MAX_TRACKED_ADDRESSES", "1000"))
MAX_SCORES = int(os.getenv("MAX_SCORES", "500"))
STALE_THRESHOLD_HOURS = int(os.getenv("STALE_THRESHOLD_HOURS", "24"))

app = FastAPI(title="hl-sage", version="0.1.0")

# Use OrderedDict for LRU behavior
scores: OrderedDict[str, ScoreEvent] = OrderedDict()
tracked_addresses: OrderedDict[str, Dict[str, Any]] = OrderedDict()

registry = CollectorRegistry()
candidate_counter = Counter(
    "sage_candidates_total", "Number of candidate messages processed", registry=registry
)
score_counter = Counter(
    "sage_scores_total", "Number of scores published", registry=registry
)
score_latency = Histogram(
    "sage_score_latency_seconds", "Latency to process a candidate", registry=registry, buckets=(0.01, 0.05, 0.1, 0.5)
)


async def ensure_stream(js, name: str, subjects: List[str]) -> None:
    try:
        await js.stream_info(name)
    except Exception:
        await js.add_stream(name=name, subjects=subjects)


async def persist_tracked_address(address: str, state: Dict[str, Any]) -> None:
    """Persist tracked address state to database for recovery."""
    try:
        async with app.state.db.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO sage_tracked_addresses (address, weight, rank, period, position, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (address) DO UPDATE SET
                    weight = EXCLUDED.weight,
                    rank = EXCLUDED.rank,
                    period = EXCLUDED.period,
                    position = EXCLUDED.position,
                    updated_at = EXCLUDED.updated_at
                """,
                address,
                state["weight"],
                state["rank"],
                state["period"],
                state["position"],
                state["updated"],
            )
    except Exception as e:
        print(f"[hl-sage] Failed to persist tracked address {address}: {e}")


async def restore_tracked_addresses() -> int:
    """Restore tracked addresses from database on startup."""
    try:
        async with app.state.db.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT address, weight, rank, period, position, updated_at
                FROM sage_tracked_addresses
                WHERE updated_at > NOW() - INTERVAL '24 hours'
                ORDER BY updated_at DESC
                LIMIT $1
                """,
                MAX_TRACKED_ADDRESSES,
            )
            for row in rows:
                addr = row["address"].lower()
                tracked_addresses[addr] = {
                    "weight": float(row["weight"]),
                    "rank": int(row["rank"]),
                    "period": int(row["period"]),
                    "position": float(row["position"]),
                    "updated": row["updated_at"],
                }
            return len(rows)
    except Exception as e:
        print(f"[hl-sage] Failed to restore tracked addresses: {e}")
        return 0


def evict_stale_entries():
    """Remove stale entries to prevent unbounded memory growth."""
    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(hours=STALE_THRESHOLD_HOURS)

    # Remove stale tracked addresses
    stale_addrs = [
        addr for addr, data in tracked_addresses.items()
        if data.get("updated", now) < stale_cutoff
    ]
    for addr in stale_addrs:
        tracked_addresses.pop(addr, None)

    # Enforce max limits using LRU (OrderedDict maintains insertion order)
    while len(tracked_addresses) > MAX_TRACKED_ADDRESSES:
        tracked_addresses.popitem(last=False)  # Remove oldest

    while len(scores) > MAX_SCORES:
        scores.popitem(last=False)  # Remove oldest


async def handle_candidate(msg):
    with score_latency.time():
        data = CandidateEvent.model_validate_json(msg.data.decode())
        candidate_counter.inc()
        leaderboard_meta = (data.meta.get("leaderboard") if isinstance(data.meta, dict) else None) or {}
        weight = float(leaderboard_meta.get("weight") or data.score_hint or 0.1)
        weight = max(0.05, min(1.0, weight))
        rank = int(leaderboard_meta.get("rank") or 999)
        period = int(leaderboard_meta.get("period_days") or 30)

        addr_lower = data.address.lower()
        # Move to end (most recently used)
        if addr_lower in tracked_addresses:
            tracked_addresses.move_to_end(addr_lower)

        state = {
            "weight": weight,
            "rank": rank,
            "period": period,
            "position": 0.0,
            "updated": datetime.now(timezone.utc),
        }
        tracked_addresses[addr_lower] = state

        # Persist to database for recovery
        await persist_tracked_address(addr_lower, state)

        evict_stale_entries()


async def handle_fill(msg):
    data = FillEvent.model_validate_json(msg.data.decode())
    addr_lower = data.address.lower()
    state = tracked_addresses.get(addr_lower)
    if not state:
        return

    # Move to end (most recently used)
    if addr_lower in tracked_addresses:
        tracked_addresses.move_to_end(addr_lower)

    side_multiplier = 1 if data.side == "buy" else -1
    delta = side_multiplier * float(data.size or 0)
    state["position"] = state.get("position", 0.0) + delta
    state["updated"] = datetime.now(timezone.utc)

    # Persist updated position to database
    await persist_tracked_address(addr_lower, state)

    base_score = max(-1.0, min(1.0, state["weight"] * side_multiplier))
    event = ScoreEvent(
        address=data.address,
        score=base_score,
        weight=state["weight"],
        rank=state["rank"],
        window_s=60,
        ts=datetime.now(timezone.utc),
        meta={
            "source": "leaderboard",
            "period": state["period"],
            "position": state["position"],
            "fill": data.model_dump(),
        },
    )

    # Move to end (most recently used)
    if data.address in scores:
        scores.move_to_end(data.address)

    scores[data.address] = event
    await app.state.js.publish(
        "b.scores.v1",
        event.model_dump_json().encode("utf-8"),
    )
    score_counter.inc()


@app.on_event("startup")
async def startup_event():
    try:
        # Connect to database first
        app.state.db = await asyncpg.create_pool(DB_URL)

        # Restore tracked addresses from database
        restored = await restore_tracked_addresses()
        print(f"[hl-sage] Restored {restored} tracked addresses from database")

        # Connect to NATS
        app.state.nc = await nats.connect(NATS_URL)
        app.state.js = app.state.nc.jetstream()
        await ensure_stream(app.state.js, "HL_B", ["b.scores.v1"])
        await app.state.nc.subscribe("a.candidates.v1", cb=handle_candidate)
        await app.state.nc.subscribe("c.fills.v1", cb=handle_fill)
    except Exception as e:
        print(f"[hl-sage] Fatal startup error: {e}")
        raise


@app.on_event("shutdown")
async def shutdown_event():
    if hasattr(app.state, "nc"):
        await app.state.nc.drain()
    if hasattr(app.state, "db"):
        await app.state.db.close()


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "scores": len(scores), "tracked_addresses": len(tracked_addresses)}


@app.get("/metrics")
async def metrics():
    data = generate_latest(registry)
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


@app.get("/ranks/top")
async def ranks_top(n: int = Query(default=20, ge=1, le=100)):
    if not scores:
        raise HTTPException(status_code=503, detail="no scores yet")
    ordered = sorted(scores.values(), key=lambda s: s.score, reverse=True)
    return {"count": len(ordered), "entries": ordered[:n]}
