/** _intro_test.mjs - validate ffmpeg syntax for the FOM intro card before spending Fal $$ */
import { buildIntroCard } from "./video.mjs";
const path = await buildIntroCard();
console.log("intro built ok:", path);
