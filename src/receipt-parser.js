import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import porData from "@tesseract.js-data/por";
import { PDFParse } from "pdf-parse";
import { createWorker, OEM, PSM } from "tesseract.js";

const MAX_MEDIA_BYTES = Number(process.env.MAX_RECEIPT_BYTES || 12 * 1024 * 1024);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OCR_CACHE_PATH = process.env.OCR_CACHE_PATH || path.resolve(__dirname, "../.ocr-cache");

let ocrWorkerPromise;
let ocrQueue = Promise.resolve();

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function moneyFrom(value) {
  const source = String(value || "").replace(/[^\d.,-]/g, "");
  if (!source) return null;
  let canonical = source;
  if (source.includes(",")) canonical = source.replace(/\./g, "").replace(",", ".");
  else if ((source.match(/\./g) || []).length > 1) canonical = source.replace(/\./g, "");
  const parsed = Number(canonical);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}

function extractAmount(text) {
  const patterns = [
    /(?:valor(?:\s+(?:do|da))?\s*(?:pix|transfer[eê]ncia|transa[cç][aã]o|pagamento)?|total\s+pago)\s*[:\-]?\s*(?:r\$\s*)?([\d.]+,\d{2})/i,
    /(?:r\$\s*)([\d.]+,\d{2})/i,
    /(?:valor|total)\s*[:\-]?\s*([\d.]+\.\d{2})/i
  ];
  for (const pattern of patterns) {
    const match = String(text || "").match(pattern);
    const amount = moneyFrom(match?.[1]);
    if (amount != null) return amount;
  }
  return null;
}

function valueAfterLabel(lines, labels) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const label of labels) {
      const expression = new RegExp(`^${label}\\s*[:\\-]?\\s*(.*)$`, "i");
      const match = line.match(expression);
      if (!match) continue;
      const inline = cleanText(match[1]);
      if (inline && inline.length > 2) return inline.slice(0, 120);
      const next = cleanText(lines[index + 1]);
      if (next && next.length > 2) return next.slice(0, 120);
    }
  }
  return null;
}

function detectBank(text) {
  const banks = [
    ["Nubank", /nubank|nu pagamentos/i],
    ["Itaú", /ita[uú]/i],
    ["Bradesco", /bradesco/i],
    ["Banco do Brasil", /banco do brasil/i],
    ["Caixa", /caixa econ[oô]mica|\bcaixa\b/i],
    ["Santander", /santander/i],
    ["Inter", /banco inter|inter pagamentos/i],
    ["Mercado Pago", /mercado pago/i],
    ["PagBank", /pagbank|pagseguro/i],
    ["C6 Bank", /c6 bank/i],
    ["PicPay", /picpay/i],
    ["Stone", /stone/i]
  ];
  return banks.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function transactionId(text) {
  const e2e = String(text || "").match(/\bE\d{31}\b/i)?.[0];
  if (e2e) return e2e.toUpperCase();
  const labeled = String(text || "").match(/(?:id(?:entificador)?\s+(?:da\s+)?(?:transa[cç][aã]o|transfer[eê]ncia|pix)|c[oó]digo\s+da\s+transa[cç][aã]o)\s*[:\-]?\s*([A-Z0-9-]{12,})/i)?.[1];
  return labeled || null;
}

function receiptDate(text) {
  const match = String(text || "").match(/\b(\d{2}[/-]\d{2}[/-]\d{2,4})(?:\s+(?:[aà]s\s*)?(\d{1,2}:\d{2}(?::\d{2})?))?/i);
  return match ? `${match[1]}${match[2] ? ` ${match[2]}` : ""}` : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function ocrWorker() {
  if (!ocrWorkerPromise) {
    const options = {
      langPath: porData.langPath,
      gzip: porData.gzip,
      cachePath: OCR_CACHE_PATH
    };
    if (process.env.OCR_LOG === "true") {
      options.logger = (progress) => console.log("[ocr]", progress.status, progress.progress ?? "");
    }
    ocrWorkerPromise = createWorker(porData.code, OEM.LSTM_ONLY, options).then(async (worker) => {
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: "1"
      });
      return worker;
    });
  }
  return ocrWorkerPromise;
}

async function recognizeImage(buffer) {
  const task = ocrQueue.then(async () => {
    const worker = await ocrWorker();
    const result = await worker.recognize(buffer);
    return cleanText(result.data?.text);
  });
  ocrQueue = task.catch(() => {});
  return task;
}

export async function terminateOcr() {
  if (!ocrWorkerPromise) return;
  const worker = await ocrWorkerPromise.catch(() => null);
  await worker?.terminate().catch(() => {});
  ocrWorkerPromise = null;
}

