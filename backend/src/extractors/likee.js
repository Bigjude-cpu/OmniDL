import { videoMetadata } from "./common.js";

export async function extract(url, proxy, signal) {
  return videoMetadata(url, proxy, signal);
}
