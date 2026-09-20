import sys
import types
import unittest

# The bundled workspace test runtime includes Pydantic but not the connector's
# optional settings package.  Production installs it via requirements.txt; this
# narrow shim lets the provider's pure read-path tests run offline as well.
try:
    import pydantic_settings  # noqa: F401
except ModuleNotFoundError:
    module = types.ModuleType("pydantic_settings")

    class BaseSettings:
        def __init__(self, **_kwargs):
            pass

    module.BaseSettings = BaseSettings
    module.SettingsConfigDict = lambda **kwargs: kwargs
    sys.modules["pydantic_settings"] = module

from connector.providers.real import RealProvider, _ROSTERS
from connector.schemas import Credentials


class Object:
    def __init__(self, **values):
        self.__dict__.update(values)


class Manager:
    def __init__(self):
        self.users = [
            Object(Login=7, Name="Jane Trader", Group="real\\pro", Balance=100, Leverage=100),
            Object(Login=8, Name="John Smith", Group="real\\standard", Balance=200, Leverage=200),
        ]

    def UserGet(self, login):
        return next((user for user in self.users if user.Login == login), None)

    def UserAccountGet(self, login):
        return Object(Balance=110, Equity=125, Margin=25, Profit=15)

    def UserGetByGroup(self, mask):
        self.last_group_mask = mask
        return self.users

    def PositionGet(self, login):
        self.last_position_login = login
        return [
            Object(
                Position=101,
                Symbol="EURUSD",
                Action=0,
                Volume=15000,
                PriceOpen=1.1,
                PriceCurrent=1.2,
                PriceSL=1.0,
                PriceTP=1.3,
                Profit=15,
            )
        ]


class RealProviderReadTests(unittest.TestCase):
    def setUp(self):
        self.manager = Manager()
        self.provider = RealProvider()
        self.provider._read = lambda _creds, operation: operation(self.manager)
        self.creds = Credentials(server="example.mt5.test", login=1, password="test-only-not-a-credential")
        _ROSTERS.clear()

    def test_name_search_caches_full_roster_and_limits_returned_data(self):
        result = self.provider.search(self.creds, "jane", "name")
        self.assertEqual(self.manager.last_group_mask, "*")
        self.assertEqual([client.login for client in result.clients], [7])

        self.manager.users = []
        cached = self.provider.search(self.creds, "john", "name")
        self.assertEqual([client.login for client in cached.clients], [8])

    def test_account_uses_live_account_snapshot(self):
        result = self.provider.get_account(self.creds, 7)
        self.assertEqual(result.client.balance, 110)
        self.assertEqual(result.client.equity, 125)
        self.assertEqual(result.client.margin, 25)
        self.assertEqual(result.client.floatingProfit, 15)

    def test_positions_use_read_only_position_get_and_normalize_fields(self):
        result = self.provider.get_positions(self.creds, 7)
        self.assertEqual(self.manager.last_position_login, 7)
        self.assertEqual(result.positions[0].positionId, "101")
        self.assertEqual(result.positions[0].direction, "BUY")
        self.assertEqual(result.positions[0].volume, 1.5)
        self.assertTrue(result.slTpAvailable)


if __name__ == "__main__":
    unittest.main()
