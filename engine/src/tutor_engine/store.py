"""SQLite persistence: one JSON state row per (learner, course)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time

from tutor_engine.models import Progress

_SCHEMA = """
CREATE TABLE IF NOT EXISTS progress (
    learner TEXT NOT NULL,
    course TEXT NOT NULL,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (learner, course)
);
"""


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path, timeout=10, isolation_level=None)

    @contextmanager
    def transaction(self, learner: str, course: str) -> Iterator[Progress]:
        """Load, yield for mutation, then save; all under one write lock."""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT state_json, revision FROM progress WHERE learner = ? AND course = ?",
                (learner, course),
            ).fetchone()
            progress = Progress.from_dict(json.loads(row[0])) if row else Progress()
            before = json.dumps(progress.to_dict(), sort_keys=True)
            yield progress
            after = json.dumps(progress.to_dict(), sort_keys=True)
            if after != before:
                conn.execute(
                    "INSERT INTO progress (learner, course, state_json, revision, updated_at) "
                    "VALUES (?, ?, ?, 1, ?) ON CONFLICT (learner, course) DO UPDATE SET "
                    "state_json = excluded.state_json, revision = revision + 1, "
                    "updated_at = excluded.updated_at",
                    (learner, course, after, time.time()),
                )
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()
