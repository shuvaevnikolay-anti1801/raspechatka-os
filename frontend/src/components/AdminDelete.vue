<script setup>
import { computed, ref } from "vue";
import { call, canAccess } from "../api";

const props = defineProps({
	area: { type: String, required: true },
	entityType: { type: String, required: true },
	name: { type: String, required: true },
	label: { type: String, default: "объект" },
});
const emit = defineEmits(["deleted"]);
const allowed = computed(() => canAccess(props.area, "Admin"));
const busy = ref(false);
const message = ref("");
const dependencies = ref({});
const endpoint = "raspechatka.deletion.";
function show(result) {
	message.value = result.message || "Удаление недоступно";
	dependencies.value = result.dependencies || {};
}
function success(message) {
	const notice = document.createElement("div");
	notice.className = "admin-delete-notice";
	notice.setAttribute("role", "status");
	notice.textContent = message;
	document.body.appendChild(notice);
	window.setTimeout(() => notice.remove(), 6000);
}
async function remove() {
	if (!allowed.value || busy.value) return;
	busy.value = true;
	message.value = "";
	dependencies.value = {};
	try {
		const params = { entity_type: props.entityType, name: props.name };
		const preview = await call(`${endpoint}get_delete_preview`, params);
		if (!preview.can_delete) {
			show(preview);
			return;
		}
		if (preview.strategy !== "hard_delete" || (preview.affected || []).length) {
			if (!window.confirm(`Удалить ${props.label}? ${preview.message}`)) return;
		} else if (!window.confirm(`Удалить ${props.label}?`)) return;
		const result = await call(`${endpoint}delete_entity`, params, { method: "POST" });
		show(result);
		if (result.deleted) {
			success(result.message);
			emit("deleted", result);
		}
	} catch (error) {
		message.value = error.message || "Не удалось удалить объект";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<div v-if="allowed && name" class="admin-delete">
		<button
			type="button"
			class="button button-secondary danger"
			:disabled="busy"
			@click="remove"
		>
			{{ busy ? "Проверяем…" : "Удалить" }}
		</button>
		<p v-if="message" role="status">{{ message }}</p>
		<ul v-if="Object.keys(dependencies).length" role="list">
			<li v-for="(entry, type) in dependencies" :key="type">
				{{ type }}: {{ entry.count }} ({{ entry.names.join(", ") }})
			</li>
		</ul>
	</div>
</template>

<style scoped>
.admin-delete {
	display: inline-block;
	color: #a5212a;
}
.admin-delete p {
	margin: 6px 0;
}
.admin-delete ul {
	margin: 4px 0;
	padding-left: 20px;
}
</style>
