#!/usr/bin/env python3
"""Static guard for Raspechatka OS external API authorization contracts.

From this guard onward every new or materially changed whitelisted endpoint must declare
@access_contract(...). Untouched legacy endpoints remain covered by the audited inventory and
migrate to explicit contracts as they are changed.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = ROOT / "raspechatka"
PAGES_PATH = ROOT / "frontend" / "src" / "access-pages.json"

VALID_AUTH = {"session", "pos_token", "webhook", "oauth_state", "public_token", "current_user"}
VALID_ACTIONS = {"read", "create", "write", "delete", "admin"}
VALID_SCOPES = {"network", "entity", "point", "client", "user", "pos_point", "provider", "none"}


@dataclass(frozen=True)
class Endpoint:
	name: str
	path: str
	node_dump: str
	allow_guest: bool
	contract: dict | None


def module_name(path: Path) -> str:
	return ".".join(path.relative_to(ROOT).with_suffix("").parts)


def decorator_name(node: ast.AST) -> str:
	if isinstance(node, ast.Name):
		return node.id
	if isinstance(node, ast.Attribute):
		prefix = decorator_name(node.value)
		return f"{prefix}.{node.attr}" if prefix else node.attr
	if isinstance(node, ast.Call):
		return decorator_name(node.func)
	return ""


def literal_keyword(call: ast.Call, key: str, default=None):
	for keyword in call.keywords:
		if keyword.arg == key:
			try:
				return ast.literal_eval(keyword.value)
			except (ValueError, TypeError):
				raise SystemExit(f"@access_contract {key}= must be a literal") from None
	return default


def parse_contract(decorators: list[ast.expr]) -> dict | None:
	matches = [decorator for decorator in decorators if decorator_name(decorator).endswith("access_contract")]
	if not matches:
		return None
	if len(matches) != 1 or not isinstance(matches[0], ast.Call):
		raise SystemExit("Use exactly one @access_contract(...) decorator per endpoint")
	call = matches[0]
	return {
		"area": literal_keyword(call, "area"),
		"action": literal_keyword(call, "action", "read"),
		"scope": literal_keyword(call, "scope", "none"),
		"auth": literal_keyword(call, "auth", "session"),
	}


def parse_source(source: str, path: str) -> dict[str, Endpoint]:
	tree = ast.parse(source, filename=path)
	result: dict[str, Endpoint] = {}
	module = module_name(ROOT / path)
	for node in tree.body:
		if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
			continue
		whitelist = None
		for decorator in node.decorator_list:
			name = decorator_name(decorator)
			if name.endswith("frappe.whitelist") or name == "whitelist" or name.endswith(".whitelist"):
				whitelist = decorator
				break
		if whitelist is None:
			continue
		allow_guest = False
		if isinstance(whitelist, ast.Call):
			allow_guest = bool(literal_keyword(whitelist, "allow_guest", False))
		endpoint_name = f"{module}.{node.name}"
		result[endpoint_name] = Endpoint(
			name=endpoint_name,
			path=path,
			node_dump=ast.dump(node, include_attributes=False),
			allow_guest=allow_guest,
			contract=parse_contract(node.decorator_list),
		)
	return result


def current_endpoints() -> dict[str, Endpoint]:
	result = {}
	for path in APP_ROOT.rglob("*.py"):
		relative = path.relative_to(ROOT).as_posix()
		result.update(parse_source(path.read_text(encoding="utf-8"), relative))
	return result


def git_show(ref: str, path: str) -> str | None:
	process = subprocess.run(
		["git", "show", f"{ref}:{path}"],
		cwd=ROOT,
		text=True,
		capture_output=True,
		check=False,
	)
	return process.stdout if process.returncode == 0 else None


def base_endpoints(base_ref: str | None) -> dict[str, Endpoint]:
	if not base_ref:
		return {}
	ref = f"origin/{base_ref}"
	result = {}
	process = subprocess.run(
		["git", "ls-tree", "-r", "--name-only", ref, "raspechatka"],
		cwd=ROOT,
		text=True,
		capture_output=True,
		check=True,
	)
	for path in process.stdout.splitlines():
		if not path.endswith(".py"):
			continue
		source = git_show(ref, path)
		if source is not None:
			result.update(parse_source(source, path))
	return result


def page_areas() -> set[str]:
	sections = json.loads(PAGES_PATH.read_text(encoding="utf-8"))
	areas: list[str] = []
	routes: list[str] = []
	for section in sections:
		for page in section.get("pages") or []:
			area = page.get("area")
			route = page.get("route")
			if not area or not str(area).startswith("page."):
				raise SystemExit(f"Invalid or missing page area: {area!r}")
			if not route:
				raise SystemExit(f"Missing route for {area}")
			areas.append(area)
			routes.append(route)
	duplicate_areas = sorted({value for value in areas if areas.count(value) > 1})
	duplicate_routes = sorted({value for value in routes if routes.count(value) > 1})
	if duplicate_areas or duplicate_routes:
		raise SystemExit(
			f"Duplicate access registry entries: areas={duplicate_areas}, routes={duplicate_routes}"
		)
	return set(areas)


def validate_contract(endpoint: Endpoint, known_areas: set[str]) -> list[str]:
	errors = []
	contract = endpoint.contract
	if contract is None:
		return ["missing @access_contract(...)"]
	auth = contract["auth"]
	action = contract["action"]
	scope = contract["scope"]
	area = contract["area"]
	if auth not in VALID_AUTH:
		errors.append(f"unknown auth={auth!r}")
	if action not in VALID_ACTIONS:
		errors.append(f"unknown action={action!r}")
	if scope not in VALID_SCOPES:
		errors.append(f"unknown scope={scope!r}")
	if auth == "session":
		if not area or area not in known_areas:
			errors.append(f"session endpoint must reference existing page.* area, got {area!r}")
		if endpoint.allow_guest:
			errors.append("session endpoint cannot use allow_guest=True")
	else:
		if area is not None:
			errors.append("non-session endpoint must not declare page area")
		if auth in {"pos_token", "webhook", "oauth_state", "public_token"} and not endpoint.allow_guest:
			errors.append(f"auth={auth!r} normally requires allow_guest=True")
	return errors


def main() -> int:
	known_areas = page_areas()
	current = current_endpoints()
	base_ref = os.getenv("GITHUB_BASE_REF") or os.getenv("ACCESS_CONTRACT_BASE_REF")
	base = base_endpoints(base_ref) if base_ref else {}

	if not base_ref:
		print(
			f"Access registry OK: {len(known_areas)} pages; discovered {len(current)} whitelisted endpoints. "
			"No base ref supplied, so only declared contracts are syntax-checked."
		)
		candidates = [endpoint for endpoint in current.values() if endpoint.contract]
	else:
		candidates = []
		for name, endpoint in current.items():
			previous = base.get(name)
			if previous is None or previous.node_dump != endpoint.node_dump:
				candidates.append(endpoint)

	failures = []
	for endpoint in sorted(candidates, key=lambda row: row.name):
		errors = validate_contract(endpoint, known_areas)
		if errors:
			failures.append(f"{endpoint.name} ({endpoint.path}): " + "; ".join(errors))

	if failures:
		print("Access Control Contract violations:")
		for failure in failures:
			print(f" - {failure}")
		print(
			"Every new or materially changed @frappe.whitelist endpoint must declare "
			"@access_contract(area=..., action=..., scope=..., auth=...)."
		)
		return 1

	print(
		f"Access Control Contract OK: {len(known_areas)} pages, {len(current)} endpoints, "
		f"{len(candidates)} new/changed endpoints checked."
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
