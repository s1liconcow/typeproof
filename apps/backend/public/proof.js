const id = location.pathname.split("/").at(-1);
const resultElement = document.querySelector("#published-result");
let publication;

load();

async function load() {
  try {
    const response = await fetch(`/v1/proofs/${encodeURIComponent(id)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || "Published proof could not be loaded");
    publication = body;
    render(body.verification);
  } catch (error) {
    document.querySelector("#published-title").textContent = "Proof unavailable";
    document.querySelector("#published-error").textContent = error.message;
  }
}

function render(verification) {
  resultElement.hidden = false;
  document.querySelector("#published-title").textContent = verification.valid ? "This text has witnessed typing provenance." : "This proof no longer verifies.";
  document.querySelector("#published-summary").textContent = verification.summary;
  const verdict = document.querySelector("#published-verdict");
  verdict.className = `verdict ${verification.valid ? "valid" : "invalid"}`;
  verdict.textContent = verification.valid ? "Valid observed typing" : "Invalid or unverified";
  renderDocument(document.querySelector("#certified-content"), verification.documentContent, verification.typedRanges);
  document.querySelector("#published-metrics").replaceChildren(
    definition("Document characters", verification.metrics?.documentCharacterCount ?? "—"),
    definition("Typed characters", verification.metrics?.typedCharacterCount ?? "—"),
    definition("Typed edits", verification.metrics?.typedEventCount ?? "—"),
    definition("Editor-assisted edits", verification.metrics?.observedEditCount ?? "—"),
    definition("Recorded time", verification.metrics ? formatDuration(verification.metrics.elapsedMs) : "—")
  );
  document.querySelector("#published-checks").replaceChildren(...verification.checks.map(checkRow));
  document.querySelector("#published-limitations").replaceChildren(...verification.limitations.map((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    return item;
  }));
}

function renderDocument(element, content, typedRanges) {
  element.replaceChildren();
  if (typeof content !== "string") {
    element.textContent = "No verified document content";
    return;
  }
  let offset = 0;
  for (const range of Array.isArray(typedRanges) ? typedRanges : []) {
    if (!Number.isInteger(range?.start) || !Number.isInteger(range?.end) ||
        range.start < offset || range.end <= range.start || range.end > content.length) continue;
    appendSegment(element, content.slice(offset, range.start), "assisted-text");
    appendSegment(element, content.slice(range.start, range.end), "typed-text");
    offset = range.end;
  }
  appendSegment(element, content.slice(offset), "assisted-text");
}

function appendSegment(element, text, className) {
  if (!text) return;
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  if (className === "assisted-text") span.title = "Editor-assisted or pre-existing text; not typed provenance";
  element.append(span);
}

document.querySelector("#copy-link").addEventListener("click", () => copy(publication.verificationUrl, "Verification link copied"));
document.querySelector("#copy-embed").addEventListener("click", () => copy(publication.embedHtml, "Badge embed copied"));

async function copy(value, message) {
  await navigator.clipboard.writeText(value);
  document.querySelector("#published-summary").textContent = message;
}

function checkRow(check) {
  const row = document.createElement("div");
  row.className = `check ${check.ok ? "pass" : "fail"}`;
  const label = document.createElement("strong");
  label.textContent = check.name;
  const detail = document.createElement("span");
  detail.textContent = check.detail;
  row.append(label, detail);
  return row;
}

function definition(term, description) {
  const wrapper = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = description;
  wrapper.append(dt, dd);
  return wrapper;
}

function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
