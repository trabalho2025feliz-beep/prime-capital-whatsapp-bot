import path from "node:path";
import process from "node:process";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import cron from "node-cron";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";
import { createAgendaHandler } from "./agenda-handler.js";
import { AgendaLedger, formatAgendaSummary } from "./agenda-ledger.js";
import { createFinancialHandler, textFromMessage } from "./financial-handler.js";
import { FinanceLedger, formatFinanceSummary, localDateKey } from "./finance-ledger.js";
import { terminateOcr } from "./receipt-parser.js";
import { fetchReport } from "./report-client.js";
import { startServer } from "./server.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const authDir = path.resolve(process.env.AUTH_DIR || "./auth");
const timezone = process.env.TZ || "America/Sao_Paulo";
const groupDefinitions = {
  report: {
    name: process.env.WHATSAPP_GROUP_NAME || "Relatórios Prime Capital",
    jid: process.env.WHATSAPP_GROUP_JID || ""
  },
  incoming: {
    name: process.env.WHATSAPP_INCOMING_GROUP_NAME || "Entradas Prime Capital",
    jid: process.env.WHATSAPP_INCOMING_GROUP_JID || ""
  },
  outgoing: {
    name: process.env.WHATSAPP_OUTGOING_GROUP_NAME || "Saídas Prime Capital",
    jid: process.env.WHATSAPP_OUTGOING_GROUP_JID || ""
  },
  agenda: {
    name: process.env.WHATSAPP_AGENDA_GROUP_NAME || "Grupo agenda",
    jid: process.env.WHATSAPP_AGENDA_GROUP_JID || ""
  }
};
const ledgerPath = path.resolve(process.env.LEDGER_PATH || path.join(path.dirname(authDir), "prime-capital-finance.json"));
const ledger = new FinanceLedger({ filePath: ledgerPath, timezone });
const agendaLedgerPath = path.resolve(process.env.AGENDA_LEDGER_PATH || path.join(path.dirname(authDir), "prime-capital-agendas.json"));
const agendaLedger = new AgendaLedger({ filePath: agendaLedgerPath, timezone });
const state = { connected: false, qr: null };

let socket;
let reconnectTimer;
let schedulesStarted = false;

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function splitMessage(text, limit = 3900) {
  const parts = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.6) cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit * 0.6) cut = limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function resolveGroup(role) {
  const definition = groupDefinitions[role];
  if (!definition) return null;
  if (definition.jid) return definition.jid;
  if (!socket || !state.connected) return null;

  const groups = await socket.groupFetchAllParticipating();
  const matches = Object.values(groups).filter((group) => normalize(group.subject) === normalize(definition.name));
  if (matches.length === 1) {
    definition.jid = matches[0].id;
    console.log(`[grupo] Grupo ${role} encontrado: ${matches[0].subject}`);
    return definition.jid;
  }

  if (!matches.length) {
    console.log(`[grupo] Aguardando o número ser adicionado ao grupo “${definition.name}”.`);
  } else {
    console.log(`[grupo] Existem ${matches.length} grupos com o nome “${definition.name}”. Configure o JID específico.`);
  }
  return null;
}

async function identifyGroup(jid) {
  const configured = Object.entries(groupDefinitions).find(([, definition]) => definition.jid === jid);
  if (configured) return configured[0];

  try {
    const metadata = await socket.groupMetadata(jid);
    const match = Object.entries(groupDefinitions).find(([, definition]) => normalize(metadata.subject) === normalize(definition.name));
    if (match) {
      match[1].jid = jid;
      console.log(`[grupo] Grupo ${match[0]} definido: ${metadata.subject}`);
      return match[0];
    }
  } catch (error) {
    logger.warn({ error }, "Não foi possível conferir o grupo");
  }
  return null;
}

async function sendText(jid, text) {
  for (const part of splitMessage(text)) {
    await socket.sendMessage(jid, { text: part });
  }
}

