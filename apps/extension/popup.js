const elements = {
  start: document.querySelector("#start"),
  stop: document.querySelector("#stop"),
  writer: document.querySelector("#writer"),
  download: document.querySelector("#download"),
  publish: document.querySelector("#publish"),
  shareCard: document.querySelector("#share-card"),
  verificationLink: document.querySelector("#verification-link"),
  copyLink: document.querySelector("#copy-link"),
  copyEmbed: document.querySelector("#copy-embed"),
  copyBadgeUrl: document.querySelector("#copy-badge-url"),
  saveServer: document.querySelector("#save-server"),
  serverUrl: document.querySelector("#server-url"),
  message: document.querySelector("#message"),
  statusDot: document.querySelector("#status-dot"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail")
};

let tabId;
let timer;
let publication;

initialize();

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  bindEvents();
  await refresh();
  timer = setInterval(refresh, 1000);
}

function bindEvents() {
  elements.start.addEventListener("click", () => perform("START_RECORDING"));
  elements.stop.addEventListener("click", () => perform("STOP_RECORDING"));
  elements.download.addEventListener("click", downloadProof);
  elements.publish.addEventListener("click", publishProof);
  elements.copyLink.addEventListener("click", () => copyShareValue(publication?.verificationUrl, "Verification link copied."));
  elements.copyEmbed.addEventListener("click", copyLinkedBadge);
  elements.copyBadgeUrl.addEventListener("click", () => copyShareValue(publication?.badgeUrl, "Badge icon URL copied."));
  elements.writer.addEventListener("click", openWriter);
  elements.saveServer.addEventListener("click", saveServer);
  window.addEventListener("unload", () => clearInterval(timer));
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: "GET_APP_STATE", tabId });
  if (!response?.ok) return showError(response?.error || "Could not read extension state");
  if (document.activeElement !== elements.serverUrl) elements.serverUrl.value = response.serverUrl;
  elements.download.hidden = !response.hasLastProof;
  elements.publish.hidden = !response.hasLastProof || Boolean(response.publication);
  renderPublication(response.publication);
  renderRecorder(response);
}

function renderPublication(value) {
  publication = value;
  elements.shareCard.hidden = !value;
  if (!value) return;
  elements.verificationLink.href = value.verificationUrl;
  elements.verificationLink.textContent = value.verificationUrl;
}

async function publishProof() {
  if (!confirm("Publish this proof? The certified text and full proof transcript will be publicly accessible to anyone with the link.")) return;
  setBusy(true);
  elements.message.textContent = "Publishing the proof and creating its verification badge…";
  try {
    const response = await chrome.runtime.sendMessage({ type: "PUBLISH_LAST_PROOF" });
    if (!response?.ok) throw new Error(response?.error || "Publication failed");
    renderPublication(response.publication);
    elements.publish.hidden = true;
    elements.message.textContent = "Verification link published. You can now copy the link or badge embed.";
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function copyShareValue(value, successMessage) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  elements.message.textContent = successMessage;
}

async function copyLinkedBadge() {
  if (!publication) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([publication.embedHtml], { type: "text/html" }),
      "text/plain": new Blob([publication.verificationUrl], { type: "text/plain" })
    })]);
    elements.message.textContent = "Linked badge copied. Paste it into Gmail, Substack, or another rich editor.";
  } catch {
    await copyShareValue(publication.embedHtml, "Badge HTML copied.");
  }
}

function renderRecorder(state) {
  const recorder = state.recorder || {};
  elements.statusDot.className = "status-dot";
  if (recorder.active) {
    elements.statusDot.classList.add(recorder.invalid ? "invalid" : "live");
    elements.statusTitle.textContent = recorder.invalid ? "Session invalidated" : "Recording keyboard events";
    const assistedDetail = recorder.observedEditCount > 0 ? ` · ${recorder.observedEditCount} editor-assisted` : "";
    elements.statusDetail.textContent = recorder.invalid
      ? `${recorder.lastViolation?.detail || `${recorder.violationCount} blocked or unexpected action(s).`} Stop to discard the invalid proof.`
      : `${recorder.eventCount - (recorder.observedEditCount || 0)} typed edits${assistedDetail} · ${recorder.characterCount} characters`;
    elements.start.hidden = true;
    elements.stop.hidden = false;
    elements.stop.textContent = recorder.invalid ? "Stop & discard invalid session" : "Stop & seal proof";
  } else {
    elements.statusTitle.textContent = state.activeElsewhere ? "Recording in another tab" : recorder.unavailable ? "Page is not recordable" : "Ready for an editable surface";
    elements.statusDetail.textContent = state.activeElsewhere
      ? "Return to the recording tab to finish."
      : recorder.unavailable ? "Open the writing pad or use a regular http(s) page." : "Focus an input, textarea, or rich-text editor, then start.";
    elements.start.hidden = false;
    elements.start.disabled = state.activeElsewhere || recorder.unavailable;
    elements.stop.hidden = true;
  }
}

async function perform(type) {
  setBusy(true);
  elements.message.textContent = type === "STOP_RECORDING" ? "Sealing and asking the witness to verify…" : "Requesting a one-time witness challenge…";
  try {
    const response = await chrome.runtime.sendMessage({ type, tabId });
    if (!response?.ok) throw new Error(response?.error || "Operation failed");
    if (response.proof) {
      elements.message.textContent = "Proof sealed. Download it or verify it on the witness page.";
      await downloadValue(response.proof);
    } else {
      elements.message.textContent = "Recording started. Editor-assisted changes are noted without typed provenance; paste, drop, or recorder failures invalidate.";
    }
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function downloadProof() {
  const response = await chrome.runtime.sendMessage({ type: "GET_LAST_PROOF" });
  if (!response?.proof) return showError("No completed proof is stored");
  await downloadValue(response.proof);
}

async function downloadValue(proof) {
  const blob = new Blob([`${JSON.stringify(proof, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `typeproof-${proof.claim.sessionId}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function openWriter() {
  let url;
  try {
    url = new URL(elements.serverUrl.value);
  } catch {
    return showError("Save a valid witness URL first");
  }
  await chrome.tabs.create({ url: `${url.origin}/write` });
  window.close();
}

async function saveServer() {
  const response = await chrome.runtime.sendMessage({ type: "SET_SERVER_URL", serverUrl: elements.serverUrl.value });
  if (!response?.ok) return showError(response?.error || "Could not save witness URL");
  elements.serverUrl.value = response.serverUrl;
  elements.message.textContent = "Witness URL saved.";
}

function setBusy(busy) {
  elements.start.disabled = busy;
  elements.stop.disabled = busy;
  elements.writer.disabled = busy;
  elements.publish.disabled = busy;
}

function showError(message) {
  elements.message.textContent = message;
}
