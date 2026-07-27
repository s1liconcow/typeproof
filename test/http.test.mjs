import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createTypeProofServer } from "../apps/backend/src/server.mjs";
import { loadOrCreateWitnessKey } from "../apps/backend/src/key-store.mjs";
import { createUnsignedEnvelope, finalizeProof } from "./helpers.mjs";

test("reference server exposes health, key metadata, writer, and strict JSON errors", async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "typeproof-http-"));
  const clock = { value: Date.now() };
  const application = await createTypeProofServer({
    config: { host: "127.0.0.1", port: 0, dataDirectory, challengeTtlMs: 60_000, maxBodyBytes: 1_000_000, publicBaseUrl: null },
    now: () => clock.value
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => application.server.close(resolve));
    await rm(dataDirectory, { recursive: true, force: true });
  });
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  assert.deepEqual(await (await fetch(`${baseUrl}/healthz`)).json(), { ok: true });
  const info = await (await fetch(`${baseUrl}/v1/info`)).json();
  assert.equal(info.serverKeyId, application.witnessKey.keyId);
  assert.equal((await loadOrCreateWitnessKey(dataDirectory)).keyId, application.witnessKey.keyId);
  assert.match(await (await fetch(`${baseUrl}/`)).text(), /Independent verifier/u);
  assert.match(await (await fetch(`${baseUrl}/write`)).text(), /Clean writing pad/u);

  const bad = await fetch(`${baseUrl}/v1/sessions`, { method: "POST", body: "not-json" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_json");

  const harness = { service: application.service, witnessKey: application.witnessKey, clock };
  const proof = await finalizeProof(harness, await createUnsignedEnvelope(harness, { text: "public typed text" }));
  const publishedResponse = await fetch(`${baseUrl}/v1/proofs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof)
  });
  assert.equal(publishedResponse.status, 201);
  const published = await publishedResponse.json();
  assert.match(published.id, /^tp_[A-Za-z0-9_-]{22}$/u);
  assert.equal(published.verificationUrl, `${baseUrl}/p/${published.id}`);
  assert.match(published.embedHtml, /<img src=/u);
  assert.match(published.embedMarkdown, /^\[!\[TypeProof/u);

  const duplicate = await (await fetch(`${baseUrl}/v1/proofs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof)
  })).json();
  assert.equal(duplicate.id, published.id);

  const publicRecord = await (await fetch(`${baseUrl}/v1/proofs/${published.id}`)).json();
  assert.equal(publicRecord.verification.valid, true);
  assert.equal(publicRecord.verification.content, "public typed text");
  assert.match(await (await fetch(published.verificationUrl)).text(), /Published verification/u);
  assert.match(await (await fetch(published.badgeUrl)).text(), /verified typing/u);

  const tampered = structuredClone(proof);
  tampered.claim.finalText += "!";
  const rejectedPublication = await fetch(`${baseUrl}/v1/proofs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tampered)
  });
  assert.equal(rejectedPublication.status, 422);
});
