import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  defaultPreference,
  detailText,
  getPreference,
  getTransfer,
  listTransfersSince,
  markTransferRead,
  parseIsoDay,
  savePreference,
  summaryText,
  utcDayStart,
  type DomainEnv,
  type Transfer,
} from "../transfer-domain.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, urlButton } from "../toolkit/index.js";

registerMainMenuItem({ label: "Today", data: "today:show", order: 10 });
registerMainMenuItem({ label: "Transfers since", data: "since:prompt", order: 20 });
registerMainMenuItem({ label: "Daily summary", data: "subscription:show", order: 30 });

type FlowSession = { awaiting?: "since" | "detail" | "summary-time" | "timezone" };
const composer = new Composer<Ctx>();
const envFor = (ctx: Ctx): DomainEnv | undefined => (ctx as unknown as { env?: DomainEnv }).env;
const chatIdFor = (ctx: Ctx) => String(ctx.chat?.id ?? ctx.from?.id ?? "");

function controls(transfers: Transfer[], page: number, scope: string) {
  const pageTransfers = transfers.slice(page * 15, page * 15 + 15);
  const rows = pageTransfers.flatMap((transfer) => [[
    inlineButton("Details", `tr:detail:${transfer.id}`),
    inlineButton("Source", `tr:source:${transfer.id}`),
    inlineButton("Mark as read", `tr:read:${transfer.id}`),
  ]]);
  const pages = Math.ceil(transfers.length / 15);
  const nav = [];
  if (page > 0) nav.push(inlineButton("Previous", `${scope}:${page - 1}`));
  if (page + 1 < pages) nav.push(inlineButton("Next", `${scope}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([inlineButton("Back to menu", "menu:main")]);
  return inlineKeyboard(rows);
}

async function showSummary(ctx: Ctx, since: number, title: string, page: number, scope: string, edit = false) {
  const transfers = await listTransfersSince(envFor(ctx), since);
  const text = summaryText(transfers, title, page);
  const options = { parse_mode: "HTML" as const, reply_markup: controls(transfers, page, scope) };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export async function showToday(ctx: Ctx, page = 0, edit = false) {
  await showSummary(ctx, utcDayStart(), "Today’s transfers", page, "today:page", edit);
}

composer.command("today", async (ctx) => showToday(ctx));
composer.callbackQuery("today:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showToday(ctx, 0, true);
});
composer.callbackQuery(/^today:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showToday(ctx, Number(ctx.match[1]), true);
});
composer.callbackQuery(/^daily:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const since = Number(ctx.match[1]);
  await showSummary(ctx, since, "Daily transfer summary", Number(ctx.match[2]), `daily:${since}`, true);
});

async function showSince(ctx: Ctx, raw: string, page = 0, edit = false) {
  const since = parseIsoDay(raw);
  if (since === undefined) {
    await ctx.reply("Use a date like 2026-07-25, then try again.");
    return;
  }
  await showSummary(ctx, since, `Transfers since ${raw}`, page, `since:page:${raw}`, edit);
}

composer.command("since", async (ctx) => {
  const raw = ctx.match?.trim() ?? "";
  if (!raw) {
    (ctx.session as FlowSession).awaiting = "since";
    await ctx.reply("Send the starting date as YYYY-MM-DD.");
    return;
  }
  await showSince(ctx, raw);
});
composer.callbackQuery("since:prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  (ctx.session as FlowSession).awaiting = "since";
  await ctx.reply("Send the starting date as YYYY-MM-DD.");
});
composer.callbackQuery(/^since:page:(\d{4}-\d{2}-\d{2}):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSince(ctx, ctx.match[1], Number(ctx.match[2]), true);
});

async function showDetail(ctx: Ctx, id: string, edit = false) {
  const transfer = await getTransfer(envFor(ctx), id);
  if (!transfer) {
    await ctx.reply("That transfer is no longer available.");
    return;
  }
  const buttons = [
    [inlineButton("Mark as read", `tr:read:${transfer.id}`)],
    ...transfer.sourceLinks.map((link, index) => [urlButton(`Source ${index + 1}`, link)]),
    [inlineButton("Back to menu", "menu:main")],
  ];
  const options = { parse_mode: "HTML" as const, reply_markup: inlineKeyboard(buttons) };
  if (edit) await ctx.editMessageText(detailText(transfer), options);
  else await ctx.reply(detailText(transfer), options);
}

export async function requestDetail(ctx: Ctx) {
  const id = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!id) {
    (ctx.session as FlowSession).awaiting = "detail";
    await ctx.reply("Send the transfer reference from its summary.");
    return;
  }
  await showDetail(ctx, id);
}
export async function explainDetail(ctx: Ctx) {
  await ctx.reply("Open a transfer from a summary to view its full details.");
}
composer.command("detail", requestDetail);
composer.callbackQuery(/^tr:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showDetail(ctx, ctx.match[1], true);
});
// Kept for the documented callback entry point when a stale summary has no id.
composer.callbackQuery("transfer:detail", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainDetail(ctx);
});

composer.callbackQuery(/^tr:read:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const changed = await markTransferRead(envFor(ctx), ctx.match[1], chatIdFor(ctx));
  await ctx.reply(changed ? "Marked as read." : "That transfer is no longer available.");
});
composer.callbackQuery(/^tr:source:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const transfer = await getTransfer(envFor(ctx), ctx.match[1]);
  if (!transfer || transfer.sourceLinks.length === 0) {
    await ctx.reply("No source link is available for that transfer.");
    return;
  }
  await ctx.reply("Choose a source.", {
    reply_markup: inlineKeyboard(transfer.sourceLinks.map((link, index) => [urlButton(`Source ${index + 1}`, link)])),
  });
});
composer.callbackQuery("transfer:mark_read", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainMarkRead(ctx);
});
export async function explainMarkRead(ctx: Ctx) {
  await ctx.reply("Open a transfer from a summary to mark it as read.");
}
export async function explainSource(ctx: Ctx) {
  await ctx.reply("Open a transfer’s details to see its source links.");
}
composer.callbackQuery("transfer:source", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainSource(ctx);
});

async function preferenceFor(ctx: Ctx) {
  const chatId = chatIdFor(ctx);
  return (await getPreference(envFor(ctx), chatId)) ?? defaultPreference(chatId);
}

export async function setSubscription(ctx: Ctx, enabled: boolean) {
  const preference = await preferenceFor(ctx);
  preference.notificationEnabled = enabled;
  const saved = await savePreference(envFor(ctx), preference);
  if (!saved) {
    await ctx.reply("Daily summaries aren’t set up yet. Add the bot’s durable storage, then try again.");
    return;
  }
  await ctx.reply(enabled ? `Daily summaries are on for ${preference.summaryTime} ${preference.timezone}.` : "Daily summaries are off.");
}

composer.command("subscribe", async (ctx) => setSubscription(ctx, true));
composer.command("unsubscribe", async (ctx) => setSubscription(ctx, false));
composer.callbackQuery("subscription:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  const preference = await preferenceFor(ctx);
  await ctx.editMessageText(
    preference.notificationEnabled
      ? `Your daily summary is on for ${preference.summaryTime} ${preference.timezone}.`
      : "Your daily summary is off.",
    { reply_markup: inlineKeyboard([
      [inlineButton(preference.notificationEnabled ? "Turn off" : "Turn on", preference.notificationEnabled ? "subscription:off" : "subscription:on")],
      [inlineButton("Set summary time", "subscription:time"), inlineButton("Set timezone", "subscription:timezone")],
      [inlineButton("Back to menu", "menu:main")],
    ]) },
  );
});
composer.callbackQuery("subscription:on", async (ctx) => { await ctx.answerCallbackQuery(); await setSubscription(ctx, true); });
composer.callbackQuery("subscription:off", async (ctx) => { await ctx.answerCallbackQuery(); await setSubscription(ctx, false); });
composer.callbackQuery("subscription:time", async (ctx) => {
  await ctx.answerCallbackQuery();
  (ctx.session as FlowSession).awaiting = "summary-time";
  await ctx.reply("Send the daily summary time as HH:MM, for example 08:00.");
});
composer.callbackQuery("subscription:timezone", async (ctx) => {
  await ctx.answerCallbackQuery();
  (ctx.session as FlowSession).awaiting = "timezone";
  await ctx.reply("Send your IANA timezone, for example Europe/London.");
});

composer.on("message:text", async (ctx, next) => {
  const state = ctx.session as FlowSession;
  if (!state.awaiting || ctx.message.text.startsWith("/")) return next();
  const awaiting = state.awaiting;
  delete state.awaiting;
  const input = ctx.message.text.trim();
  if (awaiting === "since") await showSince(ctx, input);
  else if (awaiting === "detail") await showDetail(ctx, input);
  else if (awaiting === "summary-time") {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input)) {
      await ctx.reply("Use a time like 08:00, then try again.");
      return;
    }
    const preference = await preferenceFor(ctx);
    preference.summaryTime = input;
    const saved = await savePreference(envFor(ctx), preference);
    await ctx.reply(saved ? `Daily summaries will arrive at ${input} ${preference.timezone}.` : "Daily summaries aren’t set up yet. Add the bot’s durable storage, then try again.");
  } else {
    try { new Intl.DateTimeFormat("en", { timeZone: input }); } catch {
      await ctx.reply("That timezone isn’t recognised. Try one like Europe/London.");
      return;
    }
    const preference = await preferenceFor(ctx);
    preference.timezone = input;
    const saved = await savePreference(envFor(ctx), preference);
    await ctx.reply(saved ? `Your timezone is set to ${input}.` : "Daily summaries aren’t set up yet. Add the bot’s durable storage, then try again.");
  }
});

export default composer;
