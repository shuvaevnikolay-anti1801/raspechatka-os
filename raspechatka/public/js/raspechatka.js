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

// Bridge standalone catalog actions to the standard Frappe editor while the
// custom product card is being designed.
raspechatka.catalog.handle_create_link = function () {
	const url = new URL(window.location.href);
	const item_type = url.searchParams.get("create");
	if (!item_type || !["Product", "Service", "Bundle"].includes(item_type)) return;

	url.searchParams.delete("create");
	window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
	window.setTimeout(() => raspechatka.catalog.create_item(item_type), 0);
};

$(document).on("app_ready", () => raspechatka.catalog.handle_create_link());
