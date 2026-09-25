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
import { fetchReport } from "./report-client.js";
import { startServer } from "./server.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const authDir = path.resolve(process.env.AUTH_DIR || "./auth");
const groupName = process.env.WHATSAPP_GROUP_NAME || "Relatórios Prime Capital";
const configuredGroupJid = process.env.WHATSAPP_GROUP_JID || "";
const timezone = process.env.TZ || "America/Sao_Paulo";
const state = { connected: false, qr: null };

let socket;
let targetGroupJid = configuredGroupJid;
let reconnectTimer;
let schedulesStarted = false;

startServer(state);

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function extractText(message) {
  let content = message.message || {};
  content = content.ephemeralMessage?.message || content;
  content = content.viewOnceMessage?.message || content.viewOnceMessageV2?.message || content;
  return String(
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    ""
  ).trim();
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

async function resolveTargetGroup() {
  if (targetGroupJid) return targetGroupJid;
  if (!socket || !state.connected) return null;

  const groups = await socket.groupFetchAllParticipating();
  const matches = Object.values(groups).filter((group) => normalize(group.subject) === normalize(groupName));
  if (matches.length === 1) {
    targetGroupJid = matches[0].id;
    console.log(`[grupo] Grupo autorizado encontrado: ${matches[0].subject}`);
    return targetGroupJid;
  }

  if (!matches.length) {
    console.log(`[grupo] Aguardando o número ser adicionado ao grupo “${groupName}”.`);
  } else {
    console.log(`[grupo] Existem ${matches.length} grupos com o nome “${groupName}”. Configure WHATSAPP_GROUP_JID.`);
  }
  return null;
}

async function groupIsAuthorized(jid) {
  const target = await resolveTargetGroup();
  if (target) return target === jid;

  try {
    const metadata = await socket.groupMetadata(jid);
    if (normalize(metadata.subject) === normalize(groupName)) {
      targetGroupJid = jid;
      console.log(`[grupo] Grupo autorizado definido: ${metadata.subject}`);
      return true;
    }
  } catch (error) {
    logger.warn({ error }, "Não foi possível conferir o grupo");
  }
  return false;
}

async function sendText(jid, text) {
  for (const part of splitMessage(text)) {
    await socket.sendMessage(jid, { text: part });
  }
}

async function sendReport(mode, { scheduled = false } = {}) {
  const jid = await resolveTargetGroup();
  if (!jid) {
    if (!scheduled) throw new Error(`Grupo “${groupName}” ainda não encontrado`);
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

  console.log(`[agenda] Relatórios automáticos ativos em ${timezone}.`);
}

async function handleCommand(message) {
  const jid = message.key.remoteJid;
  if (!jid?.endsWith("@g.us")) return;
  if (!(await groupIsAuthorized(jid))) return;

  const text = extractText(message);
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
      "/status — verificar conexão"
    ].join("\n"));
    return;
  }

  if (command === "/status") {
    await sendText(jid, "✅ Bot conectado e pronto para atualizar os relatórios.");
    return;
  }

  const mode = modes[command];
  if (!mode) return;

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
        await handleCommand(message);
      } catch (error) {
        logger.error({ error }, "Falha ao processar mensagem");
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
      await resolveTargetGroup();
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

connect().catch((error) => {
  logger.fatal({ error }, "Não foi possível iniciar o WhatsApp");
  process.exitCode = 1;
});
