from __future__ import annotations

import os

from openai import AsyncOpenAI


class QueryEmbedder:
    """Query embedder backed by OpenAI text-embedding-3-small."""

    def __init__(self, api_key: str | None = None, model: str = "text-embedding-3-small") -> None:
        self._api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        self._model = model
        self._client = AsyncOpenAI(api_key=self._api_key) if self._api_key else None

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def embed_query(self, query: str) -> list[float]:
        if not query.strip():
            raise ValueError("Query cannot be empty")
        if self._client is None:
            raise RuntimeError("OPENAI_API_KEY is required for vector search")

        response = await self._client.embeddings.create(
            model=self._model,
            input=query,
        )
        return list(response.data[0].embedding)


__all__ = ["QueryEmbedder"]
