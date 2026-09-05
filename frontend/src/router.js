import { createRouter, createWebHistory } from "vue-router";
import DashboardPage from "./pages/DashboardPage.vue";
import CatalogPage from "./pages/CatalogPage.vue";
import ModulePlaceholder from "./pages/ModulePlaceholder.vue";
import ReferencesPage from "./pages/ReferencesPage.vue";
import MasterDataPage from "./pages/MasterDataPage.vue";
import AccessSettingsPage from "./pages/AccessSettingsPage.vue";
import WarehouseReceiptsPage from "./pages/WarehouseReceiptsPage.vue";
import WarehouseDocumentsPage from "./pages/WarehouseDocumentsPage.vue";
import WarehouseReportPage from "./pages/WarehouseReportPage.vue";

const routes = [
  { path: "/", name: "dashboard", component: DashboardPage, meta: { module: "dashboard" } },
  { path: "/catalog", name: "catalog", component: CatalogPage, meta: { module: "catalog" } },
  { path: "/catalog/groups", name: "catalog-groups", component: MasterDataPage, meta: { module: "catalog", reference: "catalog-groups" } },
  { path: "/catalog/units", name: "catalog-units", component: MasterDataPage, meta: { module: "catalog", reference: "catalog-units" } },
  { path: "/catalog/price-types", name: "catalog-price-types", component: MasterDataPage, meta: { module: "catalog", reference: "price-types" } },
  { path: "/references/:reference(entities|points|warehouses)", name: "references", component: ReferencesPage, meta: { module: "references" } },
  { path: "/references/:reference(organizations|clients|suppliers|employees|positions|catalog-groups|catalog-units|price-types|payment-methods|pos-workplaces|cash-registers|financial-articles)", name: "master-data", component: MasterDataPage, meta: { module: "references" } },
  { path: "/settings/access", name: "access-settings", component: AccessSettingsPage, meta: { module: "references" } },
  { path: "/warehouse", redirect: "/warehouse/receipts" },
  { path: "/warehouse/receipts", name: "warehouse-receipts", component: WarehouseReceiptsPage, meta: { module: "warehouse" } },
  { path: "/warehouse/write-offs", name: "warehouse-write-offs", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "write-offs" } },
  { path: "/warehouse/inventories", name: "warehouse-inventories", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "inventories" } },
  { path: "/warehouse/purchase-orders", name: "warehouse-purchase-orders", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "purchase-orders" } },
  { path: "/warehouse/balances", name: "warehouse-balances", component: WarehouseReportPage, meta: { module: "warehouse", report: "balances" } },
  { path: "/warehouse/turnover", name: "warehouse-turnover", component: WarehouseReportPage, meta: { module: "warehouse", report: "turnover" } },
  { path: "/:module(orders|clients|team|finance|analytics)", name: "module", component: ModulePlaceholder },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export default createRouter({
  history: createWebHistory("/raspechatka"),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
