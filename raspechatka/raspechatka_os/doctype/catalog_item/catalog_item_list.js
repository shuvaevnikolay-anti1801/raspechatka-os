frappe.listview_settings["Catalog Item"] = {
	add_fields: ["item_type", "active", "track_inventory"],
	get_indicator(doc) {
		if (!doc.active) return [__("Отключён"), "gray", "active,=,0"];
		if (doc.item_type === "Service") return [__("Услуга"), "blue", "item_type,=,Service"];
		if (doc.item_type === "Bundle") return [__("Комплект"), "purple", "item_type,=,Bundle"];
		return [__("Товар"), "green", "item_type,=,Product"];
	},
};

