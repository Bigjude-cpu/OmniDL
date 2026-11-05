import test from "node:test";
import assert from "node:assert/strict";
import { verifyWebhookSecret } from "../src/telegram.js";

test("Telegram webhook secret comparison rejects missing and mismatched values", () => {
  assert.equal(verifyWebhookSecret(undefined, "a-long-random-secret-value"), false);
  assert.equal(verifyWebhookSecret("wrong-secret", "a-long-random-secret-value"), false);
  assert.equal(verifyWebhookSecret("short", "short"), false);
  assert.equal(
    verifyWebhookSecret("a-long-random-secret-value", "a-long-random-secret-value"),
    true,
  );
});
