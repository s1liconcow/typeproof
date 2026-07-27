import { randomBase64Url } from "../../../packages/proof-core/encoding.mjs";
import { objectDigest, publicKeyId, signObject, verifyObject } from "../../../packages/proof-core/crypto.mjs";
import { PROTOCOL_VERSION } from "../../../packages/proof-core/protocol.mjs";
import { replayTranscript } from "../../../packages/proof-core/replay.mjs";
import { computeEventChainRoot, verifyProof } from "../../../packages/proof-core/verify.mjs";

export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createProofService({ witnessKey, sessions, challengeTtlMs, now = () => Date.now() }) {
  async function createSession(request) {
    if (request?.protocolVersion !== PROTOCOL_VERSION) {
      throw new ServiceError(400, "protocol_version", `Expected protocol version ${PROTOCOL_VERSION}`);
    }
    const origin = normalizeOrigin(request?.context?.origin);
    const recorderPublicKey = request?.recorder?.publicKey;
    let recorderKeyId;
    try {
      recorderKeyId = await publicKeyId(recorderPublicKey);
    } catch {
      throw new ServiceError(400, "recorder_key", "A valid P-256 recorder public key is required");
    }
    if (recorderKeyId !== request?.recorder?.keyId) {
      throw new ServiceError(400, "recorder_key", "Recorder key ID does not match the supplied public key");
    }

    const issuedTime = now();
    const id = randomBase64Url(18);
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: id,
      nonce: randomBase64Url(32),
      issuedAt: new Date(issuedTime).toISOString(),
      expiresAt: new Date(issuedTime + challengeTtlMs).toISOString(),
      recorderKeyId,
      origin,
      serverKeyId: witnessKey.keyId
    };
    const challenge = { payload, signature: await signObject(witnessKey.privateKey, payload) };
    sessions.create({ id, recorderPublicKey, challenge, checkpoints: [], finalized: false });
    return { challenge, serverPublicKey: witnessKey.publicKey };
  }

  async function finalizeSession(id, envelope) {
    const session = sessions.get(id);
    if (!session) throw new ServiceError(404, "session_not_found", "The session is unknown or expired");

    const proofDigest = await objectDigest(envelope);
    if (session.finalized) {
      if (session.proofDigest === proofDigest) return { receipt: session.receipt, replayed: true };
      throw new ServiceError(409, "session_used", "The one-time session was already finalized with different content");
    }

    const audit = await auditEnvelope(envelope, session, witnessKey, now());
    if (!audit.valid) {
      throw new ServiceError(422, "proof_rejected", "The signed typing claim did not pass witness verification", { checks: audit.checks });
    }

    const replay = replayTranscript(envelope.claim);
    const receiptPayload = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: id,
      proofDigest,
      documentDigest: await objectDigest({ text: replay.reconstructedText }),
      certifiedRanges: envelope.claim.certifiedRanges,
      typedCharacterCount: replay.typedCharacterCount,
      accepted: true,
      eventCount: replay.eventCount,
      typedEventCount: replay.typedEventCount,
      observedEditCount: replay.observedEditCount,
      checkpointCount: session.checkpoints.length,
      checkpointSpanMs: session.checkpoints.length < 2
        ? 0
        : session.checkpoints.at(-1).receivedAtMs - session.checkpoints[0].receivedAtMs,
      durationMs: Date.parse(envelope.claim.endedAt) - Date.parse(envelope.claim.startedAt),
      witnessedAt: new Date(now()).toISOString(),
      serverKeyId: witnessKey.keyId
    };
    const receipt = { payload: receiptPayload, signature: await signObject(witnessKey.privateKey, receiptPayload) };
    Object.assign(session, { finalized: true, proofDigest, receipt });
    return { receipt, replayed: false };
  }

  async function checkpointSession(id, checkpoint) {
    const session = sessions.get(id);
    if (!session) throw new ServiceError(404, "session_not_found", "The session is unknown or expired");
    if (session.finalized) throw new ServiceError(409, "session_used", "The session is already finalized");
    if (now() > Date.parse(session.challenge.payload.expiresAt)) {
      throw new ServiceError(410, "session_expired", "The witness challenge has expired");
    }

    const payload = checkpoint?.payload;
    const expectedSequence = session.checkpoints.length;
    const bound = payload?.protocolVersion === PROTOCOL_VERSION && payload?.sessionId === id &&
      payload?.nonce === session.challenge.payload.nonce && payload?.sequence === expectedSequence &&
      typeof payload?.eventChainRoot === "string";
    if (!bound) throw new ServiceError(409, "checkpoint_sequence", `Expected checkpoint sequence ${expectedSequence}`);
    if (!await verifyObject(session.recorderPublicKey, payload, checkpoint?.signature)) {
      throw new ServiceError(422, "checkpoint_signature", "Checkpoint signature is invalid");
    }
    session.checkpoints.push({ payload, signature: checkpoint.signature, receivedAtMs: now() });
    return { accepted: true, sequence: expectedSequence, receivedAt: new Date(now()).toISOString() };
  }

  async function verify(proof) {
    return verifyProof(proof, { trustedServerKeyId: witnessKey.keyId });
  }

  return { createSession, checkpointSession, finalizeSession, verify };
}

