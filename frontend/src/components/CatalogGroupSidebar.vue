<script setup>
import { computed } from "vue";

const props = defineProps({
  groups: { type: Array, default: () => [] },
  selected: { type: String, default: "" },
  canEdit: { type: Boolean, default: false },
});
const emit = defineEmits(["select", "create", "edit"]);

const rows = computed(() => {
  const children = new Map();
  for (const group of props.groups) {
    const parent = group.parent_catalog_group || "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(group);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.group_name || "").localeCompare(b.group_name || "", "ru"));
  }
  const result = [];
  const visited = new Set();
  const visit = (parent, depth) => {
    for (const group of children.get(parent) || []) {
      if (visited.has(group.name)) continue;
      visited.add(group.name);
      result.push({ ...group, depth });
      visit(group.name, depth + 1);
    }
  };
  visit("", 0);
  for (const group of props.groups) {
    if (!visited.has(group.name)) result.push({ ...group, depth: 0 });
  }
  return result;
});

const total = computed(() =>
  props.groups.reduce((sum, group) => sum + Number(group.direct_item_count || 0), 0)
);
</script>

<template>
  <aside class="group-panel" aria-label="Группы каталога">
    <div class="group-panel__head">
      <div>
        <span class="group-panel__eyebrow">Навигация</span>
        <h2>Группы</h2>
      </div>
      <button v-if="canEdit" class="group-add" type="button" title="Создать группу" @click="emit('create', null)">＋</button>
    </div>

    <div class="group-tree">
      <button class="group-row group-row--all" :class="{ active: !selected }" type="button" @click="emit('select', '')">
        <span class="group-icon">▦</span>
        <span class="group-title">Все позиции</span>
        <span class="group-count">{{ total }}</span>
      </button>
      <div v-for="group in rows" :key="group.name" class="group-entry">
        <button
          class="group-row"
          :class="{ active: selected === group.name }"
          :style="{ paddingLeft: `${14 + Math.min(group.depth, 5) * 18}px` }"
          type="button"
          @click="emit('select', group.name)"
        >
          <span class="group-icon">{{ group.is_group ? "▾" : "⌑" }}</span>
          <span class="group-title">{{ group.group_name }}</span>
          <span class="group-count">{{ group.item_count || 0 }}</span>
        </button>
        <button v-if="canEdit" class="group-edit" type="button" title="Изменить группу" @click.stop="emit('edit', group)">•••</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.group-panel {
  width: 260px;
  min-width: 260px;
  align-self: stretch;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: #fff;
  overflow: hidden;
}
.group-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 17px 16px 13px;
  border-bottom: 1px solid var(--border);
}
.group-panel__head h2 { margin: 2px 0 0; font-size: 17px; }
.group-panel__eyebrow { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.group-add {
  width: 34px; height: 34px; border: 0; border-radius: 10px;
  background: var(--green-soft); color: var(--green-dark); font-size: 20px; cursor: pointer;
}
.group-tree { padding: 8px; max-height: calc(100vh - 245px); overflow: auto; }
.group-entry { position: relative; }
.group-row {
  width: 100%; min-height: 38px; display: grid; grid-template-columns: 18px minmax(0,1fr) auto;
  gap: 7px; align-items: center; padding: 7px 10px; padding-right: 34px;
  border: 0; border-radius: 10px; background: transparent; color: var(--text);
  text-align: left; cursor: pointer;
}
.group-row:hover { background: #f7f8f5; }
.group-row.active { background: var(--green-soft); color: var(--green-dark); font-weight: 650; }
.group-row--all { padding-right: 10px; margin-bottom: 4px; }
.group-icon { color: #92a080; font-size: 13px; }
.group-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.group-edit {
  position: absolute; right: 9px; top: 7px; width: 27px; height: 25px;
  border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; opacity: 0;
}
.group-entry:hover .group-edit, .group-edit:focus { opacity: 1; }
@media (max-width: 900px) {
  .group-panel { width: 100%; min-width: 0; }
  .group-tree { max-height: 260px; }
}
</style>
