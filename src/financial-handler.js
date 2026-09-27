import { downloadMediaMessage } from "@whiskeysockets/baileys";
import {
  extractReceiptContent,
  mediaSizeLimit,
  moneyMismatch,
  parseCaption,
  parseReceiptText
} from "./receipt-parser.js";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const CONTEXT_TTL_MS = 10 * 60 * 1000;

function unwrapContent(message) {
  let content = message?.message || {};
  for (let depth = 0; depth < 6; depth += 1) {
    const wrapped = content.ephemeralMessage?.message
      || content.viewOnceMessage?.message
      || content.viewOnceMessageV2?.message
      || content.viewOnceMessageV2Extension?.message
      || content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  return content;
}

export function textFromMessage(message) {
  const content = unwrapContent(message);
  return String(
    content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.documentMessage?.caption
    || content.videoMessage?.caption
    || ""
  ).trim();
}

function quotedText(content) {
  const context = content.imageMessage?.contextInfo
    || content.documentMessage?.contextInfo
    || content.extendedTextMessage?.contextInfo;
  if (!context?.quotedMessage) return "";
  return textFromMessage({ message: context.quotedMessage });
}

function mediaFromMessage(message) {
  const content = unwrapContent(message);
  if (content.documentMessage) {
    const mimeType = content.documentMessage.mimetype || "application/octet-stream";
    return {
      node: content.documentMessage,
      kind: "document",
      mimeType,
      fileName: content.documentMessage.fileName || (mimeType.includes("pdf") ? "comprovante.pdf" : mimeType.startsWith("image/") ? "comprovante.jpg" : "comprovante"),
      caption: content.documentMessage.caption || "",
      quoted: quotedText(content)
    };
  }
  if (content.imageMessage) {
    return {
      node: content.imageMessage,
      kind: "image",
      mimeType: content.imageMessage.mimetype || "image/jpeg",
      fileName: content.imageMessage.fileName || "comprovante.jpg",
      caption: content.imageMessage.caption || "",
      quoted: quotedText(content)
    };
  }
  return null;
}

function numberFromJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function messageDate(message) {
  const raw = message?.messageTimestamp;
  const seconds = typeof raw?.toNumber === "function" ? raw.toNumber() : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

function fileLength(node) {
  const raw = node?.fileLength;
  const value = typeof raw?.toNumber === "function" ? raw.toNumber() : Number(raw?.toString?.() || raw);
  return Number.isFinite(value) ? value : 0;
}

function allowedMedia(media) {
  const mime = String(media.mimeType || "").toLowerCase();
  return mime.includes("pdf") || /^image\/(?:jpeg|jpg|png)$/.test(mime) || /\.(pdf|jpe?g|png)$/i.test(media.fileName || "");
}

function entryReply(entry, duplicate, agendaMatch) {
  if (duplicate) {
    return [
      "♻️ *COMPROVANTE REPETIDO*",
      `Este arquivo já foi registrado em *${duplicate.id}*.`,
      "Ele não foi somado novamente."
    ].join("\n");
  }

  const incoming = entry.kind === "incoming";
  const type = entry.classification === "settlement" ? "QUITAÇÃO"
    : entry.classification === "interest" ? "JUROS"
      : entry.classification === "sale" ? "LIBERAÇÃO/VENDA" : "NÃO INFORMADO";
  const heading = entry.status === "needs_review" ? "⚠️ *COMPROVANTE PRECISA DE REVISÃO*" : "✅ *COMPROVANTE LIDO*";
  const lines = [
    heading,
    `Código: *${entry.id}*`,
    `Movimento: ${incoming ? "ENTRADA" : "SAÍDA"}`,
    `Cliente: ${entry.clientName || "não identificado"}`,
    `Tipo: ${type}`,
    `Valor: ${entry.amount != null ? money.format(entry.amount) : "não identificado"}`
  ];
  if (entry.line) lines.push(`Linha: ${entry.line}`);
  if (entry.receipt?.bank) lines.push(`Banco: ${entry.receipt.bank}`);
  if (entry.receipt?.transactionSuffix) lines.push(`Transação final: ${entry.receipt.transactionSuffix}`);
  if (entry.warnings?.length) lines.push("", ...entry.warnings.map((warning) => `• ${warning}`));
  if (agendaMatch) {
    lines.push(
      "",
      `📅 Agenda cruzada: *${agendaMatch.agendaId}*`,
      `Cliente previsto: ${agendaMatch.clientName}`,
      `Situação na agenda: ${agendaMatch.status === "settled" ? "QUITADO"
        : agendaMatch.status === "paid" ? "PAGO CONFIRMADO"
          : agendaMatch.status === "receipt_review" ? "COMPROVANTE EM REVISÃO" : "COMPROVANTE CRUZADO"}`
    );
  }
  lines.push("", entry.status === "needs_review"
    ? "Confira o comprovante antes de considerar o valor recebido."
    : "📄 Leitura concluída. A confirmação bancária é uma etapa separada.");
  return lines.join("\n");
}

function contextKey(message) {
  return `${message.key.remoteJid}|${message.key.participant || message.participant || "sem-remetente"}`;
}

export function createFinancialHandler({ ledger, agendaLedger, logger, getSocket, sendText }) {
  const pendingContext = new Map();

  function rememberContext(message, text) {
    if (!text || text.startsWith("/")) return;
    const metadata = parseCaption(text, "incoming");
    if (!metadata.clientName && metadata.classification === "unknown") return;
    pendingContext.set(contextKey(message), { text, createdAt: Date.now() });
  }

  function consumeContext(message) {
    const key = contextKey(message);
    const stored = pendingContext.get(key);
    if (!stored) return "";
    pendingContext.delete(key);
    return Date.now() - stored.createdAt <= CONTEXT_TTL_MS ? stored.text : "";
  }

  async function handle(message, { kind, groupName }) {
    const jid = message.key.remoteJid;
    const text = textFromMessage(message);
    const media = mediaFromMessage(message);

    if (!media) {
      rememberContext(message, text);
      return { handled: false, contextStored: Boolean(text) };
    }

    if (!allowedMedia(media)) {
      await sendText(jid, "⚠️ Formato não aceito. Envie o comprovante em PDF, JPG ou PNG.");
      return { handled: true };
    }

    const declaredSize = fileLength(media.node);
    if (declaredSize > mediaSizeLimit()) {
      await sendText(jid, `⚠️ O comprovante é maior que ${Math.round(mediaSizeLimit() / 1024 / 1024)} MB.`);
      return { handled: true };
    }

    const caption = String(media.caption || text || media.quoted || consumeContext(message) || "").trim();
    const socket = getSocket();
    const buffer = await downloadMediaMessage(message, "buffer", {}, {
      logger,
      reuploadRequest: socket.updateMediaMessage
    });
    const content = await extractReceiptContent({
      buffer,
      mimeType: media.mimeType,
      fileName: media.fileName
    });
    const captionData = parseCaption(caption, kind);
    const receiptData = parseReceiptText(content.text);
    const warnings = [];

    if (!captionData.clientName) warnings.push("Nome do cliente não informado na legenda.");
    if (kind === "incoming" && captionData.classification === "unknown") warnings.push("Informe se é JUROS ou QUITAÇÃO.");
    if (!content.text || content.text.length < 25) warnings.push("Não foi possível ler texto suficiente no comprovante.");
    if (receiptData.amount == null) warnings.push("Valor não identificado no comprovante.");
    if (moneyMismatch(captionData.amount, receiptData.amount)) warnings.push("O valor da legenda é diferente do valor do comprovante.");
    if (receiptData.suspiciousStatus) warnings.push("O comprovante indica operação agendada, cancelada ou não concluída.");
    else if (!receiptData.saysCompleted) warnings.push("O PDF não mostra claramente que a operação foi concluída.");
    if (receiptData.confidence === "low") warnings.push("Poucos dados bancários foram reconhecidos; revise manualmente.");

    const createdAt = messageDate(message).toISOString();
    const result = await ledger.add({
      kind,
      createdAt,
      groupJid: jid,
      groupName,
      messageId: message.key.id,
      sender: numberFromJid(message.key.participant || message.participant),
      clientName: captionData.clientName,
      line: captionData.line,
      classification: captionData.classification,
      amount: receiptData.amount ?? captionData.amount,
      captionAmount: captionData.amount,
      status: warnings.length ? "needs_review" : "receipt_read",
      warnings,
      receipt: {
        sha256: content.sha256,
        source: content.source,
        fileName: media.fileName,
        mimeType: media.mimeType,
        byteLength: content.byteLength,
        bank: receiptData.bank,
        transactionHash: receiptData.transactionHash,
        transactionSuffix: receiptData.transactionSuffix,
        transactionDate: receiptData.transactionDate,
        payerName: receiptData.payerName,
        receiverName: receiptData.receiverName,
        saysCompleted: receiptData.saysCompleted,
        confidence: receiptData.confidence,
        textFingerprint: receiptData.textFingerprint
      }
    });

    const agendaMatch = !result.duplicate && agendaLedger
      ? await agendaLedger.matchPayment(result.entry)
      : null;
    await sendText(jid, entryReply(result.entry, result.duplicate, agendaMatch));
    return { handled: true, agendaMatch, ...result };
  }

  return { handle };
}
