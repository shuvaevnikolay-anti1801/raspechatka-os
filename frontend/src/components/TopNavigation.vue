<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { boot, call, canAccess } from "../api";
import accessSections from "../access-pages.json";

const emit = defineEmits(["navigate"]);
const route = useRoute();
const mobileOpen = ref(false);
const notificationsOpen = ref(false);
const accountOpen = ref(false);
const loading = ref(false);
const notifications = ref([]);
const unreadCount = ref(0);
const actionRoot = ref(null);
let refreshTimer;

const icons = {
	references: "M4 5.5h5m3 0h8M4 12h9m3 0h4M4 18.5h3m3 0h10M9 3v5m5 1.5v5M8 16v5",
	dashboard: "M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z",
	sales: "M5 4h14v16H5zM8 8h8M8 12h3m2 0h3M8 16h2m3 0h3",
	clients:
		"M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-1a3 3 0 1 0 0-6M3 20a5.5 5.5 0 0 1 11 0m1-6a5 5 0 0 1 6 4.85",
	catalog: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9",
	warehouse: "M3 9 12 4l9 5v11H3zM7 20v-6h10v6M8 10h.01m4 0h.01m4 0h.01",
	finance: "M4 19h16M6 16V9m4 7V5m4 11v-4m4 4V7",
	team: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.5-.5a3 3 0 1 0 0-6M3 20a6 6 0 0 1 12 0m1-6a5 5 0 0 1 5 5",
};

const modules = accessSections
	.slice()
	.sort((left, right) => (left.order || 0) - (right.order || 0));

const visibleModules = computed(() =>
	modules.flatMap((item) => {
		const firstPage = (item.pages || [])
			.slice()
			.sort((left, right) => (left.order || 0) - (right.order || 0))
			.find((page) => canAccess(page.area, page.minimum || "View"));
		return firstPage ? [{ ...item, to: firstPage.route }] : [];
	})
);
const currentModule = computed(() => route.meta.module || route.params.module || "dashboard");
const initials = computed(() => (boot.full_name || boot.user || "Р").trim().slice(0, 1).toUpperCase());
const hasUnread = computed(() => unreadCount.value > 0);

async function loadNotifications() {
	loading.value = true;
	try {
		const result = await call("raspechatka.api.notifications.get_notifications", { limit_page_length: 20 });
		notifications.value = result.items || [];
		unreadCount.value = result.unread_count || 0;
	} catch (error) {
		notifications.value = [];
	} finally {
		loading.value = false;
	}
}

async function toggleNotifications() {
	notificationsOpen.value = !notificationsOpen.value;
	accountOpen.value = false;
	if (notificationsOpen.value) await loadNotifications();
}

function toggleAccount() {
	accountOpen.value = !accountOpen.value;
	notificationsOpen.value = false;
}

async function markRead(item) {
	if (item.read) return;
	item.read = true;
	unreadCount.value = Math.max(0, unreadCount.value - 1);
	try {
		await call(
			"raspechatka.api.notifications.mark_notification_read",
			{ announcement: item.name },
			{ method: "POST" }
		);
	} catch (error) {
		item.read = false;
		unreadCount.value += 1;
	}
}

function closeMenus(event) {
	if (!actionRoot.value?.contains(event.target)) {
		notificationsOpen.value = false;
		accountOpen.value = false;
	}
}

function navigate() {
	mobileOpen.value = false;
	notificationsOpen.value = false;
	accountOpen.value = false;
	emit("navigate");
}

function openProfile() {
	window.location.assign("/app/user-profile");
}

function logout() {
	window.location.assign("/api/method/logout");
}

onMounted(() => {
	loadNotifications();
	refreshTimer = window.setInterval(loadNotifications, 60000);
	nextTick(() => document.addEventListener("click", closeMenus));
});
onBeforeUnmount(() => {
	window.clearInterval(refreshTimer);
	document.removeEventListener("click", closeMenus);
});
</script>

