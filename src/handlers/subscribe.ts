import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { setSubscription } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.command("subscribe", async (ctx) => setSubscription(ctx, true));

export default composer;
