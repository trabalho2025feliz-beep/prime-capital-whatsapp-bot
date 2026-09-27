import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { localDateKey } from "./finance-ledger.js";

const VERSION = 1;
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function asMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function normalized(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function nameScore(first, second) {
  const left = normalized(first);
  const right = normalized(second);
  if (!left || !right) return 0;
  if (left === right) return 60;
  if (Math.min(left.length, right.length) >= 4 && (left.includes(right) || right.includes(left))) return 52;
  const leftTokens = new Set(left.split(" ").filter((part) => part.length > 1));
  const rightTokens = new Set(right.split(" ").filter((part) => part.length > 1));
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const ratio = common / Math.max(leftTokens.size, rightTokens.size, 1);
  return ratio >= 0.66 ? 45 : 0;
}

function emptyDatabase() {
  return { version: VERSION, updatedAt: null, agendas: [] };
}

function newId(line, date) {
  return `AG-${line || "RP"}-${date.replaceAll("-", "")}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

function publicAgenda(agenda) {
  return {
    id: agenda.id,
    dateKey: agenda.dateKey,
    createdAt: agenda.createdAt,
    confirmedAt: agenda.confirmedAt || null,
    status: agenda.status,
    line: agenda.line,
    attendant: agenda.attendant,
    sender: agenda.sender,
    groupName: agenda.groupName,
    uncertainNotes: agenda.uncertainNotes || [],
    entries: agenda.entries.map((entry) => ({ ...entry }))
  };
}

export class AgendaLedger {
  constructor({ filePath, timezone = "America/Sao_Paulo" }) {
    this.filePath = path.resolve(filePath);
    this.timezone = timezone;
    this.database = null;
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    if (this.database) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(parsed?.agendas)) throw new Error("Formato inválido");
      this.database = { ...emptyDatabase(), ...parsed, agendas: parsed.agendas };
    } catch (error) {
      if (error.code !== "ENOENT") {
        await rename(this.filePath, `${this.filePath}.invalid-${Date.now()}`).catch(() => {});
      }
      this.database = emptyDatabase();
      await this.persist();
    }
  }

  async persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    this.database.updatedAt = new Date().toISOString();
    await writeFile(temporary, `${JSON.stringify(this.database, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  async locked(operation) {
    const pending = this.writeQueue.then(async () => {
      await this.initialize();
      return operation();
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async createDraft(input) {
    return this.locked(async () => {
      const duplicate = this.database.agendas.find((agenda) =>
        (input.messageId && agenda.messageId === input.messageId)
        || (input.imageSha256 && agenda.imageSha256 === input.imageSha256)
      );
      if (duplicate) return { agenda: publicAgenda(duplicate), duplicate: true };

      const date = input.dateKey || localDateKey(input.createdAt, this.timezone);
      const agenda = {
        id: newId(input.line, date),
        dateKey: date,
        createdAt: input.createdAt || new Date().toISOString(),
        status: "draft",
        line: input.line,
        attendant: input.attendant,
        sender: input.sender,
        groupJid: input.groupJid,
        groupName: input.groupName,
        messageId: input.messageId,
        imageSha256: input.imageSha256,
        visionModel: input.visionModel,
        uncertainNotes: input.uncertainNotes || [],
        entries: (input.entries || []).map((entry, index) => ({
          id: `${index + 1}`,
          time: entry.time || null,
          clientName: entry.clientName,
          clientCode: entry.clientCode || null,
          expectedAmount: asMoney(entry.expectedAmount),
          installment: entry.installment || null,
          highlight: entry.highlight || "unknown",
          notes: entry.notes || "",
          confidence: entry.confidence || "low",
          status: "pending"
        }))
      };
      this.database.agendas.push(agenda);
      await this.persist();
      return { agenda: publicAgenda(agenda), duplicate: false };
    });
  }

  async latestDraft({ sender, groupJid } = {}) {
    await this.initialize();
    const agenda = [...this.database.agendas].reverse().find((candidate) =>
      candidate.status === "draft"
      && (!sender || candidate.sender === sender)
      && (!groupJid || candidate.groupJid === groupJid)
    );
    return agenda ? publicAgenda(agenda) : null;
  }

  async confirm(id, confirmedBy) {
    return this.locked(async () => {
      const agenda = this.database.agendas.find((candidate) => candidate.id.toLowerCase() === String(id || "").toLowerCase());
      if (!agenda) return { error: "not_found" };
      if (agenda.sender && confirmedBy && agenda.sender !== confirmedBy) return { error: "forbidden" };
      if (agenda.status === "cancelled") return { error: "cancelled" };
      agenda.status = "confirmed";
      agenda.confirmedAt = new Date().toISOString();
      agenda.confirmedBy = confirmedBy;
      await this.persist();
      return { agenda: publicAgenda(agenda) };
    });
  }

  async cancel(id, cancelledBy) {
    return this.locked(async () => {
      const agenda = this.database.agendas.find((candidate) => candidate.id.toLowerCase() === String(id || "").toLowerCase());
      if (!agenda) return { error: "not_found" };
      if (agenda.sender && cancelledBy && agenda.sender !== cancelledBy) return { error: "forbidden" };
      agenda.status = "cancelled";
      agenda.cancelledAt = new Date().toISOString();
      agenda.cancelledBy = cancelledBy;
      await this.persist();
      return { agenda: publicAgenda(agenda) };
    });
  }

  async matchPayment(financeEntry) {
    if (!financeEntry || financeEntry.kind !== "incoming" || financeEntry.status === "duplicate") return null;
    return this.locked(async () => {
      const candidates = [];
      for (const agenda of this.database.agendas) {
        if (agenda.status !== "confirmed" || agenda.dateKey !== financeEntry.dateKey) continue;
        if (financeEntry.line && agenda.line && financeEntry.line !== agenda.line) continue;
        for (const entry of agenda.entries) {
          if (entry.status !== "pending") continue;
          const names = nameScore(entry.clientName, financeEntry.clientName);
          if (names < 45) continue;
          let score = names;
          if (financeEntry.line && agenda.line === financeEntry.line) score += 20;
          if (entry.expectedAmount != null && financeEntry.amount != null
            && Math.round(entry.expectedAmount * 100) === Math.round(financeEntry.amount * 100)) score += 30;
          candidates.push({ agenda, entry, score });
        }
      }
      candidates.sort((left, right) => right.score - left.score);
      const best = candidates[0];
      if (!best || best.score < 60 || (candidates[1] && candidates[1].score === best.score)) return null;

      best.entry.status = financeEntry.status === "confirmed"
        ? financeEntry.classification === "settlement" ? "settled" : "paid"
        : financeEntry.status === "needs_review" ? "receipt_review" : "receipt_read";
      best.entry.financeId = financeEntry.id;
      best.entry.paidAmount = asMoney(financeEntry.amount);
      best.entry.paidAt = financeEntry.createdAt || new Date().toISOString();
      best.entry.paymentClassification = financeEntry.classification;
      await this.persist();
      return {
        agendaId: best.agenda.id,
        line: best.agenda.line,
        clientName: best.entry.clientName,
        expectedAmount: best.entry.expectedAmount,
        status: best.entry.status,
        score: best.score
      };
    });
  }

  async confirmMatchedPayment(financeEntry) {
    if (!financeEntry?.id) return null;
    return this.locked(async () => {
      for (const agenda of this.database.agendas) {
        const entry = agenda.entries.find((candidate) => candidate.financeId === financeEntry.id);
        if (!entry) continue;
        entry.status = financeEntry.classification === "settlement" ? "settled" : "paid";
        entry.paidAmount = asMoney(financeEntry.amount);
        entry.paidAt = financeEntry.createdAt || new Date().toISOString();
        entry.confirmedAt = new Date().toISOString();
        await this.persist();
        return { agendaId: agenda.id, line: agenda.line, clientName: entry.clientName, status: entry.status };
      }
      return null;
    });
  }

  async summary({ date = localDateKey(new Date(), this.timezone), line } = {}) {
    await this.initialize();
    const agendas = this.database.agendas.filter((agenda) =>
      agenda.status === "confirmed" && agenda.dateKey === date && (!line || agenda.line === line)
    );
    const entries = agendas.flatMap((agenda) => agenda.entries.map((entry) => ({ ...entry, line: agenda.line })));
    const paid = entries.filter((entry) => entry.status === "paid" || entry.status === "settled");
    const receipts = entries.filter((entry) => entry.status === "receipt_read" || entry.status === "receipt_review");
    const pending = entries.filter((entry) => entry.status !== "paid" && entry.status !== "settled");
    const total = (items, field) => Math.round(items.reduce((sum, entry) => sum + (Number(entry[field]) || 0), 0) * 100) / 100;
    return {
      date,
      line: line || null,
      agendas: agendas.length,
      clients: entries.length,
      expected: total(entries, "expectedAmount"),
      paidClients: paid.length,
      received: total(paid, "paidAmount"),
      receiptClients: receipts.length,
      receiptAmount: total(receipts, "paidAmount"),
      pendingClients: pending.length,
      pendingExpected: total(pending, "expectedAmount"),
      lowConfidence: entries.filter((entry) => entry.confidence === "low").length
    };
  }

  async pending({ date = localDateKey(new Date(), this.timezone), line, limit = 30 } = {}) {
    await this.initialize();
    return this.database.agendas
      .filter((agenda) => agenda.status === "confirmed" && agenda.dateKey === date && (!line || agenda.line === line))
      .flatMap((agenda) => agenda.entries
        .filter((entry) => entry.status !== "paid" && entry.status !== "settled")
        .map((entry) => ({ agendaId: agenda.id, line: agenda.line, attendant: agenda.attendant, ...entry })))
      .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)));
  }
}

export function formatAgendaSummary(summary) {
  const title = summary.line ? `AGENDA ${summary.line}` : "AGENDA GERAL";
  return [
    `📅 *${title} — ${summary.date.split("-").reverse().join("/")}*`,
    "",
    `Clientes previstos: ${summary.clients}`,
    `Valor previsto: ${money.format(summary.expected)}`,
    `Comprovantes cruzados: ${summary.receiptClients} | ${money.format(summary.receiptAmount)}`,
    `Confirmados no banco: ${summary.paidClients} | ${money.format(summary.received)}`,
    `Ainda pendentes: ${summary.pendingClients} | ${money.format(summary.pendingExpected)}`,
    summary.lowConfidence ? `⚠️ Campos com leitura duvidosa: ${summary.lowConfidence}` : "✅ Todas as linhas foram confirmadas"
  ].join("\n");
}
