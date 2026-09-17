import accessSections from "./access-pages.json" with { type: "json" };

export const accessPages = accessSections.flatMap((section) => section.pages || []);

const pageByRoute = new Map(accessPages.map((page) => [page.route, page]));

export function pageForRoute(route) {
	return pageByRoute.get(route) || null;
}

export function pageLabel(route, fallback = "") {
	return pageForRoute(route)?.label || fallback;
}

export function submenuForSection(sectionKey) {
	return (accessSections.find((section) => section.key === sectionKey)?.pages || [])
		.filter((page) => page.submenu !== false)
		.sort((left, right) => (left.order || 0) - (right.order || 0));
}
