import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { showToday } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.command("today", async (ctx) => showToday(ctx));

export default composer;
