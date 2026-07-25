import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { explainMarkRead } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.callbackQuery("transfer:mark_read", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainMarkRead(ctx);
});

export default composer;
