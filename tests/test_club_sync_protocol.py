import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location("protocol", Path(__file__).resolve().parents[1] / "raspechatka/club_sync_protocol.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class ProtocolTests(unittest.TestCase):
	def setUp(self):
		self.secret = "test-only-secret-not-production-000000"
		self.stamp = "1788850000"
		self.payload = json.dumps({"version": 1, "event_id": "test-1", "value": "Клуб"}, ensure_ascii=False)
		self.signature = hmac.new(self.secret.encode(), (self.stamp + "\n" + self.payload).encode(), hashlib.sha256).hexdigest()

	def test_signature(self):
		self.assertEqual(p.verify(self.payload, self.stamp, self.signature, self.secret, int(self.stamp))["event_id"], "test-1")

	def test_reject_tampering(self):
		with self.assertRaises(ValueError):
			p.verify(self.payload + " ", self.stamp, self.signature, self.secret, int(self.stamp))

	def test_reject_expired(self):
		with self.assertRaises(ValueError):
			p.verify(self.payload, self.stamp, self.signature, self.secret, int(self.stamp) + 301)

	def test_reject_missing_secret(self):
		with self.assertRaises(ValueError):
			p.verify(self.payload, self.stamp, self.signature, "", int(self.stamp))

	def test_boolean_formats(self):
		for value in [True, 1, 1.0, "TRUE", "да"]:
			self.assertTrue(p.truth(value))
		for value in [False, 0, "false", "0", None, "нет"]:
			self.assertFalse(p.truth(value))

	def test_identifier(self):
		self.assertEqual(p.identifier(123.0), "123")
		self.assertEqual(p.identifier("00123"), "00123")


if __name__ == "__main__":
	unittest.main()
