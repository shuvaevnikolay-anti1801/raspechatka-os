"""Pure helpers for the signed legacy bridge. No Frappe or network dependencies."""

import hashlib
import hmac
import json
import re


def truth(value):
	return str(value).strip().lower() in {"1", "1.0", "true", "да"}


def identifier(value):
	if isinstance(value, float) and value.is_integer():
		return str(int(value))
	return str(value or "").strip()


def digest(value):
	return hashlib.sha256(value.encode("utf-8")).hexdigest()


def verify(payload, timestamp, signature, secret, now):
	if not secret or len(secret) < 32:
		raise ValueError("SYNC_NOT_CONFIGURED")
	if not isinstance(payload, str) or len(payload.encode("utf-8")) > 900_000:
		raise ValueError("INVALID_PAYLOAD")
	stamp = str(timestamp)
	if not re.fullmatch(r"[0-9]{10}", stamp) or abs(now - int(stamp)) > 300:
		raise ValueError("EXPIRED_SIGNATURE")
	expected = hmac.new(secret.encode(), (stamp + "\n" + payload).encode(), hashlib.sha256).hexdigest()
	if not isinstance(signature, str) or not hmac.compare_digest(expected, signature):
		raise ValueError("INVALID_SIGNATURE")
	data = json.loads(payload)
	if not isinstance(data, dict) or data.get("version") != 1:
		raise ValueError("UNSUPPORTED_VERSION")
	if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", str(data.get("event_id", ""))):
		raise ValueError("INVALID_EVENT_ID")
	return data
