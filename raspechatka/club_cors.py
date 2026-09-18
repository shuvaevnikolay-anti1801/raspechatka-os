"""Narrow CORS policy for the public Tilda/BotHelp club surface."""

from urllib.parse import urlparse

import frappe

PUBLIC_CLUB_METHODS = {
	"raspechatka.api.clients.club_gateway",
	"raspechatka.api.clients.check_phone",
	"raspechatka.api.clients.get_club_config",
	"raspechatka.api.clients.get_public_client",
	"raspechatka.api.clients.open_client",
	"raspechatka.api.clients.register_client",
	"raspechatka.api.clients.connect_channel",
	"raspechatka.api.clients.disconnect_channel",
	"raspechatka.api.clients.bothelp_webhook",
}
DEFAULT_ORIGINS = {"https://rpechatka.ru", "https://www.rpechatka.ru"}


def _allowed_origin(origin):
	if not origin:
		return None
	configured = frappe.conf.get("raspechatka_club_cors_origins") or []
	if isinstance(configured, str):
		configured = [value.strip() for value in configured.split(",") if value.strip()]
	if origin in (set(configured) | DEFAULT_ORIGINS):
		return origin
	parsed = urlparse(origin)
	if (
		parsed.scheme == "https"
		and parsed.hostname
		and (parsed.hostname.endswith(".tilda.ws") or parsed.hostname.endswith(".tilda.cc"))
	):
		return origin
	return None


def apply_public_club_cors(response, request):
	path = (request.path or "").rstrip("/")
	method = path.split("/api/method/", 1)[1] if "/api/method/" in path else ""
	if method not in PUBLIC_CLUB_METHODS:
		return
	origin = _allowed_origin(request.headers.get("Origin"))
	if not origin:
		return
	response.headers.update(
		{
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
			"Access-Control-Max-Age": "86400",
			"Vary": "Origin",
		}
	)
