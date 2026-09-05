frappe.pages["catalog"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Распечатка OS"),
		single_column: true,
	});

	wrapper.catalog_page = new RaspechatkaCatalogPage(page);
};

frappe.pages["catalog"].on_page_show = function (wrapper) {
	wrapper.catalog_page?.refresh();
};

class RaspechatkaCatalogPage {
	constructor(page) {
		this.page = page;
		this.page_length = 100;
		this.limit_start = 0;
		this.items = [];
		this.request_id = 0;
		this.options_loaded = false;
		this.render();
		this.bind_events();
	}

	render() {
		this.page.main.html(`
			<div class="raspechatka-catalog">
				<div class="catalog-hero">
					<div class="catalog-brand">
						<img src="/assets/raspechatka/images/raspechatka.svg" alt="">
						<div>
							<p class="catalog-eyebrow">${__("Распечатка OS")}</p>
							<h1 class="catalog-title">${__("Товары и услуги")}</h1>
						</div>
					</div>
					<div class="catalog-actions">
						<button class="btn btn-default btn-sm" data-action="assortment">${__("Ассортимент по точкам")}</button>
						<button class="btn btn-primary btn-sm" data-create="Product">${__("Создать товар")}</button>
						<button class="btn btn-primary btn-sm" data-create="Service">${__("Создать услугу")}</button>
						<button class="btn btn-primary btn-sm" data-create="Bundle">${__("Создать комплект")}</button>
					</div>
				</div>
				<div class="catalog-panel">
					<div class="catalog-toolbar">
						<div class="catalog-field">
							<label for="catalog-search">${__("Поиск")}</label>
							<div class="catalog-search-wrap">
								<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
								<input id="catalog-search" class="form-control catalog-search" type="search" placeholder="${__("Название, код или артикул")}" autocomplete="off">
							</div>
						</div>
						${this.select_field("catalog-type", __("Тип"), [["", __("Все типы")], ["Product", __("Товар")], ["Service", __("Услуга")], ["Bundle", __("Комплект")]])}
						${this.select_field("catalog-group", __("Группа"), [["", __("Все группы")]])}
						${this.select_field("catalog-active", __("Активность"), [["", __("Все")], ["1", __("Активные")], ["0", __("Неактивные")]])}
						${this.select_field("catalog-point", __("Точка продаж"), [["", __("Все точки")]])}
					</div>
					<div class="catalog-summary">
						<span class="catalog-result-count">${__("Загрузка…")}</span>
						<button class="btn btn-xs btn-default" data-action="reset">${__("Сбросить фильтры")}</button>
					</div>
					<div class="catalog-results"></div>
					<div class="catalog-load-more" hidden>
						<button class="btn btn-default btn-sm" data-action="load-more">${__("Показать ещё")}</button>
					</div>
				</div>
			</div>
		`);

		this.$root = this.page.main.find(".raspechatka-catalog");
		this.$results = this.$root.find(".catalog-results");
		this.$count = this.$root.find(".catalog-result-count");
		this.$load_more = this.$root.find(".catalog-load-more");
	}

	select_field(id, label, options) {
		const option_html = options
			.map(([value, text]) => `<option value="${frappe.utils.escape_html(value)}">${frappe.utils.escape_html(text)}</option>`)
			.join("");
		return `<div class="catalog-field"><label for="${id}">${label}</label><select id="${id}" class="form-control">${option_html}</select></div>`;
	}

