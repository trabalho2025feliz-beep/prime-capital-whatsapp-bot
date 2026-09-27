import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = 1;

function asMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

export function localDateKey(value = new Date(), timezone = "America/Sao_Paulo") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function emptyDatabase() {
  return { version: VERSION, updatedAt: null, entries: [] };
}

function safeEntry(entry) {
  return {
    ...entry,
    amount: asMoney(entry.amount),
    captionAmount: asMoney(entry.captionAmount),
    createdAt: entry.createdAt || new Date().toISOString()
  };
}

function newId(kind, dateKey) {
  const prefix = kind === "incoming" ? "ENT" : "SAI";
  return `${prefix}-${dateKey.replaceAll("-", "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

function publicEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    dateKey: entry.dateKey,
    createdAt: entry.createdAt,
    groupName: entry.groupName,
    sender: entry.sender,
    clientName: entry.clientName,
    line: entry.line,
    classification: entry.classification,
    amount: entry.amount,
    status: entry.status,
    warnings: entry.warnings,
    duplicateOf: entry.duplicateOf,
    receipt: entry.receipt ? {
      source: entry.receipt.source,
      fileName: entry.receipt.fileName,
      bank: entry.receipt.bank,
      transactionSuffix: entry.receipt.transactionSuffix,
      transactionDate: entry.receipt.transactionDate,
      saysCompleted: entry.receipt.saysCompleted,
      confidence: entry.receipt.confidence
    } : null
  };
}

export class FinanceLedger {
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
      if (!Array.isArray(parsed?.entries)) throw new Error("Formato inválido");
      this.database = { ...emptyDatabase(), ...parsed, entries: parsed.entries };
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backup = `${this.filePath}.invalid-${Date.now()}`;
        await rename(this.filePath, backup).catch(() => {});
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

  async add(input) {
    return this.locked(async () => {
      const dateKey = input.dateKey || localDateKey(input.createdAt, this.timezone);
      const entry = safeEntry({
        ...input,
        id: input.id || newId(input.kind, dateKey),
        dateKey
      });

      const duplicate = this.database.entries.find((existing) => {
        if (entry.messageId && existing.messageId === entry.messageId) return true;
        if (entry.receipt?.sha256 && existing.receipt?.sha256 === entry.receipt.sha256) return true;
        if (entry.receipt?.transactionHash && existing.receipt?.transactionHash === entry.receipt.transactionHash) return true;
        return false;
      });

      if (duplicate) {
        entry.status = "duplicate";
        entry.duplicateOf = duplicate.id;
      }

      this.database.entries.push(entry);
      await this.persist();
      return { entry: publicEntry(entry), duplicate: duplicate ? publicEntry(duplicate) : null };
    });
  }

  async confirm(id, confirmedBy) {
    return this.locked(async () => {
      const entry = this.database.entries.find((candidate) => candidate.id.toLowerCase() === String(id || "").toLowerCase());
      if (!entry) return null;
      if (entry.status === "duplicate") return publicEntry(entry);
      entry.status = "confirmed";
      entry.confirmedAt = new Date().toISOString();
      entry.confirmedBy = confirmedBy;
      await this.persist();
      return publicEntry(entry);
    });
  }

  async summary({ date = localDateKey(new Date(), this.timezone), kind } = {}) {
    await this.initialize();
    const selected = this.database.entries.filter((entry) => entry.dateKey === date && (!kind || entry.kind === kind));
    const valid = selected.filter((entry) => entry.status !== "duplicate");
    const total = (items) => Math.round(items.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0) * 100) / 100;
    const byKind = (wanted) => valid.filter((entry) => entry.kind === wanted);
    const byClass = (wanted) => valid.filter((entry) => entry.classification === wanted);
    return {
      date,
      count: valid.length,
      total: total(valid),
      incoming: { count: byKind("incoming").length, total: total(byKind("incoming")) },
      outgoing: { count: byKind("outgoing").length, total: total(byKind("outgoing")) },
      interest: { count: byClass("interest").length, total: total(byClass("interest")) },
      settlement: { count: byClass("settlement").length, total: total(byClass("settlement")) },
      sale: { count: byClass("sale").length, total: total(byClass("sale")) },
      receiptRead: valid.filter((entry) => entry.status === "receipt_read").length,
      confirmed: valid.filter((entry) => entry.status === "confirmed").length,
      needsReview: valid.filter((entry) => entry.status === "needs_review").length,
      duplicates: selected.filter((entry) => entry.status === "duplicate").length
    };
  }

  async recent({ date, kind, status, limit = 30 } = {}) {
    await this.initialize();
    return this.database.entries
      .filter((entry) => (!date || entry.dateKey === date) && (!kind || entry.kind === kind) && (!status || entry.status === status))
      .slice(-Math.max(1, Math.min(Number(limit) || 30, 100)))
      .reverse()
      .map(publicEntry);
  }
}

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatFinanceSummary(summary, kind) {
  const title = kind === "incoming" ? "ENTRADAS" : kind === "outgoing" ? "SAÍDAS" : "MOVIMENTAÇÃO FINANCEIRA";
  const lines = [`💰 *${title} — ${summary.date.split("-").reverse().join("/")}*`, ""];
  if (kind !== "outgoing") {
    lines.push(`⬆️ Entradas: ${summary.incoming.count} | ${money.format(summary.incoming.total)}`);
    lines.push(`• Juros: ${summary.interest.count} | ${money.format(summary.interest.total)}`);
    lines.push(`• Quitações: ${summary.settlement.count} | ${money.format(summary.settlement.total)}`);
  }
  if (kind !== "incoming") lines.push(`⬇️ Saídas liberadas: ${summary.outgoing.count} | ${money.format(summary.outgoing.total)}`);
  lines.push("", `✅ Confirmados no banco: ${summary.confirmed}`);
  lines.push(`📄 Comprovantes lidos: ${summary.receiptRead}`);
  lines.push(`⚠️ Precisam de revisão: ${summary.needsReview}`);
  if (summary.duplicates) lines.push(`♻️ Comprovantes repetidos: ${summary.duplicates}`);
  return lines.join("\n");
}
