import assert from "node:assert/strict";
import test from "node:test";
import { objectDigest, signObject } from "../packages/proof-core/crypto.mjs";
import { computeEventChainRoot, verifyProof } from "../packages/proof-core/verify.mjs";
import { ServiceError } from "../apps/backend/src/service.mjs";
import { createHarness, createUnsignedEnvelope, finalizeProof, typingEvents } from "./helpers.mjs";

test("witness accepts a valid signed transcript and independent verifier passes every check", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness, { text: "Typed by hand" });
  const proof = await finalizeProof(harness, bundle);
  const verification = await verifyProof(proof, { trustedServerKeyId: harness.witnessKey.keyId });

  assert.equal(verification.valid, true);
  assert.equal(verification.verdict, "valid_observed_typing");
  assert.equal(verification.content, "Typed by hand");
  assert.ok(verification.checks.every((check) => check.ok));
});

test("witness accepts autocorrect and returns the complete document with every typed range", async () => {
  const harness = await createHarness();
  const events = typingEvents("teh rest");
  events.push({
    sequence: events.length,
    deltaMs: 80,
    inputType: "observedMutation",
    browserInputType: null,
    data: "he",
    selectionStart: 1,
    selectionEnd: 3,
    trusted: false,
    key: null,
    source: "dom-mutation"
  });
  const proof = await finalizeProof(harness, await createUnsignedEnvelope(harness, { text: "the rest", events }));
  const verification = await verifyProof(proof, { trustedServerKeyId: harness.witnessKey.keyId });

  assert.equal(verification.valid, true);
  assert.equal(verification.documentContent, "the rest");
  assert.equal(verification.content, "the rest");
  assert.deepEqual(verification.typedRanges, [{ start: 0, end: 1 }, { start: 3, end: 8 }]);
  assert.equal(verification.metrics.typedCharacterCount, 6);
  assert.equal(verification.metrics.documentCharacterCount, 8);
  assert.equal(verification.metrics.typedEventCount, 8);
  assert.equal(verification.metrics.observedEditCount, 1);
  assert.match(verification.summary, /1 editor-assisted change/u);
});

test("witness rejects a claim that omits a typed range split by autocorrect", async () => {
  const harness = await createHarness();
  const events = typingEvents("teh rest");
  events.push({
    sequence: events.length,
    deltaMs: 80,
    inputType: "observedMutation",
    browserInputType: null,
    data: "he",
    selectionStart: 1,
    selectionEnd: 3,
    trusted: false,
    key: null,
    source: "dom-mutation"
  });
  const bundle = await createUnsignedEnvelope(harness, { text: "the rest", events });
  bundle.envelope.claim.certifiedRanges = [{ start: 3, end: 8 }];
  bundle.envelope.deviceSignature = await signObject(bundle.identity.pair.privateKey, bundle.envelope.claim);
  harness.clock.value += 5000;

  await assert.rejects(
    harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope),
    (error) => error instanceof ServiceError && error.status === 422 &&
      error.details.checks.some((check) => check.name === "certified-content" && !check.ok)
  );
});

test("changing signed content after receipt breaks signatures and receipt binding", async () => {
  const harness = await createHarness();
  const proof = await finalizeProof(harness, await createUnsignedEnvelope(harness, { text: "original" }));
  proof.claim.finalText = "changed";
  const verification = await verifyProof(proof, { trustedServerKeyId: harness.witnessKey.keyId });
  assert.equal(verification.valid, false);
  assert.equal(verification.checks.find((check) => check.name === "device-signature").ok, false);
  assert.equal(verification.checks.find((check) => check.name === "receipt-binding").ok, false);
});

test("a witness-signed receipt cannot omit a typed range from its content binding", async () => {
  const harness = await createHarness();
  const proof = await finalizeProof(harness, await createUnsignedEnvelope(harness, { text: "bound ranges" }));
  proof.witness.receipt.payload.certifiedRanges = [{ start: 1, end: 12 }];
  proof.witness.receipt.signature = await signObject(harness.witnessKey.privateKey, proof.witness.receipt.payload);
  const verification = await verifyProof(proof, { trustedServerKeyId: harness.witnessKey.keyId });

  assert.equal(verification.valid, false);
  assert.equal(verification.checks.find((check) => check.name === "receipt-signature").ok, true);
  assert.equal(verification.checks.find((check) => check.name === "certified-content-binding").ok, false);
});