export async function extractReceiptContent({ buffer, mimeType, fileName }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Comprovante vazio");
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error(`Comprovante maior que ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB`);

  const mime = normalized(mimeType);
  const extension = path.extname(String(fileName || "")).toLowerCase();
  let text = "";
  let source;

  if (mime.includes("pdf") || extension === ".pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      text = cleanText(parsed?.text);
    } finally {
      await parser.destroy();
    }
    source = "pdf";
  } else if (/^image\/(?:jpeg|jpg|png)$/.test(mime) || [".jpg", ".jpeg", ".png"].includes(extension)) {
    text = await recognizeImage(buffer);
    source = "image-ocr";
  } else {
    throw new Error("Formato não aceito. Envie PDF, JPG ou PNG");
  }

  return {
    text,
    source,
    sha256: sha256(buffer),
    byteLength: buffer.length
  };
}

export function parseReceiptText(text) {
  const cleaned = cleanText(text);
  const folded = normalized(cleaned);
  const lines = cleaned.split(/\n+/).map((line) => cleanText(line)).filter(Boolean);
  const id = transactionId(cleaned);
  const amount = extractAmount(cleaned);
  const saysCompleted = /(?:conclu[ií]d[oa]|efetivad[oa]|realizad[oa]|transa[cç][aã]o\s+feita|pix\s+enviado|pagamento\s+feito|sucesso)/i.test(cleaned)
    && !/(?:cancelad[oa]|falhou|n[aã]o\s+conclu[ií]d[oa]|agendad[oa]|processando)/i.test(cleaned);
  const suspiciousStatus = /(?:cancelad[oa]|falhou|n[aã]o\s+conclu[ií]d[oa]|agendad[oa]|processando)/i.test(cleaned);
  const isPix = /\bpix\b|transfer[eê]ncia\s+instant[aâ]nea/i.test(cleaned);
  const payerName = valueAfterLabel(lines, ["nome do pagador", "pagador", "quem pagou", "origem"]);
  const receiverName = valueAfterLabel(lines, ["nome do recebedor", "recebedor", "destinat[aá]rio", "favorecido", "para"]);

  let score = 0;
  if (amount != null) score += 30;
  if (id) score += 30;
  if (receiptDate(cleaned)) score += 10;
  if (saysCompleted) score += 20;
  if (isPix || /comprovante|transfer[eê]ncia/i.test(cleaned)) score += 10;
  const confidence = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  return {
    amount,
    bank: detectBank(cleaned),
    transactionHash: id ? sha256(normalized(id)) : null,
    transactionSuffix: id ? id.slice(-8) : null,
    transactionDate: receiptDate(cleaned),
    payerName,
    receiverName,
    saysCompleted,
    suspiciousStatus,
    isPix,
    confidence,
    textLength: cleaned.length,
    textFingerprint: cleaned ? sha256(folded) : null
  };
}

function cleanClientName(value) {
  return cleanText(value)
    .replace(/\b(?:rp|l)\s*[1-5]\b/ig, "")
    .replace(/\b(?:pagou|pago|juros?|quita[cç][aã]o|quitou|comprovante|pix|liberad[oa]|venda|novo|renova[cç][aã]o)\b.*$/i, "")
    .replace(/^[\s:|\-–—]+|[\s:|\-–—]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, 100);
}

function extractClientName(caption) {
  const direct = String(caption || "").match(/(?:cliente|nome)\s*[:\-]\s*([^\n|]+)/i)?.[1];
  if (direct) return cleanClientName(direct);
  const beforeVerb = String(caption || "").match(/^\s*([^\n|]{3,100}?)\s+(?:pagou|quitou|fez\s+o\s+pix|liberad[oa])/i)?.[1];
  if (beforeVerb) return cleanClientName(beforeVerb);
  const firstSegment = String(caption || "").split(/[\n|]/).map(cleanClientName).find((part) => part.length >= 3 && /[a-zá-ú]/i.test(part));
  return firstSegment || null;
}

export function parseCaption(caption, kind) {
  const text = cleanText(caption);
  const folded = normalized(text);
  let classification = "unknown";
  if (kind === "outgoing") classification = "sale";
  else if (/quita[cç][aã]o|quitou|liquidou|saldo\s+total/.test(folded)) classification = "settlement";
  else if (/juros?|parcela|pagou/.test(folded)) classification = "interest";
  const lineNumber = folded.match(/\b(?:rp|l)\s*([1-5])\b/)?.[1];
  return {
    caption: text,
    clientName: extractClientName(text),
    classification,
    line: lineNumber ? `RP${lineNumber}` : null,
    amount: extractAmount(text)
  };
}

export function moneyMismatch(first, second) {
  if (first == null || second == null) return false;
  return Math.round(Number(first) * 100) !== Math.round(Number(second) * 100);
}

export function mediaSizeLimit() {
  return MAX_MEDIA_BYTES;
}