async function auditEnvelope(envelope, session, witnessKey, currentTime) {
  const checks = [];
  const claim = envelope?.claim;
  checks.push(auditCheck("protocol", envelope?.protocolVersion === PROTOCOL_VERSION && claim?.protocolVersion === PROTOCOL_VERSION));

  let keyIdMatches = false;
  try {
    keyIdMatches = await publicKeyId(claim?.recorder?.publicKey) === session.challenge.payload.recorderKeyId &&
      claim?.recorder?.keyId === session.challenge.payload.recorderKeyId;
  } catch {
    keyIdMatches = false;
  }
  checks.push(auditCheck("recorder-key", keyIdMatches));

  const signatureOk = keyIdMatches && typeof envelope?.deviceSignature === "string" &&
    await verifyObject(session.recorderPublicKey, claim, envelope.deviceSignature);
  checks.push(auditCheck("device-signature", signatureOk));

  const challengeOk = claim?.witnessChallenge?.signature === session.challenge.signature &&
    await verifyObject(witnessKey.publicKey, claim?.witnessChallenge?.payload, claim?.witnessChallenge?.signature);
  checks.push(auditCheck("challenge-signature", challengeOk));

  const payload = session.challenge.payload;
  const bindingOk = claim?.sessionId === payload.sessionId && claim?.nonce === payload.nonce &&
    claim?.context?.origin === payload.origin && claim?.recorder?.keyId === payload.recorderKeyId;
  checks.push(auditCheck("challenge-binding", bindingOk));

  const startedAt = Date.parse(claim?.startedAt);
  const endedAt = Date.parse(claim?.endedAt);
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  const timeOk = [startedAt, endedAt, issuedAt, expiresAt].every(Number.isFinite) &&
    issuedAt <= startedAt && startedAt <= endedAt && endedAt <= expiresAt && currentTime <= expiresAt;
  checks.push(auditCheck("time-window", timeOk));

  const replay = replayTranscript(claim);
  checks.push({ name: "transcript", ok: replay.ok, detail: replay.message });
  checks.push(auditCheck("certified-content", replay.ok && replay.certifiedRangesOk && replay.typedCharacterCount > 0));

  const transcriptTimingOk = replay.ok && replay.elapsedMs <= endedAt - startedAt + 2000;
  checks.push(auditCheck("transcript-timing", transcriptTimingOk));

  let checkpointRoot = "typeproof:event-chain:v1";
  let checkpointsOk = replay.ok && session.checkpoints.length === claim.events.length && claim.events.length > 0;
  if (checkpointsOk) {
    for (let index = 0; index < claim.events.length; index += 1) {
      checkpointRoot = await objectDigest({ previous: checkpointRoot, event: claim.events[index] });
      const checkpoint = session.checkpoints[index].payload;
      if (checkpoint.sequence !== index || checkpoint.eventChainRoot !== checkpointRoot) {
        checkpointsOk = false;
        break;
      }
    }
  }
  checks.push(auditCheck("live-checkpoints", checkpointsOk));
  const checkpointSpanMs = session.checkpoints.length < 2
    ? 0
    : session.checkpoints.at(-1).receivedAtMs - session.checkpoints[0].receivedAtMs;
  const checkpointPaceOk = checkpointsOk && checkpointSpanMs >= Math.max(0, (session.checkpoints.length - 1) * 5);
  checks.push(auditCheck("checkpoint-pace", checkpointPaceOk));

  let chainOk = false;
  try {
    chainOk = claim?.eventChainRoot === await computeEventChainRoot(claim.events);
  } catch {
    chainOk = false;
  }
  checks.push(auditCheck("event-chain", chainOk));

  return { valid: checks.every((check) => check.ok), checks };
}

function auditCheck(name, ok) {
  return { name, ok: Boolean(ok), detail: ok ? "passed" : "failed" };
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new ServiceError(400, "origin", "A valid http(s) page origin is required");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceError(400, "origin", "A valid http(s) page origin is required");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
    throw new ServiceError(400, "origin", "Origin must be an exact http(s) origin without a path");
  }
  return url.origin;
}
