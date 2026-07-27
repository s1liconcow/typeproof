(() => {
  const RECORDER_VERSION = chrome.runtime.getManifest().version;
  const previousInstallation = globalThis.__typeProofRecorderInstallation;
  if (previousInstallation?.version === RECORDER_VERSION) return;
  try {
    previousInstallation?.dispose?.();
  } catch {
    // A stale extension context may no longer expose working Chrome APIs.
  }
  globalThis.__typeProofRecorderInstalled = RECORDER_VERSION;

  const ALLOWED_TYPES = new Set(["insertText", "insertLineBreak", "insertParagraph", "deleteContentBackward", "deleteContentForward"]);
  const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"]);
  const MAX_EVENTS = 100_000;
  const MAX_TEXT = 1_000_000;
  const markedSurfaceStyles = new WeakMap();
  let active = null;
  let preparedSurface = null;

  function onRuntimeMessage(message, _sender, sendResponse) {
    try {
      let response;
      if (message?.type === "TYPEPROOF_RECORDER_PREPARE_V2" || message?.type === "TYPEPROOF_PREPARE") response = prepare();
      else if (message?.type === "TYPEPROOF_RECORDER_BEGIN_V2" || message?.type === "TYPEPROOF_BEGIN") response = begin(message);
      else if (message?.type === "TYPEPROOF_RECORDER_STATUS_V2" || message?.type === "TYPEPROOF_STATUS") response = status();
      else if (message?.type === "TYPEPROOF_RECORDER_STOP_V2" || message?.type === "TYPEPROOF_STOP") response = stop();
      else return false;
      sendResponse({ ...response, recorderVersion: RECORDER_VERSION });
    } catch (error) {
      sendResponse({ ok: false, error: error.message, recorderVersion: RECORDER_VERSION });
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  document.addEventListener("focusin", notifyFrameFocused, true);
  if (createSurface(deepActiveElement())) notifyFrameFocused();
  globalThis.__typeProofRecorderInstallation = { version: RECORDER_VERSION, dispose };

  function prepare() {
    if (active) return { ok: false, error: "A TypeProof recording is already active in this editor" };
    const surface = createSurface(deepActiveElement());
    if (!surface) {
      return { ok: false, error: "Focus a text input, textarea, or rich-text editing surface before starting" };
    }
    if (!surface.isEditable()) return { ok: false, error: "The focused surface is not editable" };
    preparedSurface = surface;
    return { ok: true, origin: effectiveOrigin(), fieldKind: surface.kind };
  }

  function begin(message) {
    if (!preparedSurface || !preparedSurface.isConnected() || !preparedSurface.isEditable()) {
      preparedSurface = null;
      return { ok: false, error: "The prepared editing surface changed before recording could start" };
    }
    const now = performance.now();
    const initialText = preparedSurface.read();
    active = {
      surface: preparedSurface,
      initialText,
      expectedText: initialText,
      events: [],
      observedEditCount: 0,
      violations: [],
      lastKeydown: null,
      pending: null,
      startedPerformance: now,
      lastEventPerformance: now,
      startedAt: new Date().toISOString(),
      session: {
        challenge: message.challenge,
        serverPublicKey: message.serverPublicKey,
        serverUrl: message.serverUrl
      }
    };
    preparedSurface = null;
    installListeners();
    active.poll = setInterval(checkIntegrity, 250);
    active.surface.mark("valid");
    return { ok: true, status: status() };
  }

  function stop() {
    if (!active) return { ok: false, error: "No recording is active in this editor" };
    checkIntegrity();
    if (active.pending) finalizeInput(active.pending);
    const recording = active;
    uninstallListeners();
    clearInterval(recording.poll);
    recording.surface.mark(false);
    active = null;
    return {
      ok: true,
      session: recording.session,
      recording: {
        context: {
          origin: effectiveOrigin(),
          fieldKind: recording.surface.kind,
          frameUrl: effectiveFrameUrl()
        },
        startedAt: recording.startedAt,
        endedAt: new Date().toISOString(),
        initialText: recording.initialText,
        finalText: recording.surface.read(),
        events: recording.events,
        violations: recording.violations
      }
    };
  }

  function status() {
    if (!active) return { active: false };
    return {
      active: true,
      invalid: active.violations.length > 0,
      violationCount: active.violations.length,
      eventCount: active.events.length,
      observedEditCount: active.observedEditCount,
      characterCount: active.surface.read().length,
      fieldKind: active.surface.kind,
      lastViolation: active.violations.at(-1) || null
    };
  }

  function onKeydown(event) {
    if (!active || !active.surface.containsEvent(event)) return;
    active.lastKeydown = {
      at: performance.now(),
      trusted: event.isTrusted,
      key: {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat
      }
    };
  }

  function onBeforeInput(event) {
    if (!active || !active.surface.containsEvent(event)) return;
    checkIntegrity();
    if (!event.isTrusted) return checkSyntheticEventAfterDispatch();
    const browserInputType = String(event.inputType || "unknown");
    const compositionLike = event.isComposing || /composition/iu.test(browserInputType);
    if (/(paste|drop)/iu.test(browserInputType)) {
      return reject(event, "disallowed_input_type", `Input type ${browserInputType} is not recordable`);
    }
    if (active.pending) finalizeInput(active.pending);
    if (!active) return;

    const inputData = event.data;
    const hasRecentTrustedKeydown = active.lastKeydown?.trusted === true && performance.now() - active.lastKeydown.at <= 500;
    const data = browserInputType === "insertText" ? inputData : null;
    const directlyTyped = !compositionLike && ALLOWED_TYPES.has(browserInputType) && hasRecentTrustedKeydown &&
      (browserInputType !== "insertText" || (typeof data === "string" && Array.from(data).length === 1));
    const pending = {
      beforeText: active.expectedText,
      inputType: directlyTyped ? browserInputType : "observedMutation",
      browserInputType,
      data: directlyTyped ? data : null,
      trusted: true,
      key: directlyTyped ? active.lastKeydown.key : null,
      beganAt: performance.now(),
      inputSeen: false,
      observedMutation: !directlyTyped,
      ignoredFormatting: browserInputType.startsWith("format")
    };
    active.lastKeydown = null;
    active.pending = pending;
    schedulePendingFinalization(pending);
  }

  function onInput(event) {
    if (!active || !active.surface.containsEvent(event)) return;
    if (!event.isTrusted) return checkSyntheticEventAfterDispatch();
    const browserInputType = String(event.inputType || "unknown");
    if (/(paste|drop)/iu.test(browserInputType)) {
      return addViolation("disallowed_input_type", `Input type ${browserInputType} is not recordable`);
    }
    if (!active.pending) {
      active.pending = {
        beforeText: active.expectedText,
        inputType: "observedMutation",
        browserInputType,
        data: null,
        trusted: true,
        key: null,
        beganAt: performance.now(),
        inputSeen: true,
        observedMutation: true
      };
    }
    const pending = active.pending;
    pending.inputSeen = true;
    queueMicrotask(() => finalizeInput(pending));
  }

  function schedulePendingFinalization(pending) {
    setTimeout(() => {
      if (active?.pending === pending && !pending.inputSeen) finalizeInput(pending);
    }, 100);
  }

  function finalizeInput(pending) {
    if (!active || active.pending !== pending) return;
    active.pending = null;
    const afterText = active.surface.read();
    const edit = inferSingleEdit(pending.beforeText, afterText);
    if (!edit) return;
    const now = pending.beganAt;
    if (pending.ignoredFormatting || pending.observedMutation || !editMatchesInput(edit, pending)) {
      commitObservedMutation(edit, afterText, now, "input-event", pending.browserInputType, true);
      return;
    }
    const proofEvent = {
      sequence: active.events.length,
      deltaMs: Math.max(0, Math.round(now - active.lastEventPerformance)),
      inputType: pending.inputType,
      data: pending.data,
      selectionStart: edit.start,
      selectionEnd: edit.end,
      trusted: pending.trusted,
      key: pending.key
    };
    commitProofEvent(proofEvent, afterText, now, false);
  }

  function commitObservedMutation(edit, afterText, at, source, browserInputType, trusted) {
    commitProofEvent({
      sequence: active.events.length,
      deltaMs: Math.max(0, Math.round(at - active.lastEventPerformance)),
      inputType: "observedMutation",
      browserInputType,
      data: edit.replacement,
      selectionStart: edit.start,
      selectionEnd: edit.end,
      trusted,
      key: null,
      source
    }, afterText, at, true);
  }

  function commitProofEvent(proofEvent, afterText, at, observed) {
    active.events.push(proofEvent);
    if (observed) active.observedEditCount += 1;
    active.expectedText = afterText;
    active.lastEventPerformance = at;
    sendRuntimeMessage({
      type: "TYPEPROOF_CHECKPOINT",
      sessionId: active.session.challenge.payload.sessionId,
      event: proofEvent
    }).then((response) => {
      if (active && !response?.ok) addViolation("witness_checkpoint_failed", response?.error || "The witness rejected a live checkpoint");
    }).catch(() => {
      if (active) addViolation("witness_checkpoint_failed", "A live checkpoint could not reach the extension service worker");
    });
    if (active.events.length > MAX_EVENTS || afterText.length > MAX_TEXT) addViolation("proof_limit_exceeded", "The recording exceeds protocol limits");
  }

  function onPaste(event) {
    if (active && active.surface.containsEvent(event)) reject(event, "paste_attempted", "Paste was blocked and invalidated the session");
  }

  function onDrop(event) {
    if (active && active.surface.containsEvent(event)) reject(event, "drop_attempted", "Dropped content was blocked and invalidated the session");
  }

  function reject(event, code, detail) {
    event.preventDefault();
    addViolation(code, detail);
  }

  function addViolation(code, detail) {
    if (!active) return;
    const duplicate = active.violations.at(-1);
    if (duplicate?.code === code && duplicate?.detail === detail) return;
    active.violations.push({ code, detail, atMs: Math.max(0, Math.round(performance.now() - active.startedPerformance)) });
    active.surface.mark("invalid");
  }

  function checkSyntheticEventAfterDispatch() {
    // Rich editors commonly emit notification-only synthetic input events after
    // the browser's trusted event. They are harmless unless text also changes.
    queueMicrotask(checkIntegrity);
  }

  function checkIntegrity() {
    if (!active) return;
    if (!active.surface.isConnected()) return addViolation("element_changed", "The recorded editing surface was removed from the document");
    if (active.pending) return;
    const currentText = active.surface.read();
    if (currentText === active.expectedText) return;
    if (active.events.length === 0 && active.violations.length === 0) {
      // Gmail and similar editors may finish initializing the focused compose
      // body after the popup closes. Before the first accepted edit, all text is
      // unverified baseline content, so rebasing cannot create typed provenance.
      active.initialText = currentText;
      active.expectedText = currentText;
      return;
    }
    const edit = inferSingleEdit(active.expectedText, currentText);
    if (!edit) return;
    commitObservedMutation(edit, currentText, performance.now(), "dom-mutation", null, false);
  }

  function installListeners() {
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("drop", onDrop, true);
  }

  function uninstallListeners() {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("beforeinput", onBeforeInput, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("drop", onDrop, true);
  }

  function dispose() {
    uninstallListeners();
    document.removeEventListener("focusin", notifyFrameFocused, true);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // The previous extension context may already be invalid.
    }
    if (active?.poll) clearInterval(active.poll);
    try {
      active?.surface.mark(false);
    } catch {
      // The editor may have been removed while the extension was updating.
    }
    active = null;
    preparedSurface = null;
  }

  function createSurface(element) {
    if (isTextControl(element)) return textControlSurface(element);
    const host = editingHost(element);
    if (!host) return null;
    return richTextSurface(host);
  }

  function textControlSurface(element) {
    return {
      kind: element instanceof HTMLTextAreaElement ? "textarea" : "text-input",
      root: element,
      read: () => normalizeText(element.value),
      containsEvent: (event) => event.composedPath().includes(element),
      isConnected: () => element.isConnected,
      isEditable: () => !element.readOnly && !element.disabled,
      mark: (state) => markSurface(element, state)
    };
  }

  function richTextSurface(host) {
    const scope = findRichScope(host);
    return {
      kind: scope === host ? "contenteditable" : "block-editor",
      root: scope,
      read: () => readRichScope(scope),
      containsEvent: (event) => {
        const targetHost = event.composedPath().map((node) => node instanceof Element ? editingHost(node) : null).find(Boolean);
        return Boolean(targetHost && (scope === targetHost || scope.contains(targetHost)));
      },
      isConnected: () => scope.isConnected,
      isEditable: () => host.isContentEditable,
      mark: (state) => markSurface(scope, state)
    };
  }

  function markSurface(element, state) {
    if (!state) {
      const previous = markedSurfaceStyles.get(element);
      if (!previous) {
        delete element.dataset.typeproofRecording;
        return;
      }
      restoreStyle(element, "outline", previous.outline);
      restoreStyle(element, "outline-offset", previous.outlineOffset);
      if (previous.recordingAttribute === null) delete element.dataset.typeproofRecording;
      else element.dataset.typeproofRecording = previous.recordingAttribute;
      markedSurfaceStyles.delete(element);
      return;
    }

    if (!markedSurfaceStyles.has(element)) {
      markedSurfaceStyles.set(element, {
        outline: savedStyle(element, "outline"),
        outlineOffset: savedStyle(element, "outline-offset"),
        recordingAttribute: element.hasAttribute("data-typeproof-recording")
          ? element.getAttribute("data-typeproof-recording")
          : null
      });
    }
    const color = state === "invalid" ? "rgba(190, 54, 54, 0.82)" : "rgba(31, 143, 87, 0.78)";
    element.style.setProperty("outline", `2px solid ${color}`, "important");
    element.style.setProperty("outline-offset", "2px", "important");
    element.dataset.typeproofRecording = state === "invalid" ? "invalid" : "true";
  }

  function savedStyle(element, property) {
    return {
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property)
    };
  }

  function restoreStyle(element, property, saved) {
    if (saved.value === "") element.style.removeProperty(property);
    else element.style.setProperty(property, saved.value, saved.priority);
  }

  function findRichScope(host) {
    if (!isNotionLike()) return host;
    const explicit = host.closest('[data-content-editable-root="true"], [data-testid="page-content"], main, [role="main"]');
    if (explicit && explicit.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]').length <= 500) return explicit;
    return host;
  }

  function readRichScope(scope) {
    if (scope.isContentEditable) return serializeEditable(scope);
    const hosts = [...scope.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]')]
      .filter((candidate) => !candidate.parentElement?.isContentEditable && isVisible(candidate));
    return normalizeText(hosts.map(serializeEditable).join("\n"));
  }

  function serializeEditable(element) {
    if (element.childNodes.length === 1 && element.firstChild?.nodeName === "BR") return "";
    return normalizeText(serializeChildren(element));
  }

  function serializeChildren(element) {
    const segments = [];
    let inline = "";
    for (const child of element.childNodes) {
      if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
        if (inline !== "") {
          segments.push(inline);
          inline = "";
        }
        segments.push(isPlaceholderBlock(child) ? "" : serializeChildren(child));
      } else {
        inline += serializeNode(child);
      }
    }
    if (inline !== "" || segments.length === 0) segments.push(inline);
    return segments.join("\n");
  }

  function serializeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (!(node instanceof HTMLElement) || !isVisible(node)) return "";
    if (node.tagName === "BR") return "\n";
    return BLOCK_TAGS.has(node.tagName) ? serializeChildren(node) : [...node.childNodes].map(serializeNode).join("");
  }

  function isPlaceholderBlock(element) {
    return element.textContent === "" && element.querySelectorAll("br").length > 0 &&
      [...element.querySelectorAll("*")].every((child) => child.tagName === "BR" || child.getAttribute("contenteditable") === "false");
  }

  function inferSingleEdit(before, after) {
    if (before === after) return null;
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
      beforeEnd -= 1;
      afterEnd -= 1;
    }
    return { start, end: beforeEnd, replacement: after.slice(start, afterEnd), removed: before.slice(start, beforeEnd) };
  }

  function editMatchesInput(edit, pending) {
    if (pending.observedReplacement) return edit.removed.length > 0 && edit.replacement.length > 0;
    if (pending.inputType === "insertText") return edit.replacement === pending.data;
    if (pending.inputType === "insertLineBreak" || pending.inputType === "insertParagraph") return edit.replacement === "\n";
    if (pending.inputType === "deleteContentBackward" || pending.inputType === "deleteContentForward") {
      return edit.replacement === "" && edit.removed.length > 0;
    }
    return false;
  }

  function editingHost(element) {
    if (!(element instanceof Element)) return null;
    let candidate = element.isContentEditable ? element : element.closest('[contenteditable="true"], [contenteditable="plaintext-only"]');
    if (!candidate) return null;
    while (candidate.parentElement?.isContentEditable) candidate = candidate.parentElement;
    return candidate;
  }

  function deepActiveElement() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    return element instanceof HTMLInputElement && ["text", "search", "url", "tel"].includes(element.type);
  }

  function isNotionLike() {
    return /(^|\.)notion\.(so|site)$/u.test(location.hostname) || Boolean(document.querySelector('[data-content-editable-root="true"]'));
  }

  function isVisible(element) {
    return element.getAttribute("aria-hidden") !== "true" && element.hidden !== true;
  }

  function normalizeText(value) {
    return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\u00a0", " ");
  }

  function notifyFrameFocused() {
    sendRuntimeMessage({ type: "TYPEPROOF_FRAME_FOCUSED" }).catch(() => {});
  }

  function sendRuntimeMessage(message) {
    try {
      const operation = chrome.runtime.sendMessage(message);
      return operation && typeof operation.then === "function"
        ? operation
        : Promise.reject(new Error("The TypeProof extension context is unavailable"));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function effectiveOrigin() {
    if (location.origin !== "null") return location.origin;
    try {
      return new URL(document.referrer).origin;
    } catch {
      return "null";
    }
  }

  function effectiveFrameUrl() {
    if (location.origin !== "null") return `${location.origin}${location.pathname}`;
    try {
      const parentUrl = new URL(document.referrer);
      return `${parentUrl.origin}${parentUrl.pathname}#embedded-editor`;
    } catch {
      return "embedded-editor";
    }
  }
})();
