import { test } from "node:test";
import assert from "node:assert/strict";
import { derive } from "@telnyx/acp/auth";
import { bearerToken, claimsFor, mayUseFrontDoor, operatorToken } from "../src/auth.ts";

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

test("state streams and RPC need the token: requests without it are refused", async () => {
  const url = "https://agent.example.com/agents/ai-digest/feedback?subscribe=state";
  const good = new Request(url, { headers: { authorization: `Bearer ${await operatorToken(KEY)}` } });
  assert.equal(bearerToken(good), await operatorToken(KEY));
  assert.ok(await mayUseFrontDoor(good, KEY));
  assert.ok(!(await mayUseFrontDoor(new Request(url), KEY)), "anonymous state read refused");
  assert.ok(!(await mayUseFrontDoor(new Request(url, { headers: { authorization: "Bearer nope" } }), KEY)));
  assert.ok(await mayUseFrontDoor(new Request(url), undefined), "no key configured: open");
});

