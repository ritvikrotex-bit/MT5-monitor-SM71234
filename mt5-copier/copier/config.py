from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    copier_secret: str
    """Shared secret the web app sends as X-Copier-Secret."""

    copier_host: str = "127.0.0.1"
    copier_port: int = 8766

    connector_url: str = "http://127.0.0.1:8765"
    """mt5-connector, which reads master accounts over the Manager API."""

    connector_secret: str = ""
    """Shared secret for the connector. Required for manager-based masters."""

    terminals_root: Path = Path(r"C:\mt5-terminals")
    """Where each account's portable MT5 terminal is provisioned."""

    @field_validator("terminals_root")
    @classmethod
    def _terminals_root_must_be_absolute(cls, value: Path) -> Path:
        # Each terminal is ~230 MB. A relative path — including a Windows
        # drive-relative one like "C:mt5-terminals", which is what a lost
        # backslash in .env produces — would quietly scatter them into
        # whatever directory the service happened to start from. Fail loudly
        # instead of filling a disk somewhere nobody is looking.
        if not value.is_absolute():
            raise ValueError(
                f"TERMINALS_ROOT must be an absolute path, got {str(value)!r}. "
                r"On Windows use a full path such as C:\mt5-terminals "
                "(note the backslash after the drive letter)."
            )
        return value

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