<template>
	<header class="topbar topbar-v2">
		<router-link class="brand brand-v2" to="/" aria-label="Распечатка ОС — главная" @click="navigate">
			<img :src="'/assets/raspechatka/images/raspechatka-brand.png'" alt="" />
			<span class="brand-name">Распечатка <b>ОС</b></span>
		</router-link>

		<nav class="main-nav main-nav-v2" aria-label="Основные разделы">
			<router-link
				v-for="item in visibleModules"
				:key="item.key"
				:to="item.to"
				:class="{ active: currentModule === item.key }"
				@click="navigate"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[item.key]" /></svg>
				<span>{{ item.label }}</span>
			</router-link>
		</nav>

		<div ref="actionRoot" class="topbar-actions topbar-actions-v2">
			<div class="action-wrap">
				<button
					class="header-action"
					type="button"
					:class="{ active: notificationsOpen }"
					aria-label="Уведомления"
					:aria-expanded="notificationsOpen"
					@click.stop="toggleNotifications"
				>
					<svg viewBox="0 0 24 24" aria-hidden="true">
						<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
					</svg>
					<span v-if="hasUnread" class="notification-badge">{{
						unreadCount > 99 ? "99+" : unreadCount
					}}</span>
				</button>
				<section
					v-if="notificationsOpen"
					class="header-popover notification-popover"
					aria-label="Новости и уведомления"
				>
					<header>
						<div>
							<small>РАСПЕЧАТКА ОС</small>
							<h2>Новости и уведомления</h2>
						</div>
						<span v-if="hasUnread">{{ unreadCount }} новых</span>
					</header>
					<div v-if="loading && !notifications.length" class="popover-state">Загружаем новости…</div>
					<div v-else-if="!notifications.length" class="popover-state">
						<b>Пока всё прочитано</b><span>Новые сообщения администратора появятся здесь.</span>
					</div>
					<div v-else class="notification-list">
						<article v-for="item in notifications" :key="item.name" :class="{ unread: !item.read }">
							<button type="button" @click="markRead(item)">
								<span class="news-marker"></span>
								<span class="news-copy">
									<small
										>{{ item.priority === "Important" ? "ВАЖНО" : "НОВОСТЬ" }} ·
										{{ item.published_label }}</small
									>
									<b>{{ item.title }}</b>
									<span>{{ item.message }}</span>
									<em>{{ item.read ? "Прочитано" : "Нажмите, чтобы отметить прочитанным" }}</em>
								</span>
							</button>
						</article>
					</div>
				</section>
			</div>

			<div class="action-wrap">
				<button
					class="account-button"
					type="button"
					:class="{ active: accountOpen }"
					:aria-expanded="accountOpen"
					@click.stop="toggleAccount"
				>
					<span class="avatar avatar-v2">{{ initials }}</span>
					<span class="account-copy"
						><b>{{ boot.full_name || boot.user }}</b
						><small>Аккаунт</small></span
					>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
				</button>
				<section v-if="accountOpen" class="header-popover account-popover">
					<div class="account-summary">
						<span class="avatar avatar-large">{{ initials }}</span>
						<div>
							<b>{{ boot.full_name || boot.user }}</b
							><small>{{ boot.user }}</small>
						</div>
					</div>
					<button type="button" @click="openProfile">
						<span>Настройки аккаунта</span><small>Профиль, язык и пароль</small>
					</button>
					<button class="logout-button" type="button" @click="logout"><span>Выйти из системы</span></button>
				</section>
			</div>

			<button
				class="menu-button menu-button-v2"
				type="button"
				@click="mobileOpen = !mobileOpen"
				aria-label="Открыть меню"
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
			</button>
		</div>
	</header>

	<nav v-if="mobileOpen" class="mobile-nav mobile-nav-v2" aria-label="Мобильное меню">
		<router-link v-for="item in visibleModules" :key="item.key" :to="item.to" @click="navigate">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icons[item.key]" /></svg>
			<span>{{ item.label }}</span>
		</router-link>
	</nav>
</template>