	bind_events() {
		const search = frappe.utils.debounce(() => this.refresh(), 300);
		this.$root.on("input", "#catalog-search", search);
		this.$root.on("change", "select", () => this.refresh());
		this.$root.on("click", "[data-create]", (event) => {
			raspechatka.catalog.create_item(event.currentTarget.dataset.create);
		});
		this.$root.on("click", "[data-action='assortment']", () => this.open_assortment());
		this.$root.on("click", "[data-action='reset']", () => this.reset_filters());
		this.$root.on("click", "[data-action='load-more']", () => this.load_more());
		this.$root.on("click", ".catalog-row", (event) => this.open_item(event.currentTarget.dataset.name));
		this.$root.on("keydown", ".catalog-row", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				this.open_item(event.currentTarget.dataset.name);
			}
		});
	}

	async load_options() {
		if (this.options_loaded) return;

		const [groups, points] = await Promise.all([
			frappe.db.get_list("Catalog Group", {
				fields: ["name", "group_name"],
				filters: { active: 1 },
				order_by: "group_name asc",
				limit: 500,
			}),
			frappe.db.get_list("Business Point", {
				fields: ["name", "point_name"],
				filters: { active: 1 },
				order_by: "point_name asc",
				limit: 500,
			}),
		]);

		this.fill_select("#catalog-group", groups, "name", "group_name");
		this.fill_select("#catalog-point", points, "name", "point_name");
		this.options_loaded = true;
	}

	fill_select(selector, rows, value_field, label_field) {
		const $select = this.$root.find(selector);
		for (const row of rows) {
			$("<option>").val(row[value_field]).text(row[label_field] || row[value_field]).appendTo($select);
		}
	}

	get_filters() {
		return {
			search: this.$root.find("#catalog-search").val().trim(),
			item_type: this.$root.find("#catalog-type").val(),
			catalog_group: this.$root.find("#catalog-group").val(),
			active: this.$root.find("#catalog-active").val(),
			business_point: this.$root.find("#catalog-point").val(),
		};
	}

	async refresh() {
		const request_id = ++this.request_id;
		this.limit_start = 0;
		this.items = [];
		this.render_loading();

		try {
			await this.load_options();
			const rows = await this.fetch_items();
			if (request_id !== this.request_id) return;
			this.items = rows;
			this.render_items(rows);
		} catch (error) {
			if (request_id !== this.request_id) return;
			this.render_error(error);
		}
	}

	async fetch_items() {
		const values = this.get_filters();
		const filters = {};
		if (values.item_type) filters.item_type = values.item_type;
		if (values.catalog_group) filters.catalog_group = values.catalog_group;
		if (values.active !== "") filters.active = Number(values.active);

		if (values.business_point) {
			const assortment = await frappe.db.get_list("Catalog Assortment", {
				fields: ["item"],
				filters: { business_point: values.business_point, enabled: 1 },
				limit: 10000,
			});
			const item_names = [...new Set(assortment.map((row) => row.item).filter(Boolean))];
			if (!item_names.length) return [];
			filters.name = ["in", item_names];
		}

		const options = {
			fields: ["name", "item_type", "item_name", "item_code", "article", "catalog_group", "stock_uom", "active"],
			filters,
			order_by: "item_name asc",
			limit_start: this.limit_start,
			limit: this.page_length,
		};

		if (values.search) {
			const term = `%${values.search}%`;
			options.or_filters = [
				["Catalog Item", "item_name", "like", term],
				["Catalog Item", "item_code", "like", term],
				["Catalog Item", "article", "like", term],
			];
		}

		return frappe.db.get_list("Catalog Item", options);
	}

	async load_more() {
		const request_id = ++this.request_id;
		this.limit_start += this.page_length;
		this.$load_more.find("button").prop("disabled", true);
		try {
			const rows = await this.fetch_items();
			if (request_id !== this.request_id) return;
			this.items.push(...rows);
			this.render_items(this.items, rows.length === this.page_length);
		} catch (error) {
			if (request_id === this.request_id) this.render_error(error);
		} finally {
			this.$load_more.find("button").prop("disabled", false);
		}
	}

	render_loading() {
		this.$count.text(__("Загрузка…"));
		this.$load_more.prop("hidden", true);
		this.$results.html(`<div class="catalog-state">${__("Загружаем каталог…")}</div>`);
	}

	render_items(rows, has_more = rows.length === this.page_length) {
		this.$count.text(__("Показано позиций: {0}", [rows.length]));
		this.$load_more.prop("hidden", !has_more);
		if (!rows.length) {
			this.$results.html(`<div class="catalog-state">${__("По заданным фильтрам ничего не найдено.")}</div>`);
			return;
		}

		const body = rows.map((item) => this.item_row(item)).join("");
		this.$results.html(`
			<div class="catalog-table-wrap">
				<table class="catalog-table">
					<thead><tr>
						<th>${__("Тип")}</th>
						<th>${__("Наименование")}</th>
						<th>${__("Код")}</th>
						<th>${__("Группа")}</th>
						<th>${__("Единица измерения")}</th>
						<th>${__("Статус")}</th>
					</tr></thead>
					<tbody>${body}</tbody>
				</table>
			</div>
		`);
	}

	item_row(item) {
		const escape = frappe.utils.escape_html;
		const type = raspechatka.catalog.item_types[item.item_type] || item.item_type;
		const status_class = item.active ? "is-active" : "is-inactive";
		const status = item.active ? __("Активен") : __("Неактивен");
		return `
			<tr class="catalog-row" role="button" tabindex="0" data-name="${escape(item.name)}" aria-label="${escape(__("Открыть {0}", [item.item_name]))}">
				<td><span class="catalog-badge">${escape(type)}</span></td>
				<td><div class="catalog-item-name">${escape(item.item_name)}</div>${item.article ? `<div class="catalog-secondary">${escape(__("Артикул: {0}", [item.article]))}</div>` : ""}</td>
				<td><span class="catalog-code">${escape(item.item_code)}</span></td>
				<td>${escape(item.catalog_group || "—")}</td>
				<td>${escape(item.stock_uom || "—")}</td>
				<td><span class="catalog-status ${status_class}">${status}</span></td>
			</tr>`;
	}

	render_error(error) {
		console.error(error);
		this.$count.text(__("Не удалось загрузить каталог"));
		this.$load_more.prop("hidden", true);
		this.$results.html(`<div class="catalog-state">${__("Ошибка загрузки. Проверьте права доступа и повторите попытку.")}</div>`);
	}

	reset_filters() {
		this.$root.find("#catalog-search").val("");
		this.$root.find("select").val("");
		this.refresh();
	}

	open_assortment() {
		const business_point = this.$root.find("#catalog-point").val();
		frappe.route_options = business_point ? { business_point } : {};
		frappe.set_route("List", "Catalog Assortment");
	}

	open_item(item_name) {
		frappe.set_route("Form", "Catalog Item", item_name);
	}
}
