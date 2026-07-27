import { exportPublicJwk, generateSigningKey, objectDigest, publicKeyId, signObject } from "./shared/crypto.mjs";
import { EXTENSION_VERSION, PROTOCOL_VERSION } from "./shared/protocol.mjs";
import { computeEventChainRoot } from "./shared/verify.mjs";
import { chooseCertifiedRanges } from "./shared/replay.mjs";

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const DATABASE_NAME = "typeproof-identity-v1";
const STORE_NAME = "keys";
const RECORDER_MESSAGES = Object.freeze({
  prepare: "TYPEPROOF_RECORDER_PREPARE_V2",
  begin: "TYPEPROOF_RECORDER_BEGIN_V2",
  status: "TYPEPROOF_RECORDER_STATUS_V2",
  stop: "TYPEPROOF_RECORDER_STOP_V2"
});
let checkpointState = null;
const focusedFrames = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (checkpointState?.tabId === tabId) checkpointState = null;
  focusedFrames.delete(tabId);
  chrome.storage.local.get("activeTabId").then(({ activeTabId }) => {
    if (activeTabId === tabId) return chrome.storage.local.remove(["activeTabId", "activeFrameId"]);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") focusedFrames.delete(tabId);
});

async function handleMessage(message, sender) {
  if (message?.type === "TYPEPROOF_FRAME_FOCUSED" && Number.isInteger(sender.tab?.id)) {
    focusedFrames.set(sender.tab.id, sender.frameId);
    return { ok: true };
  }
  if (message?.type === "GET_APP_STATE") return getAppState(message.tabId);
  if (message?.type === "START_RECORDING") return startRecording(
    message.tabId ?? sender.tab?.id,
    Number.isInteger(message.tabId) ? focusedFrames.get(message.tabId) : sender.frameId
  );
  if (message?.type === "STOP_RECORDING") return stopRecording(message.tabId ?? sender.tab?.id);
  if (message?.type === "GET_LAST_PROOF") {
    const { lastProof = null } = await chrome.storage.local.get("lastProof");
    return { ok: true, proof: lastProof };
  }
  if (message?.type === "PUBLISH_LAST_PROOF") return publishLastProof();
  if (message?.type === "SET_SERVER_URL") {
    const serverUrl = validateServerUrl(message.serverUrl);
    await chrome.storage.local.set({ serverUrl });
    return { ok: true, serverUrl };
  }
  if (message?.type === "TYPEPROOF_CHECKPOINT") return queueCheckpoint(message, sender);
  throw new Error("Unknown extension message");
}

async function getAppState(tabId) {
  const storage = await chrome.storage.local.get(["serverUrl", "lastProof", "lastPublication", "activeTabId", "activeFrameId"]);
  if (Number.isInteger(storage.activeTabId)) {
    try {
      const recordedTabStatus = await sendTabMessage(storage.activeTabId, { type: RECORDER_MESSAGES.status }, storage.activeFrameId);
      if (!recordedTabStatus?.active) {
        await chrome.storage.local.remove(["activeTabId", "activeFrameId"]);
        storage.activeTabId = undefined;
        checkpointState = null;
      }
    } catch {
      await chrome.storage.local.remove(["activeTabId", "activeFrameId"]);
      storage.activeTabId = undefined;
      checkpointState = null;
    }
  }
  let recorder = { active: false };
  if (Number.isInteger(tabId)) {
    try {
      recorder = await sendTabMessageWithRecovery(tabId, { type: RECORDER_MESSAGES.status },
        storage.activeTabId === tabId ? storage.activeFrameId : focusedFrames.get(tabId));
    } catch {
      recorder = { active: false, unavailable: true };
    }
  }
  return {
    ok: true,
    serverUrl: storage.serverUrl || DEFAULT_SERVER_URL,
    hasLastProof: Boolean(storage.lastProof),
    publication: storage.lastPublication || null,
    activeElsewhere: Number.isInteger(storage.activeTabId) && storage.activeTabId !== tabId,
    recorder
  };
}

