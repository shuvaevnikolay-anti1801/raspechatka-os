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

  // Повторяем только безопасные запросы чтения: это защищает все страницы
  // от краткого сбоя при старте backend-контейнера, не дублируя сохранения.
  const attempts = requestMethod === "GET" ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, request);
      const payload = await response.json().catch(() => ({}));
      if (response.ok && !payload.exc_type) return payload.message;
      const error = new Error(payload.message || payload._server_messages || "Ошибка запроса к серверу");
      if (response.status < 500 || attempt === attempts - 1) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw lastError || new Error("Ошибка запроса к серверу");
}
