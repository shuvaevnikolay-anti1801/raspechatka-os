from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from raspechatka.api import sales


class TestCleanerCashMovementContract(TestCase):
	def test_standard_cash_ingest_persists_cleaner_reference_and_expense_purpose(self):
		row = {
			"external_id": "CASH-1", "movement_type": "Withdrawal",
			"shift_external_id": "SHIFT-1", "amount": 3250.5,
			"withdrawal_purpose": "Expense", "cleaning_payout_id": "PAYOUT-1",
			"cleaning_cycle_id": "CYCLE-1", "cashier": "EMP-A",
			"reason": "Уборка: оплата за 3 посещения",
		}
		doc = Mock()
		result = {"created": 0, "duplicates": 0}
		with patch.object(sales.frappe.db, "exists", return_value=False), patch.object(
			sales, "_shift_name", return_value="SHIFT-CANONICAL"
		), patch.object(sales, "_set_doc_scope"), patch.object(
			sales.frappe, "new_doc", return_value=doc
		):
			sales._ingest_cash(row, SimpleNamespace(business_point="POINT-A"), result)
			self.assertEqual(doc.external_id, "CASH-1")
			self.assertEqual(doc.shift, "SHIFT-CANONICAL")
			self.assertIn(("cleaning_payout_id", "PAYOUT-1"), [call.args for call in doc.set.call_args_list])
			self.assertIn(("cleaning_cycle_id", "CYCLE-1"), [call.args for call in doc.set.call_args_list])
			self.assertIn(("withdrawal_purpose", "Expense"), [call.args for call in doc.set.call_args_list])
			doc.insert.assert_called_once_with(ignore_permissions=True)
			doc.submit.assert_called_once()
			self.assertEqual(result["created"], 1)
