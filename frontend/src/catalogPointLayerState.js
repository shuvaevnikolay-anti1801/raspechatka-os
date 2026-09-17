export function normalizeBusinessPoint(layer, current, points = []) {
	const allowed = new Set(points.map((point) => point.name));
	if (layer === "assortment") return current === "__all__" || allowed.has(current) ? current : "__all__";
	return allowed.has(current) ? current : (points[0]?.name || "");
}

export function priceSourceLabel(source) {
	return ({ Point: "Точка", Network: "Сеть", "Variant Parent": "Основной товар" })[source] || "Нет цены";
}

export function layerEmptyMessage(layer, hasActiveWarehouse = true) {
	if (layer === "prices") return "В выбранной группе нет продаваемых позиций для этой точки.";
	if (layer === "minimum_stock") {
		return hasActiveWarehouse
			? "В выбранной группе нет складских товаров для настройки нормативов."
			: "Для выбранной точки нет активных складов.";
	}
	return "В выбранной группе нет позиций каталога.";
}
