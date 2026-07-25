import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { explainSource } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.callbackQuery("transfer:source", async (ctx) => {
  await ctx.answerCallbackQuery();
  await explainSource(ctx);
});

export default composer;
