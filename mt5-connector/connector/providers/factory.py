from __future__ import annotations

from connector.providers.base import Provider


def get_provider() -> Provider:
    from connector.providers.real import RealProvider

    return RealProvider()
