import { reactive } from "vue";

export const documentFilterMatches = reactive({});

export const viewDoctypes = {
  "catalog.items": "Catalog Item",
  "references.organizations": "Organization",
  "references.entities": "Business Entity",
  "references.points": "Business Point",
  "references.warehouses": "Catalog Warehouse",
  "references.clients": "Client",
  "references.suppliers": "Catalog Supplier",
  "references.employees": "Employee",
  "references.positions": "Position",
  "references.payment-methods": "Payment Method",
  "references.pos-workplaces": "POS Workplace",
  "references.cash-registers": "Cash Register",
  "references.financial-articles": "Financial Article",
  "references.catalog-groups": "Catalog Group",
  "references.catalog-units": "Catalog Unit",
  "references.price-types": "Catalog Price Type",
  "clients.base": "Client",
  "clients.segments": "Client Segment",
  "clients.campaigns": "Promo Campaign",
  "clients.promo-codes": "Promo Code",
	"clients.calendar": "Promo Occasion",
  "warehouse.receipts": "Stock Receipt",
  "warehouse.write-offs": "Stock Write Off",
  "warehouse.inventories": "Stock Inventory",
  "warehouse.purchase-orders": "Purchase Order",
  "finance.payments": "Finance Transaction",
  "finance.calendar": "Finance Plan Item",
  "finance.bank.operations": "Bank Operation",
  "sales.shifts": "Sales Shift",
  "sales.receipts": "Sales Receipt",
  "sales.returns": "Sales Receipt",
  "sales.cash": "Cash Movement",
  "sales.actions": "Cashier Action",
  "team.employees": "Employee",
};

export function setDocumentFilterMatches(viewKey, names) {
  documentFilterMatches[viewKey] = Array.isArray(names) ? names : null;
}
