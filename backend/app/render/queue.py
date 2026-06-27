"""Asyncio-based render queue. Phase 1 implementation."""
from __future__ import annotations

import asyncio
import uuid
from typing import Optional

from app.models.ir import RenderJob


_queue: asyncio.Queue = asyncio.Queue()
_jobs: dict[str, RenderJob] = {}
_subscribers: dict[str, list[asyncio.Queue]] = {}


def new_job_id() -> str:
    return str(uuid.uuid4())[:12]


def enqueue(job: RenderJob) -> None:
    _jobs[job.job_id] = job
    _queue.put_nowait(job)


def get_job(job_id: str) -> Optional[RenderJob]:
    return _jobs.get(job_id)


def update_job(job_id: str, **kwargs) -> None:
    job = _jobs.get(job_id)
    if job:
        for k, v in kwargs.items():
            setattr(job, k, v)
        _broadcast(job_id, {k: v for k, v in kwargs.items()})


def subscribe(job_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.setdefault(job_id, []).append(q)
    return q


def unsubscribe(job_id: str, q: asyncio.Queue) -> None:
    subs = _subscribers.get(job_id, [])
    if q in subs:
        subs.remove(q)


def _broadcast(job_id: str, event: dict) -> None:
    for q in list(_subscribers.get(job_id, [])):
        q.put_nowait(event)


async def get_next() -> RenderJob:
    return await _queue.get()


def task_done() -> None:
    _queue.task_done()
