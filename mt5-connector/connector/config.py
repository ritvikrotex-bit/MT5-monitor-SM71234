from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    connector_secret: str
    mt5_timeout_ms: int = 30000
    mt5_keepalive_sec: int = 60
    mt5_session_ttl: int = 0
    # Hard cap for group/name scans so one search cannot dump the whole book.
    mt5_search_limit: int = 200


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
