import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timedelta

import frappe
import requests
from frappe import _
from frappe.utils import add_days, flt, get_datetime, now_datetime, nowdate

from raspechatka.access import get_scope, require_access


TOKEN_URL = "https://enter.tochka.com/connect/token"
CONSENT_URL = "https://enter.tochka.com/uapi/consent/v1.0/consents"
AUTHORIZE_URL = "https://enter.tochka.com/connect/authorize"
API_BASE = "https://enter.tochka.com/uapi"
PERMISSIONS = ["ReadAccountsBasic", "ReadAccountsDetail", "ReadBalances", "ReadStatements", "ReadCustomerData"]


@frappe.whitelist()
def get_bank_workspace(business_entity=None, status=None):
	require_access("finance.bank", "read")
	filters = _entity_filters(business_entity)
	connections = frappe.get_all("Bank Connection", filters=filters, fields=["name", "connection_name", "business_entity", "bank_name", "enabled", "status", "sync_mode", "last_sync_at", "token_expires_at", "oauth_url", "error_message"], order_by="connection_name asc")
	operation_filters = {**filters}
	if status:
		operation_filters["processing_status"] = status
	operations = frappe.get_all("Bank Operation", filters=operation_filters, fields=["name", "operation_key", "posted_at", "direction", "amount", "currency", "counterparty_name", "counterparty_inn", "purpose", "processing_status", "matched_rule", "business_entity", "bank_account"], order_by="posted_at desc", limit_page_length=200)
	rules = frappe.get_all("Finance Classification Rule", filters={"enabled": 1}, fields=["name", "rule_name", "priority", "business_entity", "direction", "counterparty_contains", "purpose_contains", "financial_article", "cash_flow_type", "business_point", "result", "split_acquiring_commission"], order_by="priority asc", limit_page_length=1000)
	return {"connections": connections, "operations": operations, "rules": rules, "review_count": frappe.db.count("Bank Operation", {**filters, "processing_status": "Review"})}


