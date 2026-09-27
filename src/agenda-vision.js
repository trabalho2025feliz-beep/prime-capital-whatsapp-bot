import { createHash } from "node:crypto";

const DEFAULT_MODEL = process.env.AGENDA_VISION_MODEL || "gpt-4o-mini";
const DEFAULT_ENDPOINT = process.env.OPENAI_API_URL || "https://api.openai.com/v1/responses";
const MAX_AGENDA_BYTES = Number(process.env.MAX_AGENDA_BYTES || 10 * 1024 * 1024);

const ATTENDANTS = {
  RP1: "Luísa",
  RP2: "Carla",
  RP3: "Isabel",
  RP4: "Márcia",
  RP5: "Ingrid"
};

const AGENDA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    page_date: { type: ["string", "null"] },
    entries: {
      type: "array",
      maxItems: 60,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          time: { type: ["string", "null"] },
          client_name: { type: "string" },
          client_code: { type: ["string", "null"] },
          expected_amount: { type: ["number", "null"] },
          installment: { type: ["string", "null"] },
          highlight: { type: "string", enum: ["green", "orange", "yellow", "none", "unknown"] },
          notes: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["time", "client_name", "client_code", "expected_amount", "installment", "highlight", "notes", "confidence"]
      }
    },
    uncertain_notes: { type: "array", items: { type: "string" }, maxItems: 20 }
  },
  required: ["page_date", "entries", "uncertain_notes"]
};

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function clean(value, max = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function lineFromText(value) {
  const folded = normalize(value);
  const direct = folded.match(/\b(?:rp|l)\s*([1-5])\b/)?.[1];
  if (direct) return `RP${direct}`;
  const byName = Object.entries(ATTENDANTS).find(([, name]) => folded.includes(normalize(name)));
  return byName?.[0] || null;
}

function dateKey(value) {
  const match = String(value || "").match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const month = match[2].padStart(2, "0");
  const day = match[1].padStart(2, "0");
  const candidate = `${year}-${month}-${day}`;
  const parsed = new Date(`${candidate}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

export function parseAgendaCaption(caption) {
  const text = clean(caption, 500);
  const line = lineFromText(text);
  return {
    caption: text,
    line,
    attendant: line ? ATTENDANTS[line] : null,
    dateKey: dateKey(text)
  };
}

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function sanitizeResult(result) {
  const allowedHighlights = new Set(["green", "orange", "yellow", "none", "unknown"]);
  const allowedConfidence = new Set(["high", "medium", "low"]);
  const entries = Array.isArray(result?.entries) ? result.entries.slice(0, 60) : [];
  return {
    pageDate: clean(result?.page_date, 30) || null,
    entries: entries
      .map((entry) => ({
        time: clean(entry?.time, 12) || null,
        clientName: clean(entry?.client_name, 100),
        clientCode: clean(entry?.client_code, 40) || null,
        expectedAmount: money(entry?.expected_amount),
        installment: clean(entry?.installment, 30) || null,
        highlight: allowedHighlights.has(entry?.highlight) ? entry.highlight : "unknown",
        notes: clean(entry?.notes, 240),
        confidence: allowedConfidence.has(entry?.confidence) ? entry.confidence : "low"
      }))
      .filter((entry) => entry.clientName.length >= 2),
    uncertainNotes: (Array.isArray(result?.uncertain_notes) ? result.uncertain_notes : [])
      .map((note) => clean(note, 240))
      .filter(Boolean)
      .slice(0, 20)
  };
}

export async function extractAgendaFromImage({
  buffer,
  mimeType = "image/jpeg",
  caption = "",
  apiKey = process.env.OPENAI_API_KEY,
  model = DEFAULT_MODEL,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Foto da agenda vazia");
  if (buffer.length > MAX_AGENDA_BYTES) {
    throw new Error(`Foto maior que ${Math.round(MAX_AGENDA_BYTES / 1024 / 1024)} MB`);
  }
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY ausente; a leitura de escrita à mão ainda não está ativada");
  }

  const prompt = [
    "Transcreva esta agenda manuscrita da Prime Capital para JSON.",
    "Cada linha preenchida representa um cliente. Extraia horário, nome, código escrito depois do nome, valor esperado, parcela/anotação final, cor do marca-texto e observações manuscritas próximas.",
    "Ignore horários impressos que não tenham cliente. Não invente letras ou números ilegíveis: use null, texto vazio e confidence=low.",
    "Valores estão em reais brasileiros; converta 300,00 para 300. Preserve códigos como texto.",
    "As cores não alteram o valor; apenas registre green, orange, yellow, none ou unknown.",
    `Legenda enviada pela atendente: ${caption || "sem legenda"}`
  ].join("\n");

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:${mimeType};base64,${buffer.toString("base64")}`, detail: "high" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "agenda_prime_capital",
          strict: true,
          schema: AGENDA_SCHEMA
        }
      }
    }),
    signal: AbortSignal.timeout(90_000)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = clean(payload?.error?.message, 240) || `HTTP ${response.status}`;
    throw new Error(`A visão não conseguiu ler a agenda: ${reason}`);
  }
  const text = responseText(payload);
  if (!text) throw new Error("A visão não devolveu os dados da agenda");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("A visão devolveu uma resposta incompleta; envie uma foto mais nítida");
  }
  const result = sanitizeResult(parsed);
  if (!result.entries.length) throw new Error("Nenhum cliente foi reconhecido; fotografe a página inteira, de cima e com boa luz");
  return {
    ...result,
    model,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteLength: buffer.length
  };
}

export function agendaMediaSizeLimit() {
  return MAX_AGENDA_BYTES;
}

export { ATTENDANTS };
