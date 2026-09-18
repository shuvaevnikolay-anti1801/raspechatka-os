from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka import club_cors
from raspechatka.api import clients


class Row(dict):
	__getattr__ = dict.get
	__setattr__ = dict.__setitem__


class ClientStub(Row):
	def set(self, key, value):
		self[key] = value

	def issue_session(self):
		self.session_token = "session-token"
		return self.session_token

	def issue_channel_token(self):
		self.channel_token = "channel-token"
		return self.channel_token

	def save(self, **kwargs):
		self.saved_with = kwargs


class TestPublicClubGateway(TestCase):
	def test_unknown_phone_discloses_no_client_data(self):
		fake = SimpleNamespace(db=SimpleNamespace(get_value=Mock(return_value=None)))
		with patch.object(clients, "frappe", fake):
			result = clients._check_phone("8 (906) 123-45-67")
		self.assertEqual(
			result,
			{"ok": True, "exists": False, "can_register": True, "authenticated": False},
		)
		self.assertNotIn("name", result)
		self.assertNotIn("discount", result)

	def test_existing_phone_without_token_requires_verification(self):
		fake = SimpleNamespace(db=SimpleNamespace(get_value=Mock(return_value="CLIENT-1")))
		with patch.object(clients, "frappe", fake):
			result = clients._check_phone("+79061234567")
		self.assertTrue(result["exists"])
		self.assertTrue(result["verification_required"])
		self.assertNotIn("client_id", result)

	def test_open_client_binds_new_link_and_renews_session(self):
		doc = SimpleNamespace(
			name="CLIENT-1",
			client_id="RP-000001",
			client_name="Иван",
			discount_percent=5,
			active_channels=2,
			primary_channel="Telegram",
			backup_channel="VK",
			telegram_active=1,
			max_active=0,
			vk_active=1,
			flags=Row(),
			issue_session=Mock(return_value="session-new"),
			save=Mock(),
		)
		fake_db = SimpleNamespace(
			get_value=Mock(side_effect=["CLIENT-1", None]),
			exists=Mock(return_value=False),
		)
		log_doc = SimpleNamespace(insert=Mock())
		fake = SimpleNamespace(db=fake_db, get_doc=Mock(side_effect=[doc, log_doc, log_doc]))
		with (
			patch.object(clients, "frappe", fake),
			patch.object(clients, "now_datetime", return_value="2026-09-18 10:00:00"),
		):
			result = clients._open_client(
				{"phone": "89061234567", "link_token": "new-link-token-12345", "source": "Tilda"}
			)
		self.assertTrue(result["ok"])
		self.assertEqual(result["link_token"], "new-link-token-12345")
		self.assertEqual(result["session_token"], "session-new")
		self.assertEqual(doc.link_token, "new-link-token-12345")
		self.assertTrue(doc.flags.club_direct_update)
		doc.save.assert_called_once_with(ignore_permissions=True)

	def test_consent_submission_is_idempotent(self):
		fake = SimpleNamespace(db=SimpleNamespace(exists=Mock(return_value=True)), get_doc=Mock())
		with patch.object(clients, "frappe", fake):
			created = clients._record_consent(
				"CLIENT-1", "Персональные данные", True, "1.0", submission_id="submission-1"
			)
		self.assertFalse(created)
		fake.get_doc.assert_not_called()

	def test_event_details_remove_public_secrets(self):
		result = clients._safe_details(
			{"event": "connected", "link_token": "secret", "session_token": "secret-2"}
		)
		self.assertEqual(result, {"event": "connected"})

	def test_register_writes_three_consents_and_ignores_external_discount(self):
		doc = ClientStub(
			name="CLIENT-1",
			client_id="RP-000001",
			client_name="Иван",
			discount_percent=0,
			active_channels=0,
			primary_channel="",
			backup_channel="",
			telegram_active=0,
			max_active=0,
			vk_active=0,
			flags=Row(),
		)
		settings = SimpleNamespace(
			personal_data_required=1,
			marketing_required=0,
			club_rules_required=1,
			personal_data_version="1",
			marketing_version="1",
			club_rules_version="1",
			personal_data_url="/pd",
			marketing_url="/ads",
			club_rules_url="/rules",
		)
		fake = SimpleNamespace(
			db=SimpleNamespace(get_value=Mock(return_value=None)),
			parse_json=Mock(side_effect=lambda value: value),
			get_single=Mock(return_value=settings),
			new_doc=Mock(return_value=doc),
			generate_hash=Mock(return_value="generated-link-token-123456"),
			local=SimpleNamespace(request_ip="127.0.0.1"),
			get_request_header=Mock(return_value="Browser"),
		)
		with (
			patch.object(clients, "frappe", fake),
			patch.object(clients, "_point_name", return_value="POINT-1"),
			patch.object(clients, "_record_consent") as record_consent,
			patch.object(clients, "_log"),
			patch.object(clients, "now_datetime", return_value="2026-09-18 10:00:00"),
		):
			result = clients._register_client_unlocked(
				{
					"phone": "89061234567",
					"name": "Иван",
					"point_code": "POINT-1",
					"consent_pd": 1,
					"consent_ads": 0,
					"consent_rules": 1,
					"discount": 99,
					"active_channels": 9,
				}
			)
		self.assertTrue(result["ok"])
		self.assertEqual(record_consent.call_count, 3)
		self.assertEqual([call.args[2] for call in record_consent.call_args_list], [True, False, True])
		self.assertEqual(doc.discount_percent, 0)
		self.assertEqual(doc.active_channels, 0)
		self.assertEqual(doc.link_token, "generated-link-token-123456")
		self.assertEqual(result["session_token"], "session-token")

	def test_duplicate_bothelp_delivery_does_not_mutate_channel(self):
		doc = ClientStub(
			name="CLIENT-1",
			client_id="RP-000001",
			client_name="Иван",
			discount_percent=5,
			active_channels=2,
			primary_channel="Telegram",
			backup_channel="VK",
			telegram_active=1,
			max_active=0,
			vk_active=1,
		)
		fake = SimpleNamespace(db=SimpleNamespace(exists=Mock(return_value=True)))
		with patch.object(clients, "frappe", fake), patch.object(clients, "_connect_channel") as connect:
			result = clients._apply_bothelp_event(doc, "Telegram", "event-1", {})
		self.assertTrue(result["duplicate"])
		connect.assert_not_called()


