import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { requestDetail } from "./transfers.js";

const composer = new Composer<Ctx>();

composer.command("detail", requestDetail);

export default composer;
