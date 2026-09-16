from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative):
	return (ROOT / relative).read_text()


def test_shared_table_uses_descriptor_display_resolver_for_rendering_and_sorting():
	source = read("frontend/src/components/SmartDataTable.vue")
	assert "resolveDisplayValue(row, column)" in source
	assert "resolveSortValue(a, column)" in source
	assert "resolveSortValue(b, column)" in source


def test_reference_lists_batch_hydrate_links_without_replacing_raw_values():
	source = read("raspechatka/api/references.py")
	assert "REFERENCE_LINK_DISPLAYS" in source
	assert "def _hydrate_reference_labels" in source
	assert 'row[f"{key}_label"]' in source
	assert 'filters={"name": ["in", list(names)]}' in source


def test_control_pages_declare_display_keys_for_known_link_fields():
	contracts = {
		"frontend/src/pages/ReferencesPage.vue": (
			"organization_label",
			"business_entity_label",
			"business_point_label",
		),
		"frontend/src/pages/ClientsPage.vue": ("registration_point_label",),
		"frontend/src/pages/EmployeesPage.vue": ("position_label", "business_entity_label"),
		"frontend/src/pages/CatalogPage.vue": ("catalog_group_label", "variant_of_label"),
	}
	for path, display_keys in contracts.items():
		source = read(path)
		for display_key in display_keys:
			assert display_key in source, f"{path}: {display_key}"


def test_users_map_roles_scope_and_invitation_to_business_labels():
	frontend = read("frontend/src/pages/UsersPage.vue")
	backend = read("raspechatka/api/users.py")
	assert "access_profile_label" in frontend
	assert "access_profile_label" in backend
	for value, label in (
		("Network", "Вся сеть"),
		("Business Entity", "Юридическое лицо"),
		("Points", "Выбранные точки"),
		("Not Generated", "Не создано"),
		("Generated", "Приглашение создано"),
		("Activated", "Пользователь активирован"),
	):
		assert f'value: "{value}", label: "{label}"' in frontend


def test_link_hydration_is_batched_in_domain_list_endpoints():
	for path in (
		"raspechatka/api/clients.py",
		"raspechatka/api/team.py",
		"raspechatka/api/frontend.py",
		"raspechatka/api/finance.py",
	):
		source = read(path)
		assert '["in", list(' in source, path
		assert "_label" in source, path
