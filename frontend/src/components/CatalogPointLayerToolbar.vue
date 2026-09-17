<script setup>
import { computed } from "vue";

const props = defineProps({
	points: { type: Array, default: () => [] },
	businessPoint: { type: String, default: "" },
	sourcePoint: { type: String, default: "" },
	allowAll: { type: Boolean, default: false },
	showSource: { type: Boolean, default: false },
	disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:businessPoint", "update:sourcePoint", "change-point"]);
const sourcePoints = computed(() =>
	props.points.filter((point) => point.name !== props.businessPoint),
);

function changePoint(event) {
	emit("update:businessPoint", event.target.value);
	emit("change-point");
}
</script>

<template>
	<section class="catalog-toolbar" aria-label="Управление разделом каталога">
		<div class="catalog-toolbar__context">
			<label class="catalog-toolbar__field">
				<span>Точка продаж</span>
				<select :value="businessPoint" :disabled="disabled" @change="changePoint">
					<option v-if="allowAll" value="__all__">Все точки</option>
					<option v-for="point in points" :key="point.name" :value="point.name">
						{{ point.point_name }}
					</option>
				</select>
			</label>
			<label v-if="showSource" class="catalog-toolbar__field catalog-toolbar__source">
				<span>Копировать из точки</span>
				<select
					:value="sourcePoint"
					:disabled="disabled || !businessPoint"
					@change="$emit('update:sourcePoint', $event.target.value)"
				>
					<option value="">Выберите точку…</option>
					<option v-for="point in sourcePoints" :key="point.name" :value="point.name">
						{{ point.point_name }}
					</option>
				</select>
			</label>
		</div>
		<div v-if="$slots.actions" class="catalog-toolbar__actions">
			<slot name="actions" />
		</div>
	</section>
</template>

<style scoped>
.catalog-toolbar {
	display: flex;
	align-items: end;
	gap: 18px;
	margin-bottom: 16px;
	padding: 16px;
	border: 1px solid var(--border);
	border-radius: 16px;
	background: #fff;
	box-shadow: 0 8px 24px rgb(34 58 38 / 5%);
}
.catalog-toolbar__context,
.catalog-toolbar__actions {
	display: flex;
	align-items: end;
	gap: 10px;
	min-width: 0;
	flex-wrap: wrap;
}
.catalog-toolbar__context {
	flex: 1 1 auto;
}
.catalog-toolbar__actions {
	justify-content: flex-end;
	margin-left: auto;
}
.catalog-toolbar__field {
	display: grid;
	gap: 6px;
	min-width: 240px;
	font-size: 12px;
	font-weight: 600;
	color: var(--muted);
}
.catalog-toolbar__field select {
	min-height: 42px;
	width: 100%;
}
.catalog-toolbar__source {
	min-width: 260px;
}
@media (max-width: 900px) {
	.catalog-toolbar {
		align-items: stretch;
		flex-direction: column;
	}
	.catalog-toolbar__actions {
		justify-content: flex-start;
		margin-left: 0;
	}
}
@media (max-width: 620px) {
	.catalog-toolbar {
		padding: 12px;
	}
	.catalog-toolbar__context,
	.catalog-toolbar__actions {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		width: 100%;
	}
	.catalog-toolbar__field,
	.catalog-toolbar__source {
		min-width: 0;
	}
	.catalog-toolbar__actions :deep(.button) {
		width: 100%;
	}
}
</style>