async function sendReport(mode, { scheduled = false } = {}) {
  const jid = await resolveGroup("report");
  if (!jid) {
    if (!scheduled) throw new Error(`Grupo “${groupDefinitions.report.name}” ainda não encontrado`);
    return;
  }

  const report = await fetchReport(mode);
  if (scheduled && mode === "alerts" && /nenhum ingresso sem classifica/i.test(report)) return;
  await sendText(jid, report);
}

function startSchedules() {
  if (schedulesStarted) return;
  schedulesStarted = true;

  cron.schedule("0 8,12,18 * * *", async () => {
    try {
      await sendReport("full", { scheduled: true });
    } catch (error) {
      logger.error({ error }, "Falha no relatório automático");
    }
  }, { timezone });

  cron.schedule("0 */2 * * *", async () => {
    try {
      await sendReport("alerts", { scheduled: true });
    } catch (error) {
      logger.error({ error }, "Falha nos alertas automáticos");
    }
  }, { timezone });

  cron.schedule("5 18 * * *", async () => {
    try {
      const jid = await resolveGroup("report");
      if (!jid) return;
      await sendText(jid, [
        formatFinanceSummary(await ledger.summary()),
        "",
        formatAgendaSummary(await agendaLedger.summary())
      ].join("\n"));
    } catch (error) {
      logger.error({ error }, "Falha no resumo financeiro automático");
    }
  }, { timezone });

  cron.schedule("0 7 * * 1-6", async () => {
    try {
      const jid = await resolveGroup("agenda");
      if (!jid) return;
      await sendText(jid, [
        "📅 *BOM DIA — ENVIO DAS AGENDAS*",
        "",
        "Cada atendente deve enviar a foto da agenda com a legenda:",
        "*AGENDA RP2 - CARLA - 27/09/2026*",
        "",
        "Depois da leitura, confira e use /confirmaragenda CÓDIGO."
      ].join("\n"));
    } catch (error) {
      logger.error({ error }, "Falha no lembrete das agendas");
    }
  }, { timezone });

  console.log(`[agenda] Relatórios automáticos ativos em ${timezone}.`);
}

const financialHandler = createFinancialHandler({
  ledger,
  agendaLedger,
  logger,
  getSocket: () => socket,
  sendText
});
const agendaHandler = createAgendaHandler({
  agendaLedger,
  logger,
  getSocket: () => socket,
  sendText,
  timezone,
  groupName: groupDefinitions.agenda.name
});
const financeNumbers = String(process.env.FINANCE_WHATSAPP_NUMBERS || "")
  .split(",")
  .map((value) => value.replace(/\D/g, ""))
  .filter(Boolean);

