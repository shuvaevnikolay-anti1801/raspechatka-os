<script setup>
import SmartDataTable from "./SmartDataTable.vue";

const props = defineProps({
  rows: { type: Array, default: () => [] },
  columns: { type: Array, required: true },
  viewKey: { type: String, required: true },
  loading: Boolean,
  error: String,
});
defineEmits(["open", "retry"]);
</script>

<template>
  <SmartDataTable :rows="rows" :columns="columns" :view-key="viewKey" :loading="loading" :error="error" empty-title="Список пока пуст" empty-text="Создайте первую запись." @open="$emit('open',$event)" @retry="$emit('retry')">
    <template #cell-active="{row}"><span class="state" :class="{inactive:!row.active}"><i></i>{{row.active?'Активен':'Выключен'}}</span></template>
  </SmartDataTable>
</template>