<style scoped>
.topbar-v2 {
	height: 72px;
	align-items: stretch;
	background: rgba(255, 255, 255, 0.98);
	box-shadow: 0 1px 0 rgba(24, 28, 20, 0.04);
}
.brand-v2 {
	min-width: 208px;
	gap: 11px;
	padding: 0 18px;
}
.brand-v2 img {
	width: 40px;
	height: 40px;
	flex: 0 0 auto;
}
.brand-name {
	font-size: 16px;
	font-weight: 700;
	letter-spacing: -0.035em;
	line-height: 1;
	white-space: nowrap;
}
.brand-name b {
	color: #789a08;
	font-weight: 750;
}
.main-nav-v2 {
	justify-content: flex-start;
	padding: 0 4px;
}
.main-nav-v2 a {
	min-width: 82px;
	flex: 0 0 auto;
	flex-direction: column;
	justify-content: center;
	gap: 5px;
	padding: 0 11px;
	font-size: 11px;
	font-weight: 650;
}
.main-nav-v2 a svg {
	width: 27px;
	height: 27px;
	fill: none;
	stroke: currentColor;
	stroke-linecap: round;
	stroke-linejoin: round;
	stroke-width: 1.65;
}
.main-nav-v2 a:hover {
	background: #f7f9f4;
}
.main-nav-v2 a.active {
	color: #171917;
	background: #f7faee;
}
.main-nav-v2 a.active svg {
	color: #719400;
	stroke-width: 1.9;
}
.main-nav-v2 a.active::after {
	right: 10px;
	left: 10px;
}
.topbar-actions-v2 {
	gap: 5px;
	padding: 0 16px 0 10px;
	border-left: 1px solid var(--line);
}
.action-wrap {
	position: relative;
}
.header-action,
.account-button,
.menu-button-v2 {
	border: 0;
	background: transparent;
}
.header-action {
	position: relative;
	display: grid;
	width: 42px;
	height: 42px;
	place-items: center;
	border-radius: 50%;
}
.header-action:hover,
.header-action.active {
	background: #f0f4e7;
}
.header-action svg,
.menu-button-v2 svg {
	width: 21px;
	height: 21px;
	fill: none;
	stroke: currentColor;
	stroke-linecap: round;
	stroke-linejoin: round;
	stroke-width: 1.7;
}
.notification-badge {
	position: absolute;
	top: 1px;
	right: 0;
	display: grid;
	min-width: 18px;
	height: 18px;
	place-items: center;
	padding: 0 4px;
	border: 2px solid #fff;
	border-radius: 10px;
	background: var(--green);
	color: #172000;
	font-size: 8px;
	font-weight: 800;
}
.account-button {
	display: flex;
	min-width: 158px;
	height: 50px;
	align-items: center;
	gap: 9px;
	padding: 5px 8px;
	border-radius: 3px;
	text-align: left;
}
.account-button:hover,
.account-button.active {
	background: #f4f6f1;
}
.avatar-v2 {
	display: grid;
	width: 34px;
	height: 34px;
	place-items: center;
	flex: 0 0 auto;
	border: 0;
	background: #242724;
}
.account-copy {
	display: grid;
	min-width: 0;
	flex: 1;
	gap: 2px;
}
.account-copy b {
	overflow: hidden;
	font-size: 11px;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.account-copy small {
	color: #858a82;
	font-size: 9px;
}
.account-button > svg {
	width: 16px;
	height: 16px;
	fill: none;
	stroke: #7c8179;
	stroke-width: 1.8;
}
.header-popover {
	position: absolute;
	z-index: 60;
	top: calc(100% + 13px);
	right: 0;
	border: 1px solid var(--line-dark);
	background: #fff;
	box-shadow: 0 20px 50px rgba(21, 25, 18, 0.17);
}
.header-popover::before {
	position: absolute;
	top: -7px;
	right: 17px;
	width: 12px;
	height: 12px;
	border-top: 1px solid var(--line-dark);
	border-left: 1px solid var(--line-dark);
	background: #fff;
	content: "";
	transform: rotate(45deg);
}
.notification-popover {
	width: min(420px, calc(100vw - 24px));
}
.notification-popover > header {
	display: flex;
	min-height: 72px;
	align-items: center;
	justify-content: space-between;
	padding: 14px 17px;
	border-bottom: 1px solid var(--line);
}
.notification-popover h2 {
	margin: 3px 0 0;
	font-size: 17px;
	letter-spacing: -0.03em;
}
.notification-popover header small {
	color: #6f8e08;
	font-size: 8px;
	font-weight: 800;
	letter-spacing: 0.13em;
}
.notification-popover header > span {
	padding: 5px 8px;
	background: var(--green-soft);
	color: #526d00;
	font-size: 9px;
	font-weight: 750;
}
.notification-list {
	max-height: 430px;
	overflow: auto;
}
.notification-list article {
	border-bottom: 1px solid #eceeea;
}
.notification-list article:last-child {
	border-bottom: 0;
}
.notification-list article.unread {
	background: #fbfdf5;
}
.notification-list button {
	display: flex;
	width: 100%;
	border: 0;
	background: transparent;
	padding: 0;
	text-align: left;
}
.notification-list button:hover {
	background: #f7f9f4;
}
.news-marker {
	width: 4px;
	align-self: stretch;
	flex: 0 0 auto;
	background: transparent;
}
.unread .news-marker {
	background: var(--green);
}
.news-copy {
	display: grid;
	gap: 5px;
	padding: 14px 16px;
}
.news-copy small {
	color: #7d837a;
	font-size: 8px;
	font-weight: 750;
	letter-spacing: 0.08em;
}
.news-copy b {
	font-size: 12px;
}
.news-copy > span {
	display: -webkit-box;
	overflow: hidden;
	color: #626860;
	font-size: 10px;
	line-height: 1.45;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
}
.news-copy em {
	color: #7c950f;
	font-size: 8px;
	font-style: normal;
}
.popover-state {
	display: grid;
	min-height: 180px;
	place-content: center;
	gap: 7px;
	padding: 24px;
	color: #8a8f87;
	font-size: 10px;
	text-align: center;
}
.popover-state b {
	color: var(--ink);
	font-size: 13px;
}
.account-popover {
	width: 278px;
	padding: 8px;
}
.account-summary {
	display: flex;
	align-items: center;
	gap: 11px;
	padding: 10px;
	border-bottom: 1px solid var(--line);
}
.avatar-large {
	display: grid;
	width: 42px;
	height: 42px;
	place-items: center;
	flex: 0 0 auto;
}
.account-summary div {
	display: grid;
	gap: 3px;
	min-width: 0;
}
.account-summary b {
	overflow: hidden;
	font-size: 12px;
	text-overflow: ellipsis;
}
.account-summary small {
	overflow: hidden;
	color: #81867e;
	font-size: 9px;
	text-overflow: ellipsis;
}
.account-popover > button {
	display: grid;
	width: 100%;
	gap: 3px;
	padding: 11px 10px;
	border: 0;
	background: transparent;
	font-size: 11px;
	text-align: left;
}
.account-popover > button:hover {
	background: #f4f6f1;
}
.account-popover > button small {
	color: #838880;
	font-size: 9px;
}
.account-popover .logout-button {
	margin-top: 4px;
	border-top: 1px solid var(--line);
	color: #934545;
}
.menu-button-v2 {
	display: none;
	width: 40px;
	height: 40px;
}
.mobile-nav-v2 {
	top: 72px;
	grid-template-columns: repeat(2, 1fr);
	width: min(360px, calc(100vw - 24px));
	padding: 8px;
}
.mobile-nav-v2 a {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px;
}
.mobile-nav-v2 svg {
	width: 20px;
	height: 20px;
	fill: none;
	stroke: currentColor;
	stroke-linecap: round;
	stroke-linejoin: round;
	stroke-width: 1.7;
}
@media (max-width: 1320px) {
	.brand-v2 {
		min-width: 186px;
		padding: 0 13px;
	}
	.brand-name {
		font-size: 14px;
	}
	.account-copy {
		display: none;
	}
	.account-button {
		min-width: 44px;
		padding: 5px;
	}
	.main-nav-v2 a {
		min-width: 72px;
		padding: 0 8px;
		font-size: 10px;
	}
	.main-nav-v2 a svg {
		width: 25px;
		height: 25px;
	}
}
@media (max-width: 1030px) {
	.main-nav-v2 {
		display: none;
	}
	.topbar-actions-v2 {
		margin-left: auto;
	}
	.menu-button-v2 {
		display: grid;
		place-items: center;
	}
}
@media (max-width: 760px) {
	.topbar-v2 {
		height: 64px;
	}
	.brand-v2 img {
		width: 36px;
		height: 36px;
	}
	.brand-v2 strong {
		font-size: 12px;
	}
	.topbar-actions-v2 {
		padding-right: 9px;
	}
	.mobile-nav-v2 {
		top: 64px;
	}
}
</style>
