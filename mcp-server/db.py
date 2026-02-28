from __future__ import annotations

import json
import os
from typing import Optional

import asyncpg
from asyncpg import Pool


class Database:
    """Asyncpg pool manager for MCP tools."""

    def __init__(
        self,
        dsn: str | None = None,
        min_size: int = 1,
        max_size: int = 10,
        command_timeout: float = 30.0,
    ) -> None:
        self._dsn = dsn or os.getenv("DATABASE_URL", "")
        self._min_size = min_size
        self._max_size = max_size
        self._command_timeout = command_timeout
        self._pool: Optional[Pool] = None

    async def connect(self) -> None:
        if self._pool is not None:
            return
        if not self._dsn:
            raise RuntimeError("DATABASE_URL is required")

        async def _init_connection(conn: asyncpg.Connection) -> None:
            await conn.set_type_codec(
                "json",
                schema="pg_catalog",
                encoder=json.dumps,
                decoder=json.loads,
            )
            await conn.set_type_codec(
                "jsonb",
                schema="pg_catalog",
                encoder=json.dumps,
                decoder=json.loads,
            )

        self._pool = await asyncpg.create_pool(
            dsn=self._dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            command_timeout=self._command_timeout,
            init=_init_connection,
        )

    async def close(self) -> None:
        if self._pool is None:
            return
        await self._pool.close()
        self._pool = None

    @property
    def pool(self) -> Pool:
        if self._pool is None:
            raise RuntimeError("Database pool is not initialized")
        return self._pool


__all__ = ["Database"]
