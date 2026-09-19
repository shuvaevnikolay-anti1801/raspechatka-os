import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type AtolSettings = {
  version: 2;
  enabled: boolean;
  adapter: "driver" | "web";
  taxationType: string;
  taxType: string;
  web: { baseUrl: string };
};

type ExtendedPosApi = typeof window.raspechatkaPos & {
  getAtolSettings: () => Promise<AtolSettings>;
  saveAtolSettings: (
    value: AtolSettings & { configureDevice?: boolean }
  ) => Promise<AtolSettings>;
};

const pos = () => window.raspechatkaPos as ExtendedPosApi;

const cleanRemoteMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
};

export default function AtolSetupAssistant() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [legacyWebMode, setLegacyWebMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    const locate = () => {
      const heading = Array.from(
        document.querySelectorAll<HTMLElement>(".settings-section h2")
      ).find((node) => node.textContent?.trim() === "ККТ АТОЛ");
      setTarget(heading?.closest<HTMLElement>(".settings-section") ?? null);
    };
    void pos().getAtolSettings().then((settings) => {
      setLegacyWebMode(settings.adapter === "web");
    }).catch(() => setLegacyWebMode(false));
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const configure = async () => {
    setBusy(true);
    setError(false);
    setMessage("Настраиваем АТОЛ 1Ф в Web Requests…");
    try {
      const settings = await pos().getAtolSettings();
      await pos().saveAtolSettings({
        ...settings,
        adapter: "web",
        enabled: true,
        configureDevice: true,
      });
      setMessage(
        "АТОЛ 1Ф добавлен как USB-устройство, активирован и готов к проверке."
      );
    } catch (e) {
      setError(true);
      setMessage(cleanRemoteMessage(e) || "Не удалось настроить АТОЛ 1Ф");
    } finally {
      setBusy(false);
    }
  };

  if (!target || !legacyWebMode) return null;

  return createPortal(
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: "1px solid rgba(16, 24, 40, 0.1)",
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <b>Первичная настройка Web Requests</b>
        <div style={{ marginTop: 4, opacity: 0.72, fontSize: 13 }}>
          Касса сама добавит АТОЛ 1Ф, подключённый по USB, и активирует его как
          рабочее устройство. Вход в веб-панель АТОЛ не требуется.
        </div>
      </div>
      <button
        className="primary"
        disabled={busy}
        onClick={() => void configure()}
      >
        {busy ? "Настраиваем АТОЛ…" : "Настроить АТОЛ 1Ф автоматически"}
      </button>
      {message && (
        <div
          className={error ? "settings-error" : "settings-ok"}
          style={{ marginTop: 10 }}
        >
          {message}
        </div>
      )}
    </div>,
    target
  );
}
