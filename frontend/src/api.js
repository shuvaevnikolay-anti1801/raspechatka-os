const boot = window.raspechatkaBoot || {
  user: "Administrator",
  full_name: "Administrator",
  roles: ["System Manager"],
  is_manager: true,
  csrf_token: "",
};

export { boot };

const accessLevels = { None: 0, View: 1, Edit: 2, Admin: 3 };
export function canAccess(area, minimum = "View") {
  return (accessLevels[boot.access?.[area] || "None"] || 0) >= accessLevels[minimum];
}

export async function call(method, params = {}, options = {}) {
  const requestMethod = options.method || "GET";
  const url = new URL(`/api/method/${method}`, window.location.origin);
  const request = {
    method: requestMethod,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": boot.csrf_token || "",
    },
  };

  if (requestMethod === "GET") {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });
  } else {
    request.body = JSON.stringify(params);
  }

  const response = await fetch(url, request);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.exc_type) {
    throw new Error(payload.message || payload._server_messages || "Ошибка запроса к серверу");
  }
  return payload.message;
}
