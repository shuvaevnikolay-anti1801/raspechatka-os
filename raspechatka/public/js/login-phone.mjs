export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8"))
    digits = `7${digits.slice(1)}`;
  return digits.length === 11 && digits.startsWith("7") ? `+${digits}` : "";
}

export function formatPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (!digits.startsWith("7")) digits = `7${digits}`;
  digits = digits.slice(0, 11);
  const national = digits.slice(1);
  let formatted = "+7";
  if (national.length) formatted += ` (${national.slice(0, 3)}`;
  if (national.length >= 3) formatted += ")";
  if (national.length > 3) formatted += ` ${national.slice(3, 6)}`;
  if (national.length > 6) formatted += `-${national.slice(6, 8)}`;
  if (national.length > 8) formatted += `-${national.slice(8, 10)}`;
  return formatted;
}

window.RaspechatkaLoginPhone = { normalizePhone, formatPhone };
