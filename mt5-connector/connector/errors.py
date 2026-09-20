from __future__ import annotations


class ConnectorError(RuntimeError):
    code = "CONNECTOR_ERROR"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class AccountNotFound(ConnectorError):
    code = "CLIENT_NOT_FOUND"


class InvalidCredentials(ConnectorError):
    code = "INVALID_CREDENTIALS"


class BrokerUnavailable(ConnectorError):
    code = "BROKER_UNAVAILABLE"