test("verifier retains support for protocol 1.4 single-range proofs", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness, { text: "legacy proof" });
  const proof = structuredClone(await finalizeProof(harness, bundle));
  proof.protocolVersion = "1.4";
  proof.claim.protocolVersion = "1.4";
  proof.claim.witnessChallenge.payload.protocolVersion = "1.4";
  proof.claim.witnessChallenge.signature = await signObject(
    harness.witnessKey.privateKey,
    proof.claim.witnessChallenge.payload
  );
  proof.claim.certifiedRange = { start: 0, end: proof.claim.finalText.length };
  delete proof.claim.certifiedRanges;
  proof.deviceSignature = await signObject(bundle.identity.pair.privateKey, proof.claim);
  const envelope = { protocolVersion: proof.protocolVersion, claim: proof.claim, deviceSignature: proof.deviceSignature };
  Object.assign(proof.witness.receipt.payload, {
    protocolVersion: "1.4",
    proofDigest: await objectDigest(envelope),
    contentDigest: await objectDigest({ text: proof.claim.finalText }),
    certifiedRange: proof.claim.certifiedRange
  });
  delete proof.witness.receipt.payload.documentDigest;
  delete proof.witness.receipt.payload.certifiedRanges;
  delete proof.witness.receipt.payload.typedCharacterCount;
  proof.witness.receipt.signature = await signObject(harness.witnessKey.privateKey, proof.witness.receipt.payload);

  const verification = await verifyProof(proof, { trustedServerKeyId: harness.witnessKey.keyId });
  assert.equal(verification.valid, true, JSON.stringify(verification.checks.filter((check) => !check.ok)));
  assert.equal(verification.content, "legacy proof");
});

test("even a correctly re-signed paste transcript is rejected by the witness", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness, { text: "x" });
  bundle.envelope.claim.events[0].inputType = "insertFromPaste";
  bundle.envelope.claim.eventChainRoot = await computeEventChainRoot(bundle.envelope.claim.events);
  bundle.envelope.deviceSignature = await signObject(bundle.identity.pair.privateKey, bundle.envelope.claim);
  harness.clock.value += 5000;

  await assert.rejects(
    harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope),
    (error) => error instanceof ServiceError && error.status === 422 && error.details.checks.some((check) => check.name === "transcript" && !check.ok)
  );
});

test("a signed batch without live checkpoints cannot be finalized", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness, { text: "batch only", skipCheckpoints: true });
  harness.clock.value += 5000;
  await assert.rejects(
    harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope),
    (error) => error instanceof ServiceError && error.status === 422 &&
      error.details.checks.some((check) => check.name === "live-checkpoints" && !check.ok)
  );
});

test("an implausibly instantaneous checkpoint burst is rejected", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness, { text: "too fast", checkpointIntervalMs: 0 });
  harness.clock.value += 5000;
  await assert.rejects(
    harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope),
    (error) => error instanceof ServiceError && error.status === 422 &&
      error.details.checks.some((check) => check.name === "checkpoint-pace" && !check.ok)
  );
});

test("a one-time session is idempotent only for the identical signed envelope", async () => {
  const harness = await createHarness();
  const bundle = await createUnsignedEnvelope(harness);
  harness.clock.value += 5000;
  const first = await harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope);
  const retry = await harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.receipt, first.receipt);

  const changed = structuredClone(bundle.envelope);
  changed.deviceSignature = changed.deviceSignature.slice(0, -1) + (changed.deviceSignature.endsWith("A") ? "B" : "A");
  await assert.rejects(
    harness.service.finalizeSession(bundle.envelope.claim.sessionId, changed),
    (error) => error instanceof ServiceError && error.status === 409
  );
});

test("an otherwise valid proof fails against a different witness trust anchor", async () => {
  const harness = await createHarness();
  const other = await createHarness();
  const proof = await finalizeProof(harness, await createUnsignedEnvelope(harness));
  const verification = await verifyProof(proof, { trustedServerKeyId: other.witnessKey.keyId });
  assert.equal(verification.valid, false);
  assert.equal(verification.checks.find((check) => check.name === "trusted-witness").ok, false);
});
