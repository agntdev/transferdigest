import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { setSubscription } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.command("unsubscribe", async (ctx) => setSubscription(ctx, false));

export default composer;
