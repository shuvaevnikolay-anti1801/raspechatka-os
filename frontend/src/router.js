import { createRouter, createWebHistory } from "vue-router";
import { canAccess } from "./api";
import accessSections from "./access-pages.json";
import DashboardPage from "./pages/DashboardPage.vue";
import CatalogPage from "./pages/CatalogPage.vue";
import ReferencesPage from "./pages/ReferencesPage.vue";
import MasterDataPage from "./pages/MasterDataPage.vue";
import AccessSettingsPage from "./pages/AccessSettingsPage.vue";
import MoySkladIntegrationPage from "./pages/MoySkladIntegrationPage.vue";
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
import FinanceBankSettingsPage from "./pages/FinanceBankSettingsPage.vue";
import FinanceSettingsPage from "./pages/FinanceSettingsPage.vue";
import SalesPage from "./pages/SalesPage.vue";
import TeamPage from "./pages/TeamPage.vue";
import UsersPage from "./pages/UsersPage.vue";

const routes = [
  { path: "/", name: "dashboard", component: DashboardPage, meta: { module: "dashboard" } },
  { path: "/catalog", name: "catalog", component: CatalogPage, meta: { module: "catalog" } },
  { path: "/catalog/groups", redirect: "/catalog" },
  { path: "/catalog/units", name: "catalog-units", component: MasterDataPage, meta: { module: "catalog", reference: "catalog-units" } },
  { path: "/catalog/price-types", name: "catalog-price-types", component: MasterDataPage, meta: { module: "catalog", reference: "price-types" } },
  { path: "/references/:reference(entities|points|warehouses)", name: "references", component: ReferencesPage, meta: { module: "references" } },
  { path: "/references/clients", redirect: "/clients" },
  { path: "/references/employees", redirect: "/team/employees" },
  { path: "/references/positions", redirect: "/team/positions" },
  { path: "/references/users", name: "users", component: UsersPage, meta: { module: "references" } },
  { path: "/references/:reference(organizations|suppliers|catalog-groups|catalog-units|price-types|payment-methods|pos-workplaces|cash-registers)", name: "master-data", component: MasterDataPage, meta: { module: "references" } },
  { path: "/settings/access", name: "access-settings", component: AccessSettingsPage, meta: { module: "references" } },
  { path: "/settings/moysklad", name: "moysklad-settings", component: MoySkladIntegrationPage, meta: { module: "references" } },
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
  { path: "/finance/tochka", redirect: "/finance/settings/tochka" },
  { path: "/finance/settings/tochka", name: "finance-bank-settings", component: FinanceBankSettingsPage, meta: { module: "finance" } },
  { path: "/finance/settings", name: "finance-settings", component: FinanceSettingsPage, meta: { module: "finance" } },
  { path: "/references/financial-articles", redirect: "/finance/settings" },
  { path: "/sales", name: "sales-overview", component: SalesPage, meta: { module: "sales", kind: "overview" } },
  { path: "/sales/shifts", name: "sales-shifts", component: SalesPage, meta: { module: "sales", kind: "shifts" } },
  { path: "/sales/receipts", name: "sales-receipts", component: SalesPage, meta: { module: "sales", kind: "receipts" } },
  { path: "/sales/returns", name: "sales-returns", component: SalesPage, meta: { module: "sales", kind: "returns" } },
  { path: "/sales/cash", name: "sales-cash", component: SalesPage, meta: { module: "sales", kind: "cash" } },
  { path: "/sales/actions", name: "sales-actions", component: SalesPage, meta: { module: "sales", kind: "actions" } },
  { path: "/sales/integration", name: "sales-integration", component: SalesPage, meta: { module: "sales", kind: "integration" } },
  { path: "/team", redirect: "/team/employees" },
  { path: "/team/employees", name: "team-employees", component: MasterDataPage, meta: { module: "team", reference: "employees" } },
  { path: "/team/positions", name: "team-positions", component: MasterDataPage, meta: { module: "team", reference: "positions" } },
  { path: "/team/schedule", name: "team-schedule", component: TeamPage, meta: { module: "team", section: "schedule" } },
  { path: "/team/payroll", name: "team-payroll", component: TeamPage, meta: { module: "team", section: "payroll" } },
  { path: "/team/bonuses", name: "team-bonuses", component: TeamPage, meta: { module: "team", section: "bonuses" } },
  { path: "/team/hr", name: "team-hr", component: TeamPage, meta: { module: "team", section: "hr" } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

const router = createRouter({
	history: createWebHistory("/raspechatka"),
	routes,
	scrollBehavior: () => ({ top: 0 }),
});

const accessPages = accessSections.flatMap((section) => section.pages || []);
const accessPageByRoute = new Map(accessPages.map((page) => [page.route, page]));

router.beforeEach((to) => {
	const page = accessPageByRoute.get(to.path);
	if (!page || canAccess(page.area, page.minimum || "View")) return true;
	const firstAvailable = accessPages.find((item) =>
		canAccess(item.area, item.minimum || "View")
	);
	return firstAvailable && firstAvailable.route !== to.path ? firstAvailable.route : false;
});

export default router;
