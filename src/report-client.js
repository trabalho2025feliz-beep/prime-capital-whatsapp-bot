const MODES = new Set(["full", "summary", "lines", "alerts"]);

function cleanText(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchReport(mode) {
  if (!MODES.has(mode)) throw new Error("Tipo de relatório inválido");

  const baseUrl = process.env.REPORT_API_URL;
  const secret = process.env.REPORT_API_SECRET;
  if (!baseUrl || !secret) {
    throw new Error("REPORT_API_URL ou REPORT_API_SECRET ausente");
  }

  const url = new URL(baseUrl);
  url.searchParams.set("mode", mode);

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${secret}`,
      "user-agent": "PrimeCapitalWhatsAppBot/1.0"
    },
    signal: AbortSignal.timeout(90_000)
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Servidor de relatórios respondeu ${response.status}`);
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Servidor de relatórios respondeu ${response.status}`);
  }

  const text = cleanText(data?.text);
  if (!text) throw new Error("Relatório veio vazio");
  return text;
}

