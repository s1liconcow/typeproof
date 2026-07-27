import { exportPublicJwk, generateSigningKey, objectDigest, publicKeyId, signObject } from "../packages/proof-core/crypto.mjs";
import { PROTOCOL_VERSION, EXTENSION_VERSION } from "../packages/proof-core/protocol.mjs";
import { computeEventChainRoot } from "../packages/proof-core/verify.mjs";
import { chooseCertifiedRanges } from "../packages/proof-core/replay.mjs";
import { SessionStore } from "../apps/backend/src/session-store.mjs";
import { createProofService } from "../apps/backend/src/service.mjs";

export async function createHarness() {
  const witnessPair = await generateSigningKey(false);
  const witnessPublicKey = await exportPublicJwk(witnessPair.publicKey);
  const witnessKey = {
    privateKey: witnessPair.privateKey,
    publicKey: witnessPublicKey,
    keyId: await publicKeyId(witnessPublicKey)
  };
  const clock = { value: Date.now() };
  const service = createProofService({
    witnessKey,
    sessions: new SessionStore(),
    challengeTtlMs: 60 * 60 * 1000,
    now: () => clock.value
  });
  return { service, witnessKey, clock };
}

export async function createRecorderIdentity() {
  const pair = await generateSigningKey(false);
  const publicKey = await exportPublicJwk(pair.publicKey);
  return { pair, publicKey, keyId: await publicKeyId(publicKey) };
}

export function typingEvents(text, intervalMs = 80) {
  const events = [];
  let offset = 0;
  for (const character of Array.from(text)) {
    const lineBreak = character === "\n";
    events.push({
      sequence: events.length,
      deltaMs: intervalMs,
      inputType: lineBreak ? "insertLineBreak" : "insertText",
      data: lineBreak ? null : character,
      selectionStart: offset,
      selectionEnd: offset,
      trusted: true,
      key: {
        key: lineBreak ? "Enter" : character,
        code: lineBreak ? "Enter" : codeFor(character),
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: character.toUpperCase() === character && character.toLowerCase() !== character,
        repeat: false
      }
    });
    offset += character.length;
  }
  return events;
}

export async function createUnsignedEnvelope(harness, options = {}) {
  const identity = options.identity || await createRecorderIdentity();
  const origin = options.origin || "https://example.test";
  const challengeResponse = await harness.service.createSession({
    protocolVersion: PROTOCOL_VERSION,
    recorder: { publicKey: identity.publicKey, keyId: identity.keyId },
    context: { origin }
  });
  const text = options.text ?? "Human words";
  const events = options.events || typingEvents(text);
  const startedAt = new Date(harness.clock.value + 1000).toISOString();
  const endedAt = new Date(harness.clock.value + 1000 + events.reduce((sum, event) => sum + event.deltaMs, 0) + 250).toISOString();
  const claim = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: challengeResponse.challenge.payload.sessionId,
    nonce: challengeResponse.challenge.payload.nonce,
    recorder: { publicKey: identity.publicKey, keyId: identity.keyId, extensionVersion: EXTENSION_VERSION },
    context: { origin, fieldKind: "textarea" },
    startedAt,
    endedAt,
    initialText: "",
    finalText: text,
    events,
    violations: [],
    eventChainRoot: await computeEventChainRoot(events),
    witnessChallenge: challengeResponse.challenge
  };
  claim.certifiedRanges = chooseCertifiedRanges(claim);
  const envelope = { protocolVersion: PROTOCOL_VERSION, claim, deviceSignature: await signObject(identity.pair.privateKey, claim) };
  let checkpointRoot = "typeproof:event-chain:v1";
  harness.clock.value += 1000;
  for (const event of options.skipCheckpoints ? [] : events) {
    checkpointRoot = await objectDigest({ previous: checkpointRoot, event });
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: claim.sessionId,
      nonce: claim.nonce,
      sequence: event.sequence,
      eventChainRoot: checkpointRoot
    };
    await harness.service.checkpointSession(claim.sessionId, {
      payload,
      signature: await signObject(identity.pair.privateKey, payload)
    });
    harness.clock.value += options.checkpointIntervalMs ?? event.deltaMs;
  }
  return { identity, challengeResponse, envelope };
}

export async function finalizeProof(harness, bundle) {
  harness.clock.value += 5000;
  const { receipt } = await harness.service.finalizeSession(bundle.envelope.claim.sessionId, bundle.envelope);
  return {
    ...bundle.envelope,
    witness: { serverPublicKey: bundle.challengeResponse.serverPublicKey, receipt }
  };
}

function codeFor(character) {
  if (/^[a-z]$/iu.test(character)) return `Key${character.toUpperCase()}`;
  if (/^[0-9]$/u.test(character)) return `Digit${character}`;
  if (character === " ") return "Space";
  return "IntlBackslash";
}
