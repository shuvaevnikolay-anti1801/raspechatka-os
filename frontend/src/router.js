import { createRouter, createWebHistory } from "vue-router";
import DashboardPage from "./pages/DashboardPage.vue";
import CatalogPage from "./pages/CatalogPage.vue";
import ModulePlaceholder from "./pages/ModulePlaceholder.vue";

const routes = [
  { path: "/", name: "dashboard", component: DashboardPage, meta: { module: "dashboard" } },
  { path: "/catalog", name: "catalog", component: CatalogPage, meta: { module: "catalog" } },
  { path: "/:module(orders|clients|warehouse|team|finance|analytics)", name: "module", component: ModulePlaceholder },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export default createRouter({
  history: createWebHistory("/raspechatka"),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
