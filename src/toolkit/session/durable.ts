/**
 * Durable Object session storage + exact-time reminders for the Cloudflare
 * Workers runtime (docs/cloudflare/new-projects-on-cf.md §1, §10).
 *
 * One ChatDO instance per chat (addressed by idFromName("chat:<chatId>")). It
 * holds:
 *   - the grammY session (strongly consistent, serialized per chat for free);
 *   - that chat's reminders, with a single Durable Object ALARM armed to the
 *     earliest due one. The alarm fires at the wall-clock time even when nothing
 *     is running — this is what replaces per-bot cron + Redis (PoC: 0–1 ms).
 *
 * NONE of this is imported by the Node/long-poll entry or the test harness, so
 * `node:fs`, Redis, and this file's Workers-only globals never load there.
 */

import type { StorageAdapter } from "grammy";
import { summaryText, transferDedupeKey, type Transfer, type UserPreference } from "../../transfer-domain.js";
import { nextScheduledTime, now } from "../../time.js";

// Minimal shapes so this file type-checks without pulling @cloudflare/workers-types
// into the Node build. The real bindings are provided by the Workers runtime.
export interface DOState {
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
  blockConcurrencyWhile(fn: () => Promise<void>): void;
}
export interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
export interface DOStub {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}
export interface WorkerEnv {
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  CHAT_DO: DONamespace;
  DB?: unknown; // D1 binding (app data); see AGENTS.md
  BOT_TELEMETRY_URL?: string;
  BOT_TELEMETRY_SECRET?: string;
  BOT_TELEMETRY_SALT?: string;
}

interface Reminder {
  at: number; // epoch ms
  chatId: number | string;
  text: string;
}

interface DailySummaryTask {
  at: number;
  chatId: number | string;
  kind: "daily-summary";
}

type ScheduledTask = Reminder | DailySummaryTask;

/**
 * createDurableSessionStorage — a grammY StorageAdapter that routes each session
 * key to its own ChatDO instance. Pass to buildBot({ storage }) in the Worker.
 */
export function createDurableSessionStorage<T>(env: WorkerEnv): StorageAdapter<T> {
  const stub = (key: string): DOStub => {
    // A missing binding otherwise surfaces as the opaque "Cannot read
    // properties of undefined (reading 'get')" — live: canary #2 shipped with
    // the binding misnamed CHATDO and every update threw exactly that.
    if (!env.CHAT_DO) {
      throw new Error(
        "CHAT_DO Durable Object binding is missing — the deploy must bind class ChatDO as CHAT_DO (see cf.meta.json)",
      );
    }
    return env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + key));
  };
  return {
    async read(key: string): Promise<T | undefined> {
      const r = await stub(key).fetch("https://do/session", { method: "GET" });
      if (r.status === 204) return undefined;
      return (await r.json()) as T;
    },
    async write(key: string, value: T): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "PUT", body: JSON.stringify(value) });
    },
    async delete(key: string): Promise<void> {
      await stub(key).fetch("https://do/session", { method: "DELETE" });
    },
  };
}

/**
 * remindAt — schedule a one-shot reminder DM for `chatId` at `whenEpochMs`.
 * Backed by the chat's ChatDO alarm; fires within a millisecond of the target
 * even if the Worker was idle. Call from a handler under the Workers runtime
 * (via ctx.env). No-op-safe: a scheduling failure never throws into the update.
 */
export async function remindAt(
  env: WorkerEnv,
  chatId: number | string,
  whenEpochMs: number,
  text: string,
): Promise<void> {
  try {
    const stub = env.CHAT_DO.get(env.CHAT_DO.idFromName("chat:" + chatId));
    await stub.fetch("https://do/remind", {
      method: "POST",
      body: JSON.stringify({ at: whenEpochMs, chatId, text } satisfies Reminder),
    });
  } catch {
    /* best-effort: a reminder we couldn't schedule must not break the reply */
  }
}

