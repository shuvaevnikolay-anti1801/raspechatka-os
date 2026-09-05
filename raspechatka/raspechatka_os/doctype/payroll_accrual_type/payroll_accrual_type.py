import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class PayrollAccrualType(Document):
	def validate(self):
		self.component_code = (self.component_code or "").strip().upper().replace(" ", "_")
		self._validate_point_entity()
		self._validate_unique_scope()
		self._validate_exemption_basis()

	def _validate_point_entity(self):
		if not self.business_point:
			return
		point_entity = frappe.db.get_value("Business Point", self.business_point, "business_entity")
		if point_entity != self.business_entity:
			frappe.throw(_("Точка должна принадлежать выбранному юридическому лицу"))

	def _validate_unique_scope(self):
		filters = {
			"business_entity": self.business_entity,
			"business_point": self.business_point or "",
			"component_code": self.component_code,
			"name": ["!=", self.name or ""],
		}
		if frappe.db.exists("Payroll Accrual Type", filters):
			frappe.throw(_("Для этого юридического лица и точки уже есть начисление с кодом {0}").format(self.component_code))

	def _validate_exemption_basis(self):
		all_taxable = all((
			cint(self.include_in_ndfl_base),
			cint(self.include_in_insurance_base),
			cint(self.include_in_injury_base),
		))
		if not all_taxable and not (self.exemption_basis or "").strip():
			frappe.throw(_("Укажите правовое основание для исключения начисления из налоговой базы"))
