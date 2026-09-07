import re


def digits(value):
	return re.sub(r"\D", "", value or "")


def is_valid_inn(value):
	inn = digits(value)
	if len(inn) == 10:
		return _control_digit(inn[:9], (2, 4, 10, 3, 5, 9, 4, 6, 8)) == int(inn[9])
	if len(inn) == 12:
		first = _control_digit(inn[:10], (7, 2, 4, 10, 3, 5, 9, 4, 6, 8))
		second = _control_digit(inn[:11], (3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8))
		return first == int(inn[10]) and second == int(inn[11])
	return False


def is_valid_ogrnip(value):
	ogrnip = digits(value)
	return len(ogrnip) == 15 and int(ogrnip[-1]) == int(ogrnip[:-1]) % 13 % 10


def is_valid_bic(value):
	return len(digits(value)) == 9


def is_valid_bank_account(value, bic, correspondent=False):
	account = digits(value)
	bic = digits(bic)
	if len(account) != 20 or len(bic) != 9:
		return False
	prefix = f"0{bic[4:6]}" if correspondent else bic[-3:]
	control = prefix + account
	weights = (7, 1, 3)
	return sum(int(number) * weights[index % 3] for index, number in enumerate(control)) % 10 == 0


def _control_digit(value, weights):
	return sum(int(number) * weight for number, weight in zip(value, weights, strict=True)) % 11 % 10
