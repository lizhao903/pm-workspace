// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import type { ChapterDef } from "./types";
import Fog from "../chapters/01-fog/Fog";
import { narrations as fogNarrations } from "../chapters/01-fog/narrations";
import AskAi from "../chapters/02-ask-ai/AskAi";
import { narrations as askAiNarrations } from "../chapters/02-ask-ai/narrations";
import SkyToStone from "../chapters/03-sky-to-stone/SkyToStone";
import { narrations as skyToStoneNarrations } from "../chapters/03-sky-to-stone/narrations";
import VerifyMethods from "../chapters/04-verify-methods/VerifyMethods";
import { narrations as verifyMethodsNarrations } from "../chapters/04-verify-methods/narrations";
import GuessWhy from "../chapters/05-guess-why/GuessWhy";
import { narrations as guessWhyNarrations } from "../chapters/05-guess-why/narrations";
import EarthModel from "../chapters/06-earth-model/EarthModel";
import { narrations as earthModelNarrations } from "../chapters/06-earth-model/narrations";
import Beyond from "../chapters/07-beyond/Beyond";
import { narrations as beyondNarrations } from "../chapters/07-beyond/narrations";

/** 七章 37 步，顺序与 outline.md / storyboard.md 一致。 */
export const CHAPTERS: ChapterDef[] = [
  { id: "fog", title: "浓雾里的将军", narrations: fogNarrations, Component: Fog },
  { id: "ask-ai", title: "把问题问清楚", narrations: askAiNarrations, Component: AskAi },
  { id: "sky-to-stone", title: "看天不行，换条路", narrations: skyToStoneNarrations, Component: SkyToStone },
  { id: "verify-methods", title: "三种方法验证", narrations: verifyMethodsNarrations, Component: VerifyMethods },
  { id: "guess-why", title: "为什么会指南北", narrations: guessWhyNarrations, Component: GuessWhy },
  { id: "earth-model", title: "地球内部磁铁假设", narrations: earthModelNarrations, Component: EarthModel },
  { id: "beyond", title: "拓展提升", narrations: beyondNarrations, Component: Beyond },
];
