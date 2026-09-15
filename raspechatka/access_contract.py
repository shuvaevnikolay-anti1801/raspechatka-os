from functools import wraps

VALID_AUTH_TYPES = {"session", "pos_token", "webhook", "oauth_state", "public_token", "current_user"}
VALID_ACTIONS = {"read", "create", "write", "delete", "admin"}
VALID_SCOPES = {"network", "entity", "point", "client", "user", "pos_point", "provider", "none"}


def access_contract(*, area=None, action="read", scope="none", auth="session"):
	"""Declare the authorization contract for one external Frappe endpoint.

	For session-authenticated endpoints the decorator also enforces the declared page/action.
	Data-scope enforcement remains explicit through shared scope helpers because object ownership
	differs by domain.
	"""
	if auth not in VALID_AUTH_TYPES:
		raise ValueError(f"Unknown auth type: {auth}")
	if action not in VALID_ACTIONS:
		raise ValueError(f"Unknown access action: {action}")
	if scope not in VALID_SCOPES:
		raise ValueError(f"Unknown scope type: {scope}")
	if auth == "session" and not area:
		raise ValueError("Session endpoints require a page.* access area")
	if auth != "session" and area:
		raise ValueError("Non-session endpoints must not declare a page access area")

	def decorator(func):
		@wraps(func)
		def wrapped(*args, **kwargs):
			if auth == "session":
				from raspechatka.access import require_access

				require_access(area, action)
			return func(*args, **kwargs)

		wrapped._raspechatka_access_contract = {
			"area": area,
			"action": action,
			"scope": scope,
			"auth": auth,
		}
		return wrapped

	return decorator
