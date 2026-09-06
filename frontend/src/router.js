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
import ClientsPage from "./pages/ClientsPage.vue";
import ClientClubPage from "./pages/ClientClubPage.vue";
import ClientMarketingPage from "./pages/ClientMarketingPage.vue";
import FinancePaymentsPage from "./pages/FinancePaymentsPage.vue";
import FinanceCalendarPage from "./pages/FinanceCalendarPage.vue";
import FinanceReportPage from "./pages/FinanceReportPage.vue";
import FinancePlanningPage from "./pages/FinancePlanningPage.vue";
import FinanceBankPage from "./pages/FinanceBankPage.vue";
import SalesPage from "./pages/SalesPage.vue";

const routes = [
  { path: "/", name: "dashboard", component: DashboardPage, meta: { module: "dashboard" } },
  { path: "/catalog", name: "catalog", component: CatalogPage, meta: { module: "catalog" } },
  { path: "/catalog/groups", name: "catalog-groups", component: MasterDataPage, meta: { module: "catalog", reference: "catalog-groups" } },
  { path: "/catalog/units", name: "catalog-units", component: MasterDataPage, meta: { module: "catalog", reference: "catalog-units" } },
  { path: "/catalog/price-types", name: "catalog-price-types", component: MasterDataPage, meta: { module: "catalog", reference: "price-types" } },
  { path: "/references/:reference(entities|points|warehouses)", name: "references", component: ReferencesPage, meta: { module: "references" } },
  { path: "/references/clients", redirect: "/clients" },
  { path: "/references/:reference(organizations|suppliers|employees|positions|catalog-groups|catalog-units|price-types|payment-methods|pos-workplaces|cash-registers|financial-articles)", name: "master-data", component: MasterDataPage, meta: { module: "references" } },
  { path: "/settings/access", name: "access-settings", component: AccessSettingsPage, meta: { module: "references" } },
  { path: "/warehouse", redirect: "/warehouse/receipts" },
  { path: "/warehouse/receipts", name: "warehouse-receipts", component: WarehouseReceiptsPage, meta: { module: "warehouse" } },
  { path: "/warehouse/write-offs", name: "warehouse-write-offs", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "write-offs" } },
  { path: "/warehouse/inventories", name: "warehouse-inventories", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "inventories" } },
  { path: "/warehouse/purchase-orders", name: "warehouse-purchase-orders", component: WarehouseDocumentsPage, meta: { module: "warehouse", kind: "purchase-orders" } },
  { path: "/warehouse/balances", name: "warehouse-balances", component: WarehouseReportPage, meta: { module: "warehouse", report: "balances" } },
  { path: "/warehouse/turnover", name: "warehouse-turnover", component: WarehouseReportPage, meta: { module: "warehouse", report: "turnover" } },
  { path: "/clients", name: "clients", component: ClientsPage, meta: { module: "clients" } },
  { path: "/clients/club", name: "client-club", component: ClientClubPage, meta: { module: "clients" } },
  { path: "/clients/segments", name: "client-segments", component: ClientMarketingPage, meta: { module: "clients", kind: "segments" } },
  { path: "/clients/campaigns", name: "client-campaigns", component: ClientMarketingPage, meta: { module: "clients", kind: "campaigns" } },
  { path: "/clients/promo-codes", name: "client-promo-codes", component: ClientMarketingPage, meta: { module: "clients", kind: "promo-codes" } },
  { path: "/clients/calendar", name: "client-calendar", component: ClientMarketingPage, meta: { module: "clients", kind: "calendar" } },
  { path: "/finance", name: "finance-overview", component: FinanceReportPage, meta: { module: "finance", kind: "overview" } },
  { path: "/finance/payments", name: "finance-payments", component: FinancePaymentsPage, meta: { module: "finance" } },
  { path: "/finance/calendar", name: "finance-calendar", component: FinanceCalendarPage, meta: { module: "finance" } },
  { path: "/finance/report", name: "finance-report", component: FinanceReportPage, meta: { module: "finance", kind: "report" } },
  { path: "/finance/planning", name: "finance-planning", component: FinancePlanningPage, meta: { module: "finance" } },
  { path: "/finance/settlements", name: "finance-settlements", component: FinanceReportPage, meta: { module: "finance", kind: "settlements" } },
  { path: "/finance/profitability", name: "finance-profitability", component: FinanceReportPage, meta: { module: "finance", kind: "profitability" } },
  { path: "/finance/tochka", name: "finance-tochka", component: FinanceBankPage, meta: { module: "finance" } },
  { path: "/sales", name: "sales-overview", component: SalesPage, meta: { module: "sales", kind: "overview" } },
  { path: "/sales/shifts", name: "sales-shifts", component: SalesPage, meta: { module: "sales", kind: "shifts" } },
  { path: "/sales/receipts", name: "sales-receipts", component: SalesPage, meta: { module: "sales", kind: "receipts" } },
  { path: "/sales/returns", name: "sales-returns", component: SalesPage, meta: { module: "sales", kind: "returns" } },
  { path: "/sales/cash", name: "sales-cash", component: SalesPage, meta: { module: "sales", kind: "cash" } },
  { path: "/sales/actions", name: "sales-actions", component: SalesPage, meta: { module: "sales", kind: "actions" } },
  { path: "/sales/integration", name: "sales-integration", component: SalesPage, meta: { module: "sales", kind: "integration" } },
  { path: "/:module(team|analytics)", name: "module", component: ModulePlaceholder },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export default createRouter({
  history: createWebHistory("/raspechatka"),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});