function senderNumber(message) {
  return String(message.key.participant || message.participant || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function financeUserAuthorized(message) {
  const sender = senderNumber(message);
  return Boolean(sender) && financeNumbers.some((number) => sender === number || sender.endsWith(number) || number.endsWith(sender));
}

async function sendPending(jid) {
  const pending = await ledger.recent({ date: localDateKey(new Date(), timezone), status: "needs_review", limit: 15 });
  if (!pending.length) {
    await sendText(jid, "✅ Nenhum comprovante aguardando revisão hoje.");
    return;
  }
  await sendText(jid, [
    "⚠️ *COMPROVANTES AGUARDANDO REVISÃO*",
    "",
    ...pending.map((entry) => `• *${entry.id}* — ${entry.clientName || "cliente não identificado"} — ${entry.amount != null ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(entry.amount) : "sem valor"}`),
    "",
    "Após conferir no banco: /confirmar CÓDIGO"
  ].join("\n"));
}

async function sendAgendaPending(jid, line) {
  const pending = await agendaLedger.pending({ line, limit: 40 });
  if (!pending.length) {
    await sendText(jid, `✅ Nenhum cliente pendente na agenda${line ? ` da ${line}` : ""} hoje.`);
    return;
  }
  const formatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  await sendText(jid, [
    `📅 *PENDÊNCIAS DA AGENDA${line ? ` — ${line}` : ""}*`,
    "",
    ...pending.map((entry) => `• ${entry.line} — ${entry.time || "sem horário"} — ${entry.clientName} — ${entry.expectedAmount != null ? formatter.format(entry.expectedAmount) : "sem valor"}${entry.status === "receipt_read" ? " — 📄 comprovante lido" : entry.status === "receipt_review" ? " — ⚠️ comprovante em revisão" : ""}`)
  ].join("\n"));
}

async function handleCommand(message, role) {
  const jid = message.key.remoteJid;
  const text = textFromMessage(message);
  const command = text.split(/\s+/)[0].toLowerCase();
  const modes = {
    "/atualizar": "full",
    "/resumo": "summary",
    "/linhas": "lines",
    "/alertas": "alerts"
  };

  if (command === "/ajuda" || command === "/comandos") {
    await sendText(jid, [
      "🤖 *BOT PRIME CAPITAL*",
      "",
      "/atualizar — relatório completo",
      "/resumo — resumo geral",
      "/linhas — desempenho das RP1 a RP5",
      "/alertas — ingressos sem classificação",
      "/financeiro — entradas e saídas do dia",
      "/entradas — comprovantes de entrada do dia",
      "/saidas — comprovantes de saída do dia",
      "/pendentes — comprovantes que precisam de revisão",
      "/confirmar CÓDIGO — confirmar após conferir no banco",
      "/agenda — previsto, recebido e pendente das agendas",
      "/pendenciasagenda — clientes da agenda ainda sem pagamento",
      "/confirmaragenda CÓDIGO — salvar a agenda após conferir",
      "/cancelaragenda CÓDIGO — descartar uma leitura incorreta",
      "/status — verificar conexão"
    ].join("\n"));
    return true;
  }

  if (command === "/status") {
    const groupStatus = Object.values(groupDefinitions).map((definition) => `${definition.jid ? "✅" : "⏳"} ${definition.name}`);
    await sendText(jid, ["✅ Bot conectado e pronto.", "", ...groupStatus].join("\n"));
    return true;
  }

  if (["/financeiro", "/movimentos", "/entradas", "/saidas", "/saídas"].includes(command)) {
    const kind = command === "/entradas" ? "incoming" : ["/saidas", "/saídas"].includes(command) ? "outgoing" : undefined;
    await sendText(jid, formatFinanceSummary(await ledger.summary({ kind }), kind));
    return true;
  }

  if (command === "/pendentes") {
    await sendPending(jid);
    return true;
  }

  if (command === "/agenda" || command === "/pendenciasagenda") {
    const requested = text.match(/\b(?:rp|l)\s*([1-5])\b/i)?.[1];
    const line = requested ? `RP${requested}` : undefined;
    if (command === "/agenda") await sendText(jid, formatAgendaSummary(await agendaLedger.summary({ line })));
    else await sendAgendaPending(jid, line);
    return true;
  }

  if (command === "/confirmaragenda" || command === "/cancelaragenda") {
    const sender = senderNumber(message);
    let id = text.split(/\s+/)[1];
    if (!id) id = (await agendaLedger.latestDraft({ sender, groupJid: jid }))?.id;
    if (!id) {
      await sendText(jid, `Use: ${command} CÓDIGO`);
      return true;
    }
    const result = command === "/confirmaragenda"
      ? await agendaLedger.confirm(id, sender)
      : await agendaLedger.cancel(id, sender);
    if (result.error === "forbidden") {
      await sendText(jid, "🔒 Apenas a atendente que enviou a foto pode confirmar ou cancelar esta agenda.");
    } else if (result.error) {
      await sendText(jid, `❌ Agenda *${id}* não encontrada ou indisponível.`);
    } else if (command === "/confirmaragenda") {
      await sendText(jid, [
        `✅ Agenda *${result.agenda.id}* confirmada e salva.`,
        "Os comprovantes de entrada já poderão ser cruzados com esses clientes.",
        "",
        formatAgendaSummary(await agendaLedger.summary({ line: result.agenda.line }))
      ].join("\n"));
    } else {
      await sendText(jid, `🗑️ Leitura *${result.agenda.id}* cancelada. Envie uma nova foto mais nítida.`);
    }
    return true;
  }

  if (command === "/confirmar") {
    if (!financeNumbers.length) {
      await sendText(jid, "🔒 A confirmação bancária ainda não tem números autorizados configurados.");
      return true;
    }
    if (!financeUserAuthorized(message)) {
      await sendText(jid, "🔒 Apenas o financeiro autorizado pode confirmar uma entrada ou saída.");
      return true;
    }
    const id = text.split(/\s+/)[1];
    if (!id) {
      await sendText(jid, "Use: /confirmar CÓDIGO");
      return true;
    }
    const confirmed = await ledger.confirm(id, senderNumber(message));
    if (confirmed) await agendaLedger.confirmMatchedPayment(confirmed);
    await sendText(jid, confirmed
      ? `✅ *${confirmed.id}* confirmado após conferência bancária.`
      : `❌ Código *${id}* não encontrado.`);
    return true;
  }

  const mode = modes[command];
  if (!mode || role !== "report") return false;

  await socket.sendPresenceUpdate("composing", jid);
  try {
    await sendText(jid, "⏳ Consultando as cinco RPs no Try…");
    await sendReport(mode);
  } catch (error) {
    logger.error({ error, command }, "Falha ao executar comando");
    await sendText(jid, `❌ Não foi possível atualizar: ${error.message}`);
  } finally {
    await socket.sendPresenceUpdate("paused", jid);
  }
  return true;
}

async function handleMessage(message) {
  const jid = message.key.remoteJid;
  if (!jid?.endsWith("@g.us") || message.key.fromMe) return;
  const role = await identifyGroup(jid);
  if (!role) return;

  const text = textFromMessage(message);
  if (text.startsWith("/") && await handleCommand(message, role)) return;
  if (role === "report") return;

  if (role === "agenda") {
    await agendaHandler.handle(message);
    return;
  }

  const kind = role === "incoming" ? "incoming" : "outgoing";
  await financialHandler.handle(message, { kind, groupName: groupDefinitions[role].name });
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      try {
        await handleMessage(message);
      } catch (error) {
        logger.error({ error }, "Falha ao processar mensagem");
        const jid = message.key.remoteJid;
        if (jid?.endsWith("@g.us")) {
          await sendText(jid, `❌ Não foi possível processar esta mensagem: ${error.message || "erro desconhecido"}`).catch(() => {});
        }
      }
    }
  });

  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state.qr = qr;
      state.connected = false;
      console.log("[whatsapp] QR Code pronto. Abra o domínio público do serviço e informe o código de pareamento mostrado acima.");
      if (process.env.PRINT_QR_TERMINAL === "true") qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "open") {
      state.connected = true;
      state.qr = null;
      console.log("[whatsapp] Conectado com sucesso.");
      for (const role of Object.keys(groupDefinitions)) await resolveGroup(role);
      startSchedules();
      return;
    }

    if (connection !== "close") return;
    state.connected = false;
    state.qr = null;

    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const loggedOut = statusCode === DisconnectReason.loggedOut;
    if (loggedOut) {
      console.error("[whatsapp] Sessão desconectada pelo WhatsApp. Será necessário escanear um novo QR Code.");
      return;
    }

    console.log(`[whatsapp] Conexão encerrada (${statusCode || "sem código"}). Reconectando…`);
    reconnectTimer = setTimeout(() => connect().catch((error) => logger.error({ error }, "Falha ao reconectar")), 5_000);
  });
}

process.on("unhandledRejection", (error) => logger.error({ error }, "Erro não tratado"));
process.on("uncaughtException", (error) => logger.fatal({ error }, "Erro fatal"));

async function shutdown(signal) {
  console.log(`[sistema] Encerrando por ${signal}…`);
  clearTimeout(reconnectTimer);
  await terminateOcr().catch(() => {});
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

async function main() {
  await ledger.initialize();
  await agendaLedger.initialize();
  startServer(state, { ledger, agendaLedger });
  await connect();
}

main().catch((error) => {
  logger.fatal({ error }, "Não foi possível iniciar o WhatsApp");
  process.exitCode = 1;
});
