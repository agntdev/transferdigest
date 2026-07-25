import { now } from "./time.js";

export interface Transfer {
  id: string;
  player: string;
  age?: number;
  fromClub: string;
  toClub: string;
  transferFee?: string;
  currency?: string;
  transferType?: string;
  contractLength?: string;
  salary?: string;
  medicalNotes?: string;
  agent?: string;
  timestamp: number;
  league?: string;
  country?: string;
  sourceLinks: string[];
  readBy: string[];
}

export interface UserPreference {
  adminChatId: string;
  timezone: string;
  summaryTime: string;
  notificationEnabled: boolean;
  lastSummaryAt: number;
}

export interface DomainEnv {
  CHAT_DO?: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(input: string, init?: { method?: string; body?: string }): Promise<Response> };
  };
}

function globalStore(env: DomainEnv) {
  return env.CHAT_DO?.get(env.CHAT_DO.idFromName("transfer-tracker"));
}

function ownerStore(env: DomainEnv, chatId: string) {
  return env.CHAT_DO?.get(env.CHAT_DO.idFromName(`chat:${chatId}`));
}

async function readJson<T>(response: Response): Promise<T | undefined> {
  if (!response.ok) return undefined;
  return (await response.json()) as T;
}

export async function listTransfersSince(env: DomainEnv | undefined, since: number): Promise<Transfer[]> {
  const store = env && globalStore(env);
  if (!store) return [];
  const result = await readJson<Transfer[]>(await store.fetch(`https://do/transfers?since=${since}`));
  return result ?? [];
}

export async function getTransfer(env: DomainEnv | undefined, id: string): Promise<Transfer | undefined> {
  const store = env && globalStore(env);
  if (!store) return undefined;
  return readJson<Transfer>(await store.fetch(`https://do/transfer/${encodeURIComponent(id)}`));
}

export async function markTransferRead(env: DomainEnv | undefined, id: string, chatId: string): Promise<boolean> {
  const store = env && globalStore(env);
  if (!store) return false;
  const response = await store.fetch(`https://do/transfer/${encodeURIComponent(id)}/read`, {
    method: "POST",
    body: JSON.stringify({ chatId }),
  });
  return response.ok;
}

export async function getPreference(env: DomainEnv | undefined, chatId: string): Promise<UserPreference | undefined> {
  const store = env && ownerStore(env, chatId);
  if (!store) return undefined;
  return readJson<UserPreference>(await store.fetch("https://do/preference"));
}

export async function savePreference(env: DomainEnv | undefined, pref: UserPreference): Promise<boolean> {
  const store = env && ownerStore(env, pref.adminChatId);
  if (!store) return false;
  const response = await store.fetch("https://do/preference", { method: "PUT", body: JSON.stringify(pref) });
  return response.ok;
}

export function defaultPreference(chatId: string): UserPreference {
  return {
    adminChatId: chatId,
    timezone: "UTC",
    summaryTime: "08:00",
    notificationEnabled: true,
    lastSummaryAt: now(),
  };
}

export function utcDayStart(at = now()): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function parseIsoDay(input: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return undefined;
  const [year, month, day] = input.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? value
    : undefined;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Stable identity used to merge reports of the same move from multiple sources. */
export function transferDedupeKey(transfer: Pick<Transfer, "player" | "fromClub" | "toClub" | "timestamp">): string {
  return [transfer.player, transfer.fromClub, transfer.toClub, transfer.timestamp].join("\u001f");
}

export function groupedTransfers(transfers: Transfer[]): Array<{ heading: string; transfers: Transfer[] }> {
  const groups = new Map<string, Transfer[]>();
  for (const transfer of transfers) {
    const heading = transfer.league || transfer.country || "Other transfers";
    groups.set(heading, [...(groups.get(heading) ?? []), transfer]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([heading, items]) => ({ heading, transfers: items }));
}

export function transferLine(transfer: Transfer): string {
  return `${escapeHtml(transfer.player)} — ${escapeHtml(transfer.fromClub)} → ${escapeHtml(transfer.toClub)}`;
}

export function summaryText(transfers: Transfer[], title: string, page: number, perPage = 15): string {
  if (transfers.length === 0) return "No activity in this time window yet.";
  const shown = transfers.slice(page * perPage, page * perPage + perPage);
  const lines = groupedTransfers(shown).flatMap((group) => ["<b>" + escapeHtml(group.heading) + "</b>", ...group.transfers.map(transferLine)]);
  const pages = Math.ceil(transfers.length / perPage);
  return `<b>${escapeHtml(title)}</b>\n\n${lines.join("\n")}${pages > 1 ? `\n\nPage ${page + 1} of ${pages}` : ""}`;
}

export function detailText(transfer: Transfer): string {
  const reported = (value: string | undefined) => escapeHtml(value || "Not reported");
  return [
    `<b>${escapeHtml(transfer.player)}</b>`,
    `Age: ${transfer.age ?? "Not reported"}`,
    `Move: ${escapeHtml(transfer.fromClub)} → ${escapeHtml(transfer.toClub)}`,
    `Fee: ${reported(transfer.transferFee)}${transfer.currency ? ` ${escapeHtml(transfer.currency)}` : ""}`,
    `Type: ${reported(transfer.transferType)}`,
    `Contract: ${reported(transfer.contractLength)}`,
    `Salary: ${reported(transfer.salary)}`,
    `Medical and fitness: ${reported(transfer.medicalNotes)}`,
    `Agent: ${reported(transfer.agent)}`,
  ].join("\n");
}
