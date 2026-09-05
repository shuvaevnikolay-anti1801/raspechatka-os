frappe.provide("raspechatka");

raspechatka.catalog = {
	route: "catalog",
	item_types: {
		Product: __("Товар"),
		Service: __("Услуга"),
		Bundle: __("Комплект"),
	},
	open() {
		return frappe.set_route(this.route);
	},
	create_item(item_type) {
		return frappe.new_doc("Catalog Item", { item_type });
	},
};