async function tg(token: string, method: string, payload: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * ChatDO — the per-chat Durable Object. Its class name is referenced in
 * cf.meta.json (new_sqlite_classes) so the deployer registers the migration.
 * Constructed by the runtime with (state, env).
 */
export class ChatDO {
  constructor(
    private readonly state: DOState,
    private readonly env: WorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Durable domain records. The transfer index and per-transfer dedupe pointer
    // make every lookup bounded; no keyspace scan is ever needed.
    if (url.pathname === "/preference") {
      if (request.method === "GET") {
        const preference = await this.state.storage.get<UserPreference>("preference");
        return preference === undefined ? new Response(null, { status: 404 }) : Response.json(preference);
      }
      if (request.method === "PUT") {
        const preference = (await request.json()) as UserPreference;
        await this.state.storage.put("preference", preference);
        const tasks = (await this.state.storage.get<ScheduledTask[]>("reminders")) ?? [];
        const withoutDaily = tasks.filter((task) => !("kind" in task && task.kind === "daily-summary"));
        if (preference.notificationEnabled) {
          withoutDaily.push({ at: nextScheduledTime(preference.summaryTime, preference.timezone), chatId: preference.adminChatId, kind: "daily-summary" });
        }
        await this.state.storage.put("reminders", withoutDaily);
        await this.rearm(withoutDaily);
        return new Response(null, { status: 204 });
      }
    }

    if (url.pathname === "/transfers" && request.method === "GET") {
      const since = Number(url.searchParams.get("since") ?? "0");
      const ids = (await this.state.storage.get<string[]>("transfer-ids")) ?? [];
      const records = await Promise.all(ids.map((id) => this.state.storage.get<Transfer>(`transfer:${id}`)));
      return Response.json(records.filter((record): record is Transfer => Boolean(record && record.timestamp >= since)).sort((a, b) => b.timestamp - a.timestamp));
    }
    if (url.pathname === "/transfer" && request.method === "POST") {
      const incoming = (await request.json()) as Transfer;
      const fingerprint = transferDedupeKey(incoming);
      const existingId = await this.state.storage.get<string>(`transfer-dedupe:${fingerprint}`);
      if (existingId) {
        const existing = await this.state.storage.get<Transfer>(`transfer:${existingId}`);
        if (existing) {
          existing.sourceLinks = [...new Set([...existing.sourceLinks, ...incoming.sourceLinks])];
          await this.state.storage.put(`transfer:${existingId}`, existing);
          return Response.json(existing);
        }
      }
      if (!incoming.id || !incoming.player || !incoming.fromClub || !incoming.toClub || !Number.isFinite(incoming.timestamp)) {
        return new Response("invalid transfer", { status: 400 });
      }
      const ids = (await this.state.storage.get<string[]>("transfer-ids")) ?? [];
      await this.state.storage.put({
        [`transfer:${incoming.id}`]: { ...incoming, sourceLinks: [...new Set(incoming.sourceLinks)], readBy: incoming.readBy ?? [] },
        [`transfer-dedupe:${fingerprint}`]: incoming.id,
        "transfer-ids": ids.includes(incoming.id) ? ids : [...ids, incoming.id],
      });
      return Response.json(incoming, { status: 201 });
    }
    const transferMatch = /^\/transfer\/([^/]+)(\/read)?$/.exec(url.pathname);
    if (transferMatch) {
      const id = decodeURIComponent(transferMatch[1]);
      const record = await this.state.storage.get<Transfer>(`transfer:${id}`);
      if (!record) return new Response(null, { status: 404 });
      if (transferMatch[2] === "/read" && request.method === "POST") {
        const { chatId } = (await request.json()) as { chatId?: string };
        if (chatId) record.readBy = [...new Set([...record.readBy, chatId])];
        await this.state.storage.put(`transfer:${id}`, record);
        return new Response(null, { status: 204 });
      }
      if (request.method === "GET") return Response.json(record);
    }

    // Session storage (routed here by createDurableSessionStorage).
    if (url.pathname === "/session") {
      if (request.method === "GET") {
        const v = await this.state.storage.get<unknown>("session");
        if (v === undefined) return new Response(null, { status: 204 });
        return Response.json(v);
      }
      if (request.method === "PUT") {
        await this.state.storage.put("session", await request.json());
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        await this.state.storage.delete("session");
        return new Response(null, { status: 204 });
      }
    }

    // Schedule a reminder + (re)arm the alarm to the earliest due one.
    if (url.pathname === "/remind" && request.method === "POST") {
      const rem = (await request.json()) as Reminder;
      const list = (await this.state.storage.get<ScheduledTask[]>("reminders")) ?? [];
      list.push(rem);
      await this.state.storage.put("reminders", list);
      await this.rearm(list);
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  // Fires at the earliest reminder's wall-clock time. Sends every due reminder,
  // drops them, and re-arms for whatever remains.
  async alarm(): Promise<void> {
    const current = now();
    const list = (await this.state.storage.get<ScheduledTask[]>("reminders")) ?? [];
    const due = list.filter((r) => r.at <= current);
    const rest = list.filter((r) => r.at > current);
    for (const r of due) {
      if ("kind" in r && r.kind === "daily-summary") await this.sendDailySummary(r.chatId);
      else if ("text" in r) await tg(this.env.BOT_TOKEN, "sendMessage", { chat_id: r.chatId, text: r.text });
    }
    await this.state.storage.put("reminders", rest);
    await this.rearm(rest);
  }

  private async rearm(list: ScheduledTask[]): Promise<void> {
    if (list.length === 0) return;
    const next = Math.min(...list.map((r) => r.at));
    const current = await this.state.storage.getAlarm();
    if (current === null || next < current) {
      await this.state.storage.setAlarm(next);
    }
  }

  private async sendDailySummary(chatId: number | string): Promise<void> {
    const preference = await this.state.storage.get<UserPreference>("preference");
    if (!preference?.notificationEnabled) return;
    const global = this.env.CHAT_DO.get(this.env.CHAT_DO.idFromName("transfer-tracker"));
    const summarySince = preference.lastSummaryAt;
    const response = await global.fetch(`https://do/transfers?since=${summarySince}`);
    const transfers = response.ok ? ((await response.json()) as Transfer[]) : [];
    const text = summaryText(transfers, "Daily transfer summary", 0);
    const buttons = transfers.slice(0, 15).flatMap((transfer) => [
      [
        { text: "Details", callback_data: `tr:detail:${transfer.id}` },
        { text: "Source", callback_data: `tr:source:${transfer.id}` },
        { text: "Mark as read", callback_data: `tr:read:${transfer.id}` },
      ],
    ]);
    if (transfers.length > 15) buttons.push([{ text: "Next", callback_data: `daily:${summarySince}:1` }]);
    await tg(this.env.BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    });
    preference.lastSummaryAt = now();
    await this.state.storage.put("preference", preference);
    const next = nextScheduledTime(preference.summaryTime, preference.timezone);
    const all = (await this.state.storage.get<ScheduledTask[]>("reminders")) ?? [];
    all.push({ at: next, chatId, kind: "daily-summary" });
    await this.state.storage.put("reminders", all);
    await this.rearm(all);
  }
}
