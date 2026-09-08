<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import { boot, canAccess } from "./api";
import accessSections from "./access-pages.json";
import TopNavigation from "./components/TopNavigation.vue";

const route = useRoute();
const can = canAccess;

const submenus = Object.fromEntries(
	accessSections.map((section) => [
		section.key,
		(section.pages || [])
			.filter((page) => page.submenu !== false)
			.sort((left, right) => (left.order || 0) - (right.order || 0))
			.map((page) => ({
				label: page.label,
				to: page.route,
				area: page.area,
				minimum: page.minimum || "View",
			})),
	])
);

const currentModule = computed(() => route.meta.module || route.params.module || "dashboard");
const currentSubmenu = computed(() =>
	(submenus[currentModule.value] || []).filter(
		(item) => typeof item === "string" || !item.area || can(item.area, item.minimum)
	)
);
const submenuItems = computed(() =>
	currentSubmenu.value.map((item) => (typeof item === "string" ? { label: item, to: null } : item))
);
</script>

<template>
	<div class="app-shell">
		<TopNavigation />
		<nav class="subnav" aria-label="Подразделы">
			<template v-for="(item, index) in submenuItems" :key="item.label">
				<router-link v-if="item.to" :to="item.to" :class="{ active: route.path === item.to }">
					<span class="subnav-label">{{ item.label }}</span>
					<strong class="subnav-measure" aria-hidden="true">{{ item.label }}</strong>
				</router-link>
				<button v-else type="button" :class="{ active: index === 0 }">
					<span class="subnav-label">{{ item.label }}</span>
					<strong class="subnav-measure" aria-hidden="true">{{ item.label }}</strong>
				</button>
			</template>
		</nav>
		<main class="workspace"><router-view /></main>
	</div>
</template>

<style scoped>
.subnav { top: 72px; overflow-y: hidden; }
.subnav :is(a, button) { display: grid; align-items: center; }
.subnav-label, .subnav-measure { grid-area: 1 / 1; }
.subnav-measure { visibility: hidden; font-weight: 650; pointer-events: none; }
.subnav :is(a, button).active::after { background: var(--green); }
@media (max-width: 760px) { .subnav { top: 64px; } }
</style>
