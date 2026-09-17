// Copyright (c) 2026, Raspechatka and contributors

frappe.ui.form.on("Catalog Item", {
	refresh(frm) {
		frm.add_custom_button(__("Ассортимент точек"), () => {
			frappe.set_route("List", "Catalog Assortment", { item: frm.doc.name });
		}, __("Открыть"));

		frm.add_custom_button(__("Точка продаж"), () => {
			frappe.new_doc("Catalog Assortment", { item: frm.doc.name });
		}, __("Добавить в ассортимент"));

		frm.trigger("item_type");
	},

	item_type(frm) {
		const is_product = frm.doc.item_type === "Product";
		const is_bundle = frm.doc.item_type === "Bundle";
		frm.toggle_display("inventory_tab", is_product);
		frm.toggle_display("bundle_tab", is_bundle);

		if (!is_product && frm.doc.track_inventory) {
			frm.set_value("track_inventory", 0);
		}
	},
});

