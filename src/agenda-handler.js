import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { agendaMediaSizeLimit, extractAgendaFromImage, parseAgendaCaption } from "./agenda-vision.js";
import { localDateKey } from "./finance-ledger.js";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

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

function numberFromJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

function messageDate(message) {
  const raw = message?.messageTimestamp;
  const seconds = typeof raw?.toNumber === "function" ? raw.toNumber() : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

function imageFromMessage(message) {
  const content = unwrapContent(message);
  if (!content.imageMessage) return null;
  const node = content.imageMessage;
  return {
    node,
    mimeType: node.mimetype || "image/jpeg",
    caption: String(node.caption || "").trim(),
    fileLength: Number(node.fileLength?.toString?.() || node.fileLength || 0)
  };
}

function formatDraft(agenda) {
  const expected = agenda.entries.reduce((sum, entry) => sum + (Number(entry.expectedAmount) || 0), 0);
  const doubtful = agenda.entries.filter((entry) => entry.confidence === "low").length;
  const lines = [
    `📅 *AGENDA LIDA — ${agenda.line} ${String(agenda.attendant || "").toUpperCase()}*`,
    `Código: *${agenda.id}*`,
    `Data: ${agenda.dateKey.split("-").reverse().join("/")}`,
    `Clientes: ${agenda.entries.length}`,
    `Valor previsto: ${money.format(expected)}`,
    "",
    "*Confira antes de salvar:*"
  ];
  agenda.entries.forEach((entry, index) => {
    const pieces = [
      `${index + 1}. ${entry.time || "sem horário"} — ${entry.clientName}`,
      entry.clientCode ? `cód. ${entry.clientCode}` : null,
      entry.expectedAmount != null ? money.format(entry.expectedAmount) : "sem valor",
      entry.installment || null
    ].filter(Boolean);
    lines.push(`${entry.confidence === "low" ? "⚠️ " : ""}${pieces.join(" | ")}`);
  });
  if (doubtful || agenda.uncertainNotes.length) {
    lines.push("", `⚠️ Leituras que merecem atenção: ${doubtful}`);
    lines.push(...agenda.uncertainNotes.slice(0, 5).map((note) => `• ${note}`));
  }
  lines.push(
    "",
    `Para salvar: */confirmaragenda ${agenda.id}*`,
    `Para descartar: */cancelaragenda ${agenda.id}*`,
    "A foto foi processada e não ficou armazenada."
  );
  return lines.join("\n");
}

export function createAgendaHandler({ agendaLedger, logger, getSocket, sendText, timezone, groupName }) {
  async function handle(message) {
    const jid = message.key.remoteJid;
    const image = imageFromMessage(message);
    if (!image) return { handled: false };
    if (!/^image\/(?:jpeg|jpg|png|webp)$/i.test(image.mimeType)) {
      await sendText(jid, "⚠️ Envie a agenda como foto JPG, PNG ou WEBP.");
      return { handled: true };
    }
    if (image.fileLength > agendaMediaSizeLimit()) {
      await sendText(jid, `⚠️ A foto é maior que ${Math.round(agendaMediaSizeLimit() / 1024 / 1024)} MB.`);
      return { handled: true };
    }

    const caption = parseAgendaCaption(image.caption);
    if (!caption.line) {
      await sendText(jid, "⚠️ Não identifiquei a RP. Reenvie com a legenda: *AGENDA RP2 - CARLA - 27/09/2026*");
      return { handled: true };
    }

    await sendText(jid, "⏳ Lendo a agenda manuscrita… isso pode levar alguns segundos.");
    const socket = getSocket();
    const buffer = await downloadMediaMessage(message, "buffer", {}, {
      logger,
      reuploadRequest: socket.updateMediaMessage
    });
    const result = await extractAgendaFromImage({
      buffer,
      mimeType: image.mimeType,
      caption: image.caption
    });
    const createdAt = messageDate(message);
    const saved = await agendaLedger.createDraft({
      dateKey: caption.dateKey || localDateKey(createdAt, timezone),
      createdAt: createdAt.toISOString(),
      line: caption.line,
      attendant: caption.attendant,
      sender: numberFromJid(message.key.participant || message.participant),
      groupJid: jid,
      groupName,
      messageId: message.key.id,
      imageSha256: result.sha256,
      visionModel: result.model,
      entries: result.entries,
      uncertainNotes: result.uncertainNotes
    });
    if (saved.duplicate) {
      await sendText(jid, `♻️ Esta foto já foi processada como *${saved.agenda.id}* e não será cadastrada novamente.`);
      return { handled: true, duplicate: true };
    }
    await sendText(jid, formatDraft(saved.agenda));
    return { handled: true, agenda: saved.agenda };
  }

  return { handle };
}