class TestClubCors(TestCase):
	def test_allows_rpechatka_and_tilda_https_origins_only(self):
		fake = SimpleNamespace(conf={})
		with patch.object(club_cors, "frappe", fake):
			self.assertEqual(club_cors._allowed_origin("https://rpechatka.ru"), "https://rpechatka.ru")
			self.assertEqual(
				club_cors._allowed_origin("https://project.tilda.ws"), "https://project.tilda.ws"
			)
			self.assertIsNone(club_cors._allowed_origin("http://project.tilda.ws"))
			self.assertIsNone(club_cors._allowed_origin("https://evil.example"))

	def test_hook_does_not_open_internal_api(self):
		response = SimpleNamespace(headers={})
		request = SimpleNamespace(
			path="/api/method/raspechatka.api.clients.get_clients",
			headers={"Origin": "https://rpechatka.ru"},
		)
		club_cors.apply_public_club_cors(response, request)
		self.assertEqual(response.headers, {})

	def test_hook_adds_narrow_headers_for_public_gateway(self):
		response = SimpleNamespace(headers={})
		request = SimpleNamespace(
			path="/api/method/raspechatka.api.clients.club_gateway",
			headers={"Origin": "https://project.tilda.ws"},
		)
		fake = SimpleNamespace(conf={})
		with patch.object(club_cors, "frappe", fake):
			club_cors.apply_public_club_cors(response, request)
		self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://project.tilda.ws")
		self.assertEqual(response.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS")
		self.assertEqual(response.headers["Vary"], "Origin")


class TestTildaCompatibility(TestCase):
	def test_jsonp_wraps_read_response_and_rejects_unsafe_callback(self):
		fake = SimpleNamespace(local=SimpleNamespace(response=SimpleNamespace()))
		with patch.object(clients, "frappe", fake):
			clients._external_response({"ok": True}, "clubReady")
			self.assertEqual(fake.local.response.filecontent, 'clubReady({"ok": true});')
			self.assertEqual(fake.local.response.content_type, "application/javascript; charset=utf-8")
			clients._external_response({"ok": True}, "bad();callback")
			self.assertEqual(fake.local.response.filecontent, '{"ok": false, "error": "INVALID_CALLBACK"}')
			self.assertEqual(fake.local.response.content_type, "application/json; charset=utf-8")


class TestClubDirectContracts(TestCase):
	def test_gateway_keeps_legacy_actions_and_canonical_boundaries(self):
		source = Path(clients.__file__).read_text(encoding="utf-8")
		for action in (
			'"check_phone"',
			'"register"',
			'"open_client"',
			'"get_client"',
			'"connect_channel"',
			'"disconnect_channel"',
		):
			self.assertIn(action, source)
		self.assertIn("direct_club_updated_at", source)
		self.assertNotIn("details=data", source)

	def test_pos_reads_canonical_client_discount(self):
		root = Path(__file__).resolve().parents[2]
		pos = (root / "raspechatka/api/pos.py").read_text(encoding="utf-8")
		pos_v2 = (root / "raspechatka/api/pos_v2.py").read_text(encoding="utf-8")
		self.assertIn('fields=["name", "client_name", "phone", "discount_percent"]', pos)
		self.assertIn('["club_status", "discount_percent"]', pos_v2)

	def test_shadow_has_freeze_and_canonical_newer_guards(self):
		root = Path(__file__).resolve().parents[2]
		source = (root / "raspechatka/api/club_shadow.py").read_text(encoding="utf-8")
		self.assertIn('"SHADOW_FROZEN"', source)
		self.assertIn('"CANONICAL_STATE_NEWER"', source)
