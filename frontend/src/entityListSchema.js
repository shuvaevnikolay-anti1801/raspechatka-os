import { formatDateOnly, formatDateTime } from "./dateTime";

const TECHNICAL_FIELDS = new Set([
	"name",
	"owner",
	"creation",
	"modified",
	"modified_by",
	"docstatus",
]);

function viewOptions(field, view) {
	const value = field?.[view];
	if (value === false) return null;
	if (value === true || value == null) return {};
	return value;
}

export function defineEntityFields(fields) {
	const keys = new Set();
	return fields.map((field) => {
		if (!field?.key || keys.has(field.key))
			throw new Error(`Duplicate or empty entity field: ${field?.key || "<empty>"}`);
		keys.add(field.key);
		return Object.freeze({ ...field });
	});
}

// Compatibility adapter for existing pages while their declarations move into a
// single literal. It still produces the same descriptor contract consumed by both widgets.
export function mergeEntityFields(filterFields = [], columns = []) {
	const byKey = new Map();
	for (const field of filterFields) {
		if (field.key === "search") {
			byKey.set(field.key, { ...field, form: false, filter: false, table: false });
			continue;
		}
		byKey.set(field.key, { ...field, form: false, table: false });
	}
	for (const column of columns) {
		const filterField = byKey.get(column.key);
		byKey.set(
			column.key,
			filterField ? { ...filterField, ...column, table: true } : { ...column, form: false }
		);
	}
	return defineEntityFields([...byKey.values()]);
}

export function deriveFilterFields(fields) {
	return fields.flatMap((field) => {
		const options = viewOptions(field, "filter");
		if (!options || field.key === "search") return [];
		return [{ ...field, ...options, form: undefined, filter: undefined, table: undefined }];
	});
}

export function deriveTableColumns(fields) {
	return fields.flatMap((field) => {
		const options = viewOptions(field, "table");
		if (!options || field.key === "search") return [];
		return [{ ...field, ...options, form: undefined, filter: undefined, table: undefined }];
	});
}

export function deriveFormFields(fields) {
	return fields.flatMap((field) => {
		const options = viewOptions(field, "form");
		if (!options || field.key === "search") return [];
		return [{ ...field, ...options, form: undefined, filter: undefined, table: undefined }];
	});
}

function emptyDisplayValue(value) {
	return value === undefined || value === null || value === "";
}

function optionLabel(options, value) {
	if (!Array.isArray(options)) return undefined;
	return options.find((option) => String(option.value) === String(value))?.label;
}

export function resolveDisplayValue(row, field) {
	const value = row?.[field.key];
	if (typeof field.format === "function") return field.format(value, row);
	if (field.displayKey && !emptyDisplayValue(row?.[field.displayKey]))
		return row[field.displayKey];
	if (emptyDisplayValue(value)) return "—";
	const label = optionLabel(field.options, value);
	if (label !== undefined) return label;
	if (["check", "checkbox", "boolean"].includes(field.type))
		return value === true || value === 1 || value === "1" ? "Да" : "Нет";
	if (["datetime", "datetime-local"].includes(field.type)) return formatDateTime(value);
	if (field.type === "date") return formatDateOnly(value);
	return value;
}

export function resolveSortValue(row, field) {
	if (
		field.displayKey ||
		Array.isArray(field.options) ||
		["check", "checkbox", "boolean"].includes(field.type)
	)
		return resolveDisplayValue(row, { ...field, format: undefined });
	return row?.[field.key];
}

export function searchKeys(fields) {
	return fields.filter((field) => field.searchable).map((field) => field.key);
}

export function reconcileKeys(saved, canonical) {
	const available = new Set(canonical);
	const reconciled = [];
	for (const key of Array.isArray(saved) ? saved : []) {
		if (available.has(key) && !reconciled.includes(key)) reconciled.push(key);
	}
	for (const key of canonical) if (!reconciled.includes(key)) reconciled.push(key);
	return reconciled;
}

export function reconcileColumnOrder(saved, columns) {
	const fixed = columns
		.filter((column) => column.fixed === "left" || column.fixed === true)
		.map((column) => column.key);
	const movable = columns
		.filter((column) => !fixed.includes(column.key))
		.map((column) => column.key);
	return [...fixed, ...reconcileKeys(saved, movable)];
}

export function reconcileVisible(saved, fields, view, previousSchema = null) {
	const available = fields.filter((field) => viewOptions(field, view)).map((field) => field.key);
	const defaults = fields
		.filter((field) => viewOptions(field, view) && field.default !== false)
		.map((field) => field.key);
	const valid = (Array.isArray(saved) ? saved : []).filter((key) => available.includes(key));
	if (!Array.isArray(saved)) return defaults;
	if (!Array.isArray(previousSchema)) return valid.length ? valid : defaults;
	const previous = new Set(previousSchema);
	return [...valid, ...defaults.filter((key) => !previous.has(key) && !valid.includes(key))];
}

export function isTechnicalField(key) {
	return TECHNICAL_FIELDS.has(key);
}
