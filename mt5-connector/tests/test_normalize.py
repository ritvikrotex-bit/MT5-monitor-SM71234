import unittest

from connector.normalize import position_from_mt, volume_lots


class Object:
    def __init__(self, **values):
        self.__dict__.update(values)


class NormalizeTests(unittest.TestCase):
    def test_volume_ext_is_precise_lot_value(self):
        self.assertEqual(volume_lots(Object(VolumeExt=250000000, Volume=25000)), 2.5)

    def test_volume_uses_verified_fixed_point_scale(self):
        self.assertEqual(volume_lots(Object(Volume=12500)), 1.25)

    def test_position_keeps_current_price_unavailable(self):
        position = position_from_mt(
            Object(
                PositionID=7,
                Symbol="EURUSD",
                Type=0,
                Volume=1.0,
                PriceOpen=1.1,
                Profit=3.5,
            )
        )
        self.assertEqual(position.direction, "BUY")
        self.assertIsNone(position.currentPrice)

    def test_unknown_direction_is_rejected(self):
        with self.assertRaises(ValueError):
            position_from_mt(
                Object(PositionID=7, Symbol="EURUSD", Type=9, Volume=1.0, PriceOpen=1.1, Profit=0)
            )


if __name__ == "__main__":
    unittest.main()