@frappe.whitelist(methods=["POST"])
def save_connection(data):
	data = frappe.parse_json(data) or {}
	require_access("finance.bank", "write" if data.get("name") else "create")
	_ensure_entity(data.get("business_entity"))
	doc = frappe.get_doc("Bank Connection", data["name"]) if data.get("name") else frappe.new_doc("Bank Connection")
	for fieldname in ("connection_name", "business_entity", "bank_name", "enabled", "sync_mode", "sync_interval_minutes", "overlap_days"):
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	for fieldname in ("client_id", "client_secret"):
		if data.get(fieldname):
			doc.set(fieldname, data[fieldname])
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def save_rule(data):
	data = frappe.parse_json(data) or {}
	require_access("finance.bank", "write" if data.get("name") else "create")
	if data.get("business_entity"):
		_ensure_entity(data.get("business_entity"))
	doc = frappe.get_doc("Finance Classification Rule", data["name"]) if data.get("name") else frappe.new_doc("Finance Classification Rule")
	allowed = ("rule_name", "priority", "enabled", "stop_processing", "business_entity", "bank_account", "direction", "counterparty_inn", "counterparty_account", "counterparty_contains", "purpose_contains", "purpose_regex", "amount_from", "amount_to", "financial_article", "cash_flow_type", "business_point", "result", "split_acquiring_commission", "comment")
	for fieldname in allowed:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))
	doc.save(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist(methods=["POST"])
def begin_oauth(connection):
	require_access("finance.bank", "write")
	doc = frappe.get_doc("Bank Connection", connection)
	_ensure_entity(doc.business_entity)
	client_id = doc.get_password("client_id")
	client_secret = doc.get_password("client_secret")
	if not client_id or not client_secret:
		frappe.throw(_("Сначала сохраните Client ID и Client secret приложения Точка Банка"))
	redirect_uri = frappe.utils.get_url("/api/method/raspechatka.api.tochka.oauth_callback")
	app_token = _token_request({"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret})
	consent = _request_json("POST", CONSENT_URL, app_token.get("access_token"), {"Data": {"permissions": PERMISSIONS}})
	consent_id = _pick(consent, "Data.consentId", "data.consentId", "consentId")
	if not consent_id:
		frappe.throw(_("Банк не вернул идентификатор согласия"))
	state = uuid.uuid4().hex
	url = requests.Request("GET", AUTHORIZE_URL, params={"client_id": client_id, "response_type": "code", "redirect_uri": redirect_uri, "consent_id": consent_id, "state": state}).prepare().url
	doc.db_set({"consent_id": consent_id, "oauth_state": state, "oauth_url": url, "status": "Awaiting Consent", "error_message": None})
	return {"url": url}


@frappe.whitelist(allow_guest=True)
def oauth_callback(code=None, state=None, token_id=None):
	name = frappe.db.get_value("Bank Connection", {"oauth_state": state}, "name")
	if not name or not code:
		frappe.throw(_("Ссылка подключения недействительна или уже использована"))
	doc = frappe.get_doc("Bank Connection", name)
	payload = {"grant_type": "authorization_code", "code": code, "client_id": doc.get_password("client_id"), "client_secret": doc.get_password("client_secret"), "redirect_uri": frappe.utils.get_url("/api/method/raspechatka.api.tochka.oauth_callback")}
	if token_id:
		payload["token_id"] = token_id
	token = _token_request(payload)
	doc.access_token = token.get("access_token")
	if token.get("refresh_token"):
		doc.refresh_token = token.get("refresh_token")
	doc.token_expires_at = now_datetime() + timedelta(seconds=int(token.get("expires_in") or 86400))
	doc.oauth_state = None
	doc.status = "Connected"
	doc.oauth_url = None
	doc.error_message = None
	doc.save(ignore_permissions=True)
	frappe.local.response["type"] = "redirect"
	frappe.local.response["location"] = "/raspechatka/finance/tochka?connected=1"


@frappe.whitelist(methods=["POST"])
def sync_now(connection):
	require_access("finance.bank", "write")
	doc = frappe.get_doc("Bank Connection", connection)
	_ensure_entity(doc.business_entity)
	if doc.status != "Connected":
		frappe.throw(_("Сначала подключите банк"))
	frappe.enqueue("raspechatka.api.tochka.sync_connection", queue="long", connection=connection, enqueue_after_commit=True)
	return {"queued": True}


@frappe.whitelist(methods=["POST"])
def refresh_accounts(connection):
	require_access("finance.bank", "write")
	doc = frappe.get_doc("Bank Connection", connection)
	_ensure_entity(doc.business_entity)
	result = _request_json("GET", f"{API_BASE}/open-banking/v1.0/accounts", _valid_token(doc))
	accounts = _pick(result, "Data.Account", "Data.Accounts", "Data.accounts", "data.Account", "data.Accounts", "data.accounts", "accounts") or []
	if not isinstance(accounts, list):
		accounts = [accounts]
	updated = 0
	for account in accounts:
		external_id = str(_pick(account, "accountId", "AccountId", "AccountID", "id") or "")
		number = _digits(_pick(account, "accountNumber", "AccountNumber", "identification", "number") or "")
		if not external_id:
			continue
		name = frappe.db.get_value("Business Bank Account", {"business_entity": doc.business_entity, "settlement_account": number}, "name") if number else None
		if name:
			frappe.db.set_value("Business Bank Account", name, "external_account_id", external_id)
			updated += 1
	return {"received": len(accounts), "matched": updated}


def sync_enabled_connections():
	for name in frappe.get_all("Bank Connection", filters={"enabled": 1, "status": "Connected"}, pluck="name"):
		frappe.enqueue("raspechatka.api.tochka.sync_connection", queue="long", connection=name, enqueue_after_commit=True)


def sync_connection(connection):
	doc = frappe.get_doc("Bank Connection", connection)
	try:
		token = _valid_token(doc)
		accounts = frappe.get_all("Business Bank Account", filters={"business_entity": doc.business_entity, "active": 1, "external_account_id": ["is", "set"]}, fields=["name", "external_account_id", "settlement_account", "currency"])
		for account in accounts:
			for transaction in _fetch_transactions(token, account.external_account_id, int(doc.overlap_days or 2)):
				_ingest(doc, account, transaction)
		doc.db_set({"last_sync_at": now_datetime(), "error_message": None})
	except Exception as error:
		doc.db_set({"status": "Error", "error_message": str(error)[:1000]})
		frappe.log_error(frappe.get_traceback(), "Raspechatka Tochka sync")
		raise


@frappe.whitelist(methods=["POST"])
def classify_operation(name, financial_article=None, business_point=None, result="Approve"):
	require_access("finance.bank", "write")
	operation = frappe.get_doc("Bank Operation", name)
	_ensure_entity(operation.business_entity)
	if result == "Ignore":
		operation.db_set("processing_status", "Ignored")
		return {"status": "Ignored"}
	if not financial_article:
		frappe.throw(_("Выберите финансовую статью"))
	_create_ledger(operation, {"financial_article": financial_article, "business_point": business_point, "cash_flow_type": frappe.db.get_value("Financial Article", financial_article, "cash_flow_type") or "Operating"})
	operation.db_set("processing_status", "Classified")
	return {"status": "Classified"}


def _ingest(connection, account, payload):
	normalized = _normalize(connection, account, payload)
	if frappe.db.exists("Bank Operation", {"operation_key": normalized["operation_key"]}):
		return
	operation = frappe.get_doc({"doctype": "Bank Operation", **normalized}).insert(ignore_permissions=True)
	action = _classify(operation)
	if action.get("result") == "Ignore":
		operation.db_set("processing_status", "Ignored")
	elif action.get("result") == "Review" or not action.get("financial_article"):
		operation.db_set({"processing_status": "Review", "matched_rule": action.get("rule")})
	else:
		_create_ledger(operation, action)
		operation.db_set({"processing_status": "Classified", "matched_rule": action.get("rule")})


def _classify(operation):
	rules = frappe.get_all("Finance Classification Rule", filters={"enabled": 1}, fields=["*"], order_by="priority asc", limit_page_length=10000)
	for rule in rules:
		if _matches(rule, operation):
			return {"rule": rule.name, "financial_article": rule.financial_article, "cash_flow_type": rule.cash_flow_type, "business_point": rule.business_point, "result": rule.result, "split": rule.split_acquiring_commission}
	return {"result": "Review"}


def _matches(rule, operation):
	if rule.business_entity and rule.business_entity != operation.business_entity: return False
	if rule.bank_account and rule.bank_account != operation.bank_account: return False
	if rule.direction not in (None, "", "Any") and rule.direction != operation.direction: return False
	if rule.counterparty_inn and _digits(rule.counterparty_inn) != _digits(operation.counterparty_inn): return False
	if rule.counterparty_account and _digits(rule.counterparty_account) != _digits(operation.counterparty_account): return False
	if rule.counterparty_contains and rule.counterparty_contains.lower() not in (operation.counterparty_name or "").lower(): return False
	if rule.purpose_contains and rule.purpose_contains.lower() not in (operation.purpose or "").lower(): return False
	if rule.purpose_regex and not re.search(rule.purpose_regex, operation.purpose or "", re.I): return False
	if rule.amount_from and flt(operation.amount) < flt(rule.amount_from): return False
	if rule.amount_to and flt(operation.amount) > flt(rule.amount_to): return False
	return True


def _create_ledger(operation, action):
	if action.get("split"):
		fee = _commission(operation.purpose)
		if fee > 0 and fee < flt(operation.amount) * 2:
			_create_transaction(operation, action, flt(operation.amount) + fee, "Income", "Валовая выручка эквайринга")
			commission_article = frappe.db.get_value("Financial Article", {"article_name": "Комиссии банка"}, "name")
			if commission_article:
				_create_transaction(operation, {**action, "financial_article": commission_article}, fee, "Expense", "Комиссия эквайринга")
			return
	_create_transaction(operation, action, operation.amount, operation.direction)


def _create_transaction(operation, action, amount, direction, comment=None):
	doc = frappe.get_doc({"doctype": "Finance Transaction", "posting_date": get_datetime(operation.posted_at).date(), "posting_time": get_datetime(operation.posted_at).time(), "direction": direction, "amount": amount, "currency": operation.currency, "status": "Draft", "business_entity": operation.business_entity, "business_point": action.get("business_point"), "bank_account": operation.bank_account, "financial_article": action.get("financial_article"), "cash_flow_type": action.get("cash_flow_type") or "Operating", "counterparty_type": "Other", "counterparty_name": operation.counterparty_name, "purpose": operation.purpose or "Банковская операция", "document_number": operation.document_number, "source": "Tochka Bank", "bank_operation": operation.name, "comment": comment})
	doc.insert(ignore_permissions=True)
	doc.submit()


def _normalize(connection, account, tx):
	payment_id = str(_pick(tx, "paymentId", "PaymentId", "transactionId", "operationId", "id") or "")
	indicator = str(_pick(tx, "creditDebitIndicator", "CreditDebitIndicator") or "").upper()
	credit = flt(_pick(tx, "creditAmount.amount", "CreditAmount.amount")); debit = flt(_pick(tx, "debitAmount.amount", "DebitAmount.amount"))
	amount = abs(flt(_pick(tx, "Amount.amount", "amount.amount", "creditAmount.amount", "CreditAmount.amount", "debitAmount.amount", "DebitAmount.amount") or credit or debit))
	direction = "Income" if indicator == "CREDIT" or (not indicator and credit > 0) else "Expense"
	counterparty = _pick(tx, "DebtorParty", "debtorParty", "payer", "Payer") if direction == "Income" else _pick(tx, "CreditorParty", "creditorParty", "recipient", "Recipient")
	counterparty_account = _pick(tx, "DebtorAccount", "debtorAccount") if direction == "Income" else _pick(tx, "CreditorAccount", "creditorAccount")
	posted = _pick(tx, "documentProcessDate", "date", "operationDate", "createdAt") or now_datetime()
	key_source = f"{connection.name}|{account.external_account_id}|{payment_id or posted}|{amount}"
	return {"operation_key": hashlib.sha256(key_source.encode()).hexdigest(), "external_id": payment_id, "connection": connection.name, "business_entity": connection.business_entity, "bank_account": account.name, "posted_at": posted, "direction": direction, "amount": amount, "currency": _pick(tx, "Amount.currency", "amount.currency", "creditAmount.currency", "debitAmount.currency") or account.currency or "RUB", "counterparty_name": _pick(counterparty or {}, "name", "legalName", "fio") or "", "counterparty_inn": str(_pick(counterparty or {}, "inn", "INN") or ""), "counterparty_account": _digits(_pick(counterparty_account or {}, "identification", "account", "accountNumber") or ""), "purpose": _pick(tx, "description", "purpose", "paymentPurpose") or "", "document_number": str(_pick(tx, "documentNumber", "number") or ""), "processing_status": "New", "raw_payload": json.dumps(tx, ensure_ascii=False)[:45000], "imported_at": now_datetime()}


def _fetch_transactions(token, account_id, overlap_days):
	payload = {"Data": {"Statement": {"accountId": str(account_id), "startDateTime": str(add_days(nowdate(), -overlap_days)), "endDateTime": str(nowdate())}}}
	created = _request_json("POST", f"{API_BASE}/open-banking/v1.0/statements", token, payload)
	statement_id = _pick(created, "Data.Statement.statementId", "data.Statement.statementId")
	if not statement_id:
		raise RuntimeError("Банк не вернул statementId")
	url = f"{API_BASE}/open-banking/v1.0/accounts/{account_id}/statements/{statement_id}"
	for _attempt in range(10):
		time.sleep(2)
		result = _request_json("GET", url, token)
		statement = _pick(result, "Data.Statement", "data.Statement")
		if isinstance(statement, list):
			statement = next((row for row in statement if str(row.get("statementId")) == str(statement_id)), statement[0] if statement else None)
		if not statement:
			continue
		status = str(statement.get("status") or "").upper()
		if status == "READY":
			return statement.get("Transaction") or statement.get("transaction") or statement.get("Transactions") or statement.get("transactions") or []
		if status == "ERROR":
			raise RuntimeError("Банк не смог сформировать выписку")
	return []


def _valid_token(doc):
	if doc.token_expires_at and get_datetime(doc.token_expires_at) > now_datetime() + timedelta(minutes=5):
		return doc.get_password("access_token")
	refresh = doc.get_password("refresh_token")
	if not refresh:
		raise RuntimeError("Истёк доступ к банку: подключите его повторно")
	token = _token_request({"grant_type": "refresh_token", "refresh_token": refresh, "client_id": doc.get_password("client_id"), "client_secret": doc.get_password("client_secret")})
	doc.access_token = token.get("access_token")
	if token.get("refresh_token"): doc.refresh_token = token.get("refresh_token")
	doc.token_expires_at = now_datetime() + timedelta(seconds=int(token.get("expires_in") or 86400))
	doc.status = "Connected"; doc.save(ignore_permissions=True)
	return token.get("access_token")


def _token_request(payload):
	response = requests.post(TOKEN_URL, data=payload, timeout=30)
	response.raise_for_status()
	return response.json()


def _request_json(method, url, token, payload=None):
	response = requests.request(method, url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}, json=payload, timeout=60)
	response.raise_for_status()
	return response.json()


def _pick(obj, *paths):
	for path in paths:
		value = obj
		for part in path.split("."):
			if not isinstance(value, dict) or part not in value:
				value = None; break
			value = value[part]
		if value not in (None, ""):
			return value
	return None


def _commission(purpose):
	match = re.search(r"(?:сумм[аы]\s+)?комисси[ия]\s*(?:банка\s*)?(?:составляет\s*)?[:=-]?\s*([0-9][0-9\s]*(?:[.,][0-9]{1,2})?)", (purpose or "").replace("\u00a0", " "), re.I)
	return round(flt(match.group(1).replace(" ", "").replace(",", ".")), 2) if match else 0


def _digits(value):
	return re.sub(r"\D", "", str(value or ""))


def _entity_filters(entity=None):
	scope = get_scope()
	if not scope["global"]:
		if entity and entity != scope["business_entity"]: frappe.throw(_("ИП недоступно"), frappe.PermissionError)
		return {"business_entity": scope["business_entity"] or "__none__"}
	return {"business_entity": entity} if entity else {}


def _ensure_entity(entity):
	if not entity: frappe.throw(_("Выберите ИП"))
	_entity_filters(entity)