async function startRecording(tabId, requestedFrameId) {
  if (!Number.isInteger(tabId)) throw new Error("No active tab is available");
  const { activeTabId } = await chrome.storage.local.get("activeTabId");
  if (Number.isInteger(activeTabId) && activeTabId !== tabId) {
    throw new Error("A recording is already active in another tab");
  }

  let frameId = requestedFrameId ?? focusedFrames.get(tabId);
  const preparation = await sendToRecorder(tabId, { type: RECORDER_MESSAGES.prepare }, frameId);
  if (!preparation.ok) throw new Error(preparation.error);
  frameId ??= focusedFrames.get(tabId);

  const identity = await getOrCreateIdentity();
  const { serverUrl: storedUrl } = await chrome.storage.local.get("serverUrl");
  const serverUrl = validateServerUrl(storedUrl || DEFAULT_SERVER_URL);
  const response = await fetchJson(`${serverUrl}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      recorder: { publicKey: identity.publicJwk, keyId: identity.keyId },
      context: { origin: preparation.origin }
    })
  });

  checkpointState = {
    tabId,
    frameId,
    sessionId: response.challenge.payload.sessionId,
    nonce: response.challenge.payload.nonce,
    serverUrl,
    root: "typeproof:event-chain:v1",
    nextSequence: 0,
    queue: Promise.resolve(),
    error: null
  };

  let begun;
  try {
    begun = await sendToRecorder(tabId, {
      type: RECORDER_MESSAGES.begin,
      challenge: response.challenge,
      serverPublicKey: response.serverPublicKey,
      recorder: { publicKey: identity.publicJwk, keyId: identity.keyId, extensionVersion: EXTENSION_VERSION },
      serverUrl
    }, frameId);
    if (!begun.ok) throw new Error(begun.error);
  } catch (error) {
    checkpointState = null;
    throw error;
  }
  await chrome.storage.local.set({ activeTabId: tabId, activeFrameId: frameId ?? 0 });
  return { ok: true, status: begun.status };
}

async function stopRecording(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("No active tab is available");
  const { activeFrameId } = await chrome.storage.local.get("activeFrameId");
  const stopped = await sendToRecorder(tabId, { type: RECORDER_MESSAGES.stop }, checkpointState?.frameId ?? activeFrameId);
  if (!stopped.ok) throw new Error(stopped.error);
  try {
    if (!checkpointState || checkpointState.tabId !== tabId) throw new Error("The live witness checkpoint state was lost");
    await checkpointState.queue;
    if (checkpointState.error) throw checkpointState.error;
    if (checkpointState.nextSequence !== stopped.recording.events.length) {
      throw new Error("The witness did not receive every recorded edit checkpoint");
    }

    const identity = await getOrCreateIdentity();
    const eventChainRoot = await computeEventChainRoot(stopped.recording.events);
    const challenge = stopped.session.challenge;
    const claim = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: challenge.payload.sessionId,
      nonce: challenge.payload.nonce,
      recorder: { publicKey: identity.publicJwk, keyId: identity.keyId, extensionVersion: EXTENSION_VERSION },
      context: stopped.recording.context,
      startedAt: stopped.recording.startedAt,
      endedAt: stopped.recording.endedAt,
      initialText: stopped.recording.initialText,
      finalText: stopped.recording.finalText,
      events: stopped.recording.events,
      violations: stopped.recording.violations,
      eventChainRoot,
      witnessChallenge: challenge
    };
    claim.certifiedRanges = chooseCertifiedRanges(claim);
    if (claim.certifiedRanges.length === 0) throw new Error("No typed text remains to certify");
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      claim,
      deviceSignature: await signObject(identity.privateKey, claim)
    };
    const finalized = await fetchJson(`${stopped.session.serverUrl}/v1/sessions/${encodeURIComponent(claim.sessionId)}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope)
    });

    const proof = {
      ...envelope,
      witness: {
        serverPublicKey: stopped.session.serverPublicKey,
        receipt: finalized.receipt
      }
    };
    await chrome.storage.local.set({ lastProof: proof, lastProofServerUrl: stopped.session.serverUrl });
    await chrome.storage.local.remove("lastPublication");
    return { ok: true, proof };
  } finally {
    await chrome.storage.local.remove(["activeTabId", "activeFrameId"]);
    checkpointState = null;
  }
}

