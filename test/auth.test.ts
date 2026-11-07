import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "@telnyx/acp/auth";
import { claimsFor, operatorToken } from "../src/auth.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("the operator token matches the telnyx-acp CLI's derivation", async () => {
  assert.equal(await operatorToken(KEY), derive(KEY, "operator"));
});

test("with an auth key: only the operator token gets read and rpc", async () => {
  assert.deepEqual(await claimsFor(await operatorToken(KEY), KEY), ["read", "rpc"]);
  assert.deepEqual(await claimsFor(undefined, KEY), [], "no token: refused");
  assert.deepEqual(await claimsFor("not-the-token", KEY), [], "wrong token: refused");
  assert.deepEqual(await claimsFor(await operatorToken("another-key"), KEY), [], "token for another key: refused");
});

test("without an auth key configured the agent stays open (no lock-out)", async () => {
  assert.deepEqual(await claimsFor(undefined, undefined), ["read", "rpc"]);
});
