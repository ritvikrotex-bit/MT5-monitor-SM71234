from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    copier_secret: str
    """Shared secret the web app sends as X-Copier-Secret."""

    copier_host: str = "127.0.0.1"
    copier_port: int = 8766

    terminals_root: Path = Path(r"C:\mt5-terminals")
    """Where each account's portable MT5 terminal is provisioned."""

    state_dir: Path = Path("state")
    """Ticket maps and per-link runtime state."""

    poll_interval: float = 1.0
    """Seconds between reconciliation cycles."""

    snapshot_timeout: float = 45.0
    order_timeout: float = 60.0

    dry_run_default: bool = True
    """New links start in dry run: they log what they would do and send nothing."""


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