async function publishLastProof() {
  const { lastProof, lastProofServerUrl, serverUrl: configuredUrl } = await chrome.storage.local.get([
    "lastProof", "lastProofServerUrl", "serverUrl"
  ]);
  if (!lastProof) throw new Error("No completed proof is available to publish");
  const serverUrl = validateServerUrl(lastProofServerUrl || configuredUrl || DEFAULT_SERVER_URL);
  const publication = await fetchJson(`${serverUrl}/v1/proofs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lastProof)
  });
  await chrome.storage.local.set({ lastPublication: publication });
  return { ok: true, publication };
}

function queueCheckpoint(message, sender) {
  if (!checkpointState || sender.tab?.id !== checkpointState.tabId || sender.frameId !== checkpointState.frameId || message.sessionId !== checkpointState.sessionId) {
    return Promise.resolve({ ok: false, error: "No matching witnessed session is active" });
  }
  const state = checkpointState;
  const operation = async () => {
    if (state.error) throw state.error;
    const event = message.event;
    if (event?.sequence !== state.nextSequence) throw new Error(`Expected event sequence ${state.nextSequence}`);
    const root = await objectDigest({ previous: state.root, event });
    const identity = await getOrCreateIdentity();
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: state.sessionId,
      nonce: state.nonce,
      sequence: state.nextSequence,
      eventChainRoot: root
    };
    await fetchJson(`${state.serverUrl}/v1/sessions/${encodeURIComponent(state.sessionId)}/checkpoints`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature: await signObject(identity.privateKey, payload) })
    });
    state.root = root;
    state.nextSequence += 1;
    return { ok: true, sequence: event.sequence };
  };
  state.queue = state.queue.then(operation).catch((error) => {
    state.error = error;
    throw error;
  });
  return state.queue.catch((error) => ({ ok: false, error: error.message }));
}

async function sendToRecorder(tabId, message, frameId) {
  try {
    return await sendTabMessageWithRecovery(tabId, message, frameId);
  } catch (error) {
    throw new Error("TypeProof cannot access this page. Use its dedicated editor or focus a field on a regular web page.", { cause: error });
  }
}

async function sendTabMessageWithRecovery(tabId, message, frameId) {
  try {
    const response = await sendTabMessage(tabId, message, frameId);
    if (response?.recorderVersion === EXTENSION_VERSION) return response;
  } catch {
    // Missing and orphaned content scripts both recover through current-code injection.
  }
  const injectedFrameId = await injectRecorder(tabId, frameId);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const response = await sendTabMessage(tabId, message, injectedFrameId ?? focusedFrames.get(tabId));
  if (response?.recorderVersion !== EXTENSION_VERSION) throw new Error("The page is still running an older TypeProof recorder");
  return response;
}

async function injectRecorder(tabId, frameId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/u.test(tab.url || "")) throw new Error("Recorder injection is restricted to HTTP(S) pages");
  if (Number.isInteger(frameId)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
      return frameId;
    } catch {
      focusedFrames.delete(tabId);
    }
  }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  return undefined;
}

function sendTabMessage(tabId, message, frameId) {
  return Number.isInteger(frameId)
    ? chrome.tabs.sendMessage(tabId, message, { frameId })
    : chrome.tabs.sendMessage(tabId, message);
}

async function fetchJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error(`Cannot reach the TypeProof witness at ${new URL(url).origin}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The witness returned an unreadable HTTP ${response.status} response`);
  }
  if (!response.ok) throw new Error(body?.error?.message || `Witness request failed with HTTP ${response.status}`);
  return body;
}

function validateServerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Witness URL is invalid");
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !localHttp) throw new Error("Use HTTPS for remote witnesses; HTTP is only allowed on localhost");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Witness URL must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

async function getOrCreateIdentity() {
  const database = await openDatabase();
  const existing = await idbRequest(database.transaction(STORE_NAME).objectStore(STORE_NAME).get("identity"));
  if (existing?.privateKey && existing?.publicKey) {
    const publicJwk = await exportPublicJwk(existing.publicKey);
    return { privateKey: existing.privateKey, publicJwk, keyId: await publicKeyId(publicJwk) };
  }

  const keyPair = await generateSigningKey(false);
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id: "identity", privateKey: keyPair.privateKey, publicKey: keyPair.publicKey });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  return { privateKey: keyPair.privateKey, publicJwk, keyId: await publicKeyId(publicJwk) };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
