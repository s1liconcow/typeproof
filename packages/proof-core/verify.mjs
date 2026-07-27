import { objectDigest, publicKeyId, verifyObject } from "./crypto.mjs";
import { CERTIFIED_RANGES_PROTOCOL_VERSIONS, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./protocol.mjs";
import { replayTranscript } from "./replay.mjs";

function check(name, ok, detail) {
  return { name, ok, detail };
}

export async function verifyProof(proof, options = {}) {
  const checks = [];
  if (!proof || typeof proof !== "object") {
    return { valid: false, checks: [check("proof", false, "Proof is not an object")] };
  }

  const proofVersion = proof.protocolVersion;
  const versionOk = SUPPORTED_PROTOCOL_VERSIONS.has(proofVersion) && proof.claim?.protocolVersion === proofVersion &&
    proof.claim?.witnessChallenge?.payload?.protocolVersion === proofVersion &&
    proof.witness?.receipt?.payload?.protocolVersion === proofVersion;
  checks.push(check("protocol", versionOk, versionOk ? `Version ${proofVersion}` : "Unsupported or inconsistent protocol version"));

  let expectedRecorderKeyId = null;
  try {
    expectedRecorderKeyId = await publicKeyId(proof.claim?.recorder?.publicKey);
  } catch {
    // Reported by the following two checks.
  }
  const recorderKeyOk = expectedRecorderKeyId !== null && expectedRecorderKeyId === proof.claim?.recorder?.keyId;
  checks.push(check("recorder-key", recorderKeyOk, recorderKeyOk ? expectedRecorderKeyId : "Recorder key ID does not match its public key"));

  const deviceSignatureOk = recorderKeyOk && typeof proof.deviceSignature === "string" &&
    await verifyObject(proof.claim.recorder.publicKey, proof.claim, proof.deviceSignature);
  checks.push(check("device-signature", deviceSignatureOk, deviceSignatureOk ? "Signed claim is intact" : "Invalid recorder signature"));

  const challenge = proof.claim?.witnessChallenge;
  const serverPublicKey = proof.witness?.serverPublicKey;
  let expectedServerKeyId = null;
  try {
    expectedServerKeyId = await publicKeyId(serverPublicKey);
  } catch {
    // Reported below.
  }
  const serverKeyOk = expectedServerKeyId !== null && expectedServerKeyId === challenge?.payload?.serverKeyId;
  checks.push(check("witness-key", serverKeyOk, serverKeyOk ? expectedServerKeyId : "Witness key is missing or inconsistent"));

  const challengeSignatureOk = serverKeyOk && typeof challenge?.signature === "string" &&
    await verifyObject(serverPublicKey, challenge.payload, challenge.signature);
  checks.push(check("challenge-signature", challengeSignatureOk, challengeSignatureOk ? "One-time challenge was signed by the witness" : "Invalid witness challenge"));

  const challengeBound = challenge?.payload?.sessionId === proof.claim?.sessionId &&
    challenge?.payload?.nonce === proof.claim?.nonce &&
    challenge?.payload?.recorderKeyId === proof.claim?.recorder?.keyId &&
    challenge?.payload?.origin === proof.claim?.context?.origin;
  checks.push(check("challenge-binding", challengeBound, challengeBound ? "Challenge binds session, recorder, and origin" : "Challenge does not bind this claim"));

  const issuedAt = Date.parse(challenge?.payload?.issuedAt);
  const expiresAt = Date.parse(challenge?.payload?.expiresAt);
  const startedAt = Date.parse(proof.claim?.startedAt);
  const endedAt = Date.parse(proof.claim?.endedAt);
  const timeOk = [issuedAt, expiresAt, startedAt, endedAt].every(Number.isFinite) &&
    issuedAt <= startedAt && startedAt <= endedAt && endedAt <= expiresAt;
  checks.push(check("time-window", timeOk, timeOk ? "Recording fits inside the witnessed time window" : "Recording timestamps are invalid or outside the challenge window"));

  const replay = replayTranscript(proof.claim);
  checks.push(check("transcript", replay.ok, replay.message));

  const usesCertifiedRanges = CERTIFIED_RANGES_PROTOCOL_VERSIONS.has(proofVersion);
  const certifiedContentOk = replay.ok && (usesCertifiedRanges
    ? replay.certifiedRangesOk && replay.typedCharacterCount > 0
    : replay.certifiedRangeOk && typeof replay.certifiedText === "string" && replay.certifiedText.length > 0);
  checks.push(check("certified-content", certifiedContentOk, certifiedContentOk
    ? usesCertifiedRanges
      ? "Every claimed typed range exactly matches the replayed keyboard provenance"
      : "Every character in the certified excerpt originated in accepted keyboard events"
    : usesCertifiedRanges
      ? "The claimed typed ranges do not exactly match replayed keyboard provenance or are empty"
      : "The claimed excerpt includes unwitnessed characters or is empty"));

  const wallDurationMs = endedAt - startedAt;
  const transcriptTimingOk = replay.ok && replay.elapsedMs <= wallDurationMs + 2000;
  checks.push(check("transcript-timing", transcriptTimingOk, transcriptTimingOk ? "Monotonic event time fits inside the recording window" : "Event timing exceeds the recording window"));

  let chainOk = false;
  try {
    chainOk = proof.claim?.eventChainRoot === await computeEventChainRoot(proof.claim.events);
  } catch {
    chainOk = false;
  }
  checks.push(check("event-chain", chainOk, chainOk ? "Event-chain root matches" : "Event-chain root is invalid"));

  const receipt = proof.witness?.receipt;
  const signedEnvelope = {
    protocolVersion: proof.protocolVersion,
    claim: proof.claim,
    deviceSignature: proof.deviceSignature
  };
  let digestOk = false;
  try {
    digestOk = receipt?.payload?.proofDigest === await objectDigest(signedEnvelope);
  } catch {
    digestOk = false;
  }
  checks.push(check("receipt-binding", digestOk, digestOk ? "Receipt binds this exact signed proof" : "Receipt does not match this proof"));

  const receiptSignatureOk = serverKeyOk && typeof receipt?.signature === "string" &&
    await verifyObject(serverPublicKey, receipt.payload, receipt.signature);
  checks.push(check("receipt-signature", receiptSignatureOk, receiptSignatureOk ? "Witness receipt signature is valid" : "Invalid witness receipt"));

  const receiptAccepted = receipt?.payload?.accepted === true && receipt?.payload?.sessionId === proof.claim?.sessionId &&
    receipt?.payload?.serverKeyId === expectedServerKeyId;
  checks.push(check("witness-verdict", receiptAccepted, receiptAccepted ? "Witness independently accepted the transcript" : "Witness did not accept this transcript"));

  let contentDigestOk = false;
  try {
    contentDigestOk = certifiedContentOk && (usesCertifiedRanges
      ? receipt?.payload?.documentDigest === await objectDigest({ text: replay.reconstructedText }) &&
        rangesEqual(receipt?.payload?.certifiedRanges, proof.claim.certifiedRanges) &&
        receipt?.payload?.typedCharacterCount === replay.typedCharacterCount
      : receipt?.payload?.contentDigest === await objectDigest({ text: replay.certifiedText }) &&
        receipt?.payload?.certifiedRange?.start === proof.claim.certifiedRange.start &&
        receipt?.payload?.certifiedRange?.end === proof.claim.certifiedRange.end);
  } catch {
    contentDigestOk = false;
  }
  checks.push(check("certified-content-binding", contentDigestOk, contentDigestOk
    ? usesCertifiedRanges
      ? "Receipt binds the complete document and its exact typed ranges"
      : "Receipt binds the exact certified excerpt"
    : "Receipt content binding is invalid"));

  const checkpointsOk = replay.ok && replay.eventCount > 0 && receipt?.payload?.checkpointCount === replay.eventCount &&
    Number.isSafeInteger(receipt?.payload?.checkpointSpanMs) && receipt.payload.checkpointSpanMs >= 0;
  checks.push(check("live-checkpoints", checkpointsOk, checkpointsOk ? "Witness received a signed rolling commitment for every edit" : "Receipt lacks a complete live checkpoint timeline"));

  const assistedMetricsOk = !["1.4", ...CERTIFIED_RANGES_PROTOCOL_VERSIONS].includes(proofVersion) ||
    (receipt?.payload?.typedEventCount === replay.typedEventCount && receipt?.payload?.observedEditCount === replay.observedEditCount);
  const receiptMetricsOk = replay.ok && receipt?.payload?.eventCount === replay.eventCount && assistedMetricsOk &&
    receipt?.payload?.durationMs === wallDurationMs &&
    receipt?.payload?.checkpointSpanMs >= Math.max(0, (replay.eventCount - 1) * 5);
  checks.push(check("witness-metrics", receiptMetricsOk, receiptMetricsOk ? "Witness timing and event totals match the signed claim" : "Witness metrics are inconsistent or implausibly compressed"));

  let trustedWitness = true;
  if (options.trustedServerKeyId) {
    trustedWitness = expectedServerKeyId === options.trustedServerKeyId;
    checks.push(check("trusted-witness", trustedWitness, trustedWitness ? "Witness matches the configured trust anchor" : "Witness key is not trusted"));
  }

  const valid = checks.every((item) => item.ok) && trustedWitness;
  return {
    valid,
    verdict: valid ? "valid_observed_typing" : "invalid_or_unverified",
    checks,
    summary: valid
      ? usesCertifiedRanges
        ? `The signed transcript reconstructs the complete document and identifies every keyboard-originated range witnessed in the stated time window.${replay.observedEditCount > 0 ? ` ${replay.observedEditCount} editor-assisted change${replay.observedEditCount === 1 ? " was" : "s were"} recorded and excluded from typed provenance.` : ""}`
        : `The signed transcript reconstructs every editor change, and every character in the certified excerpt came from accepted keyboard events witnessed in the stated time window.${replay.observedEditCount > 0 ? ` ${replay.observedEditCount} editor-assisted replacement${replay.observedEditCount === 1 ? " was" : "s were"} recorded and excluded from typed provenance.` : ""}`
      : "One or more cryptographic or transcript checks failed.",
    limitations: [
      "This is evidence about events observed by the extension, not proof of who authored the ideas.",
      "A compromised browser, operating system, extension, or hardware input device can forge or automate trusted-looking input.",
      "A person can retype text produced elsewhere; no cryptographic protocol can determine semantic originality from keystrokes alone."
    ],
    content: certifiedContentOk ? (usesCertifiedRanges ? replay.reconstructedText : replay.certifiedText) : undefined,
    documentContent: replay.ok ? replay.reconstructedText : undefined,
    typedRanges: replay.ok ? replay.certifiedRanges : undefined,
    metrics: replay.ok ? {
      eventCount: replay.eventCount,
      typedEventCount: replay.typedEventCount,
      observedEditCount: replay.observedEditCount,
      typedCharacterCount: replay.typedCharacterCount,
      documentCharacterCount: replay.reconstructedText.length,
      elapsedMs: replay.elapsedMs
    } : undefined
  };
}

function rangesEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((range, index) =>
    range?.start === right[index]?.start && range?.end === right[index]?.end
  );
}

export async function computeEventChainRoot(events) {
  let root = "typeproof:event-chain:v1";
  for (const event of events) root = await objectDigest({ previous: root, event });
  return root;
}
