import { extract as pinterest } from "./pinterest.js";
import { extract as facebook } from "./facebook.js";
import { extract as twitter } from "./twitter.js";
import { extract as tiktok } from "./tiktok.js";
import { extract as instagram } from "./instagram.js";
import { extract as youtube } from "./youtube.js";
import { extract as likee } from "./likee.js";
export const extractors = {
  Pinterest: pinterest,
  Facebook: facebook,
  "X / Twitter": twitter,
  TikTok: tiktok,
  Instagram: instagram,
  YouTube: youtube,
  Likee: likee,
};
