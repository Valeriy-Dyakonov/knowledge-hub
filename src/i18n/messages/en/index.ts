import type { ru } from "../ru";
import { common } from "./common";
import { errors } from "./errors";
import { features } from "./features";
import { repos } from "./repos";
import { review } from "./review";
import { run } from "./run";
import { settings } from "./settings";
import { shell } from "./shell";

export const en: typeof ru = { common, errors, features, repos, review, run, settings, shell };
