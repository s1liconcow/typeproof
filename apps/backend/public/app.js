const fileInput = document.querySelector("#proof-file");
const verifyButton = document.querySelector("#verify");
const errorElement = document.querySelector("#error");
const resultElement = document.querySelector("#result");
let proof;

fileInput.addEventListener("change", async () => {
  reset();
  const file = fileInput.files[0];
  if (!file) return;
  try {
    proof = JSON.parse(await file.text());
    verifyButton.disabled = false;
  } catch {
    errorElement.textContent = "That file is not valid JSON.";
  }
});

verifyButton.addEventListener("click", async () => {
  verifyButton.disabled = true;
  errorElement.textContent = "";
  try {
    const response = await fetch("/v1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof)
    });
    const body = await response.json();
    if (!body.checks) throw new Error(body?.error?.message || "Verifier returned an invalid response");
    render(body);
  } catch (error) {
    errorElement.textContent = error.message;
  } finally {
    verifyButton.disabled = false;
  }
});

function reset() {
  proof = null;
  verifyButton.disabled = true;
  resultElement.hidden = true;
  errorElement.textContent = "";
}

function render(result) {
  resultElement.hidden = false;
  const verdict = document.querySelector("#verdict");
  verdict.className = `verdict ${result.valid ? "valid" : "invalid"}`;
  verdict.textContent = result.valid ? "Valid observed typing" : "Invalid or unverified";
  document.querySelector("#summary").textContent = result.summary;
  renderDocument(document.querySelector("#verified-content"), result.documentContent, result.typedRanges);
  document.querySelector("#metrics").replaceChildren(
    definition("Document characters", result.metrics?.documentCharacterCount ?? "—"),
    definition("Typed characters", result.metrics?.typedCharacterCount ?? "—"),
    definition("Typed edits", result.metrics?.typedEventCount ?? "—"),
    definition("Editor-assisted edits", result.metrics?.observedEditCount ?? "—"),
    definition("Recorded time", result.metrics ? formatDuration(result.metrics.elapsedMs) : "—")
  );
  document.querySelector("#checks").replaceChildren(...result.checks.map((check) => {
    const row = document.createElement("div");
    row.className = `check ${check.ok ? "pass" : "fail"}`;
    const label = document.createElement("strong");
    label.textContent = check.name;
    const detail = document.createElement("span");
    detail.textContent = check.detail;
    row.append(label, detail);
    return row;
  }));
  document.querySelector("#limitations").replaceChildren(...result.limitations.map((text) => {
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
