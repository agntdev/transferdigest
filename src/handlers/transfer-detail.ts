import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { explainDetail } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.callbackQuery("transfer:detail", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainDetail(ctx);
});

export default composer;
