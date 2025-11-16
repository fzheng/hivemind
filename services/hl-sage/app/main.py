import os
from datetime import datetime
from typing import Dict, List, Any

import nats
from fastapi import FastAPI, HTTPException, Query
from prometheus_client import Counter, Histogram, generate_latest, CollectorRegistry, CONTENT_TYPE_LATEST
from starlette.responses import Response

from contracts.py.models import CandidateEvent, ScoreEvent, FillEvent

SERVICE_NAME = "hl-sage"
OWNER_TOKEN = os.getenv("OWNER_TOKEN", "dev-owner")
NATS_URL = os.getenv("NATS_URL", "nats://localhost:4222")

app = FastAPI(title="hl-sage", version="0.1.0")
scores: Dict[str, ScoreEvent] = {}
tracked_addresses: Dict[str, Dict[str, Any]] = {}

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


async def handle_candidate(msg):
    with score_latency.time():
        data = CandidateEvent.model_validate_json(msg.data.decode())
        candidate_counter.inc()
        leaderboard_meta = data.meta.get("leaderboard") if isinstance(data.meta, dict) else {}
        weight = float(leaderboard_meta.get("weight") or data.score_hint or 0.1)
        weight = max(0.05, min(1.0, weight))
        rank = int(leaderboard_meta.get("rank") or 999)
        period = int(leaderboard_meta.get("period_days") or 30)
        tracked_addresses[data.address.lower()] = {
            "weight": weight,
            "rank": rank,
            "period": period,
            "position": 0.0,
            "updated": datetime.utcnow(),
        }


async def handle_fill(msg):
    data = FillEvent.model_validate_json(msg.data.decode())
    state = tracked_addresses.get(data.address.lower())
    if not state:
        return
    side_multiplier = 1 if data.side == "buy" else -1
    delta = side_multiplier * float(data.size or 0)
    state["position"] = state.get("position", 0.0) + delta
    base_score = max(-1.0, min(1.0, state["weight"] * side_multiplier))
    event = ScoreEvent(
        address=data.address,
        score=base_score,
        weight=state["weight"],
        rank=state["rank"],
        window_s=60,
        ts=datetime.utcnow(),
        meta={
            "source": "leaderboard",
            "period": state["period"],
            "position": state["position"],
            "fill": data.model_dump(),
        },
    )
    scores[data.address] = event
    await app.state.js.publish(
        "b.scores.v1",
        event.model_dump_json().encode("utf-8"),
    )
    score_counter.inc()


@app.on_event("startup")
async def startup_event():
    app.state.nc = await nats.connect(NATS_URL)
    app.state.js = app.state.nc.jetstream()
    await ensure_stream(app.state.js, "HL_B", ["b.scores.v1"])
    await app.state.nc.subscribe("a.candidates.v1", cb=handle_candidate)
    await app.state.nc.subscribe("c.fills.v1", cb=handle_fill)


@app.on_event("shutdown")
async def shutdown_event():
    if hasattr(app.state, "nc"):
        await app.state.nc.drain()


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "scores": len(scores)}


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
