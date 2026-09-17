import os

import frappe
import requests
from frappe import _


BASE_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById"
CACHE_SECONDS = 24 * 60 * 60


def find_party(inn):
	return _find("party", inn)


def find_bank(bic):
	return _find("bank", bic)


def _find(kind, query):
	cache_key = f"raspechatka:dadata:{kind}:{query}"
	cached = frappe.cache().get_value(cache_key)
	if cached:
		return cached

	token = frappe.conf.get("dadata_api_key") or os.environ.get("DADATA_API_KEY")
	if not token:
		frappe.throw(_("DaData пока не настроена. Заполните реквизиты вручную."))

	try:
		response = requests.post(
			f"{BASE_URL}/{kind}",
			headers={"Authorization": f"Token {token}", "Content-Type": "application/json", "Accept": "application/json"},
			json={"query": query, "count": 1},
			timeout=8,
		)
	except requests.RequestException:
		frappe.throw(_("DaData сейчас недоступна. Заполните реквизиты вручную."))

	if response.status_code in (401, 403):
		frappe.throw(_("Ключ DaData не принят. Заполните реквизиты вручную и сообщите администратору."))
	if not response.ok:
		frappe.throw(_("DaData вернула ошибку. Заполните реквизиты вручную."))

	try:
		suggestions = response.json().get("suggestions") or []
	except ValueError:
		frappe.throw(_("DaData вернула некорректный ответ. Заполните реквизиты вручную."))
	if not suggestions:
		frappe.throw(_("Запись не найдена в DaData. Проверьте номер или заполните реквизиты вручную."))

	result = suggestions[0]
	frappe.cache().set_value(cache_key, result, expires_in_sec=CACHE_SECONDS)
	return result
