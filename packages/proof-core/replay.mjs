import {
  ALLOWED_INPUT_TYPES,
  CERTIFIED_RANGES_PROTOCOL_VERSIONS,
  MAX_EVENTS,
  MAX_TEXT_LENGTH,
  OBSERVED_INPUT_TYPES,
  PROTOCOL_VERSION
} from "./protocol.mjs";

function result(ok, code, message, details = {}) {
  return { ok, code, message, ...details };
}

export function applyEdit(text, event) {
  const { selectionStart: start, selectionEnd: end, inputType, data } = event;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
    return result(false, "invalid_selection", "An edit has a selection outside the reconstructed text");
  }

  if (inputType === "insertText") {
    if (typeof data !== "string" || Array.from(data).length !== 1) {
      return result(false, "invalid_insert", "Each insertText edit must contain exactly one Unicode character");
    }
    return result(true, "ok", "Edit applied", { text: text.slice(0, start) + data + text.slice(end) });
  }
  if (inputType === "insertLineBreak") {
    if (data !== null) return result(false, "invalid_line_break", "Line-break data must be null");
    return result(true, "ok", "Edit applied", { text: text.slice(0, start) + "\n" + text.slice(end) });
  }
  if (inputType === "insertParagraph") {
    if (data !== null) return result(false, "invalid_paragraph", "Paragraph data must be null");
    return result(true, "ok", "Edit applied", { text: text.slice(0, start) + "\n" + text.slice(end) });
  }
  if (inputType === "deleteContentBackward") {
    if (data !== null) return result(false, "invalid_delete", "Delete data must be null");
    const deleteStart = start === end ? previousCodePointOffset(text, start) : start;
    return result(true, "ok", "Edit applied", { text: text.slice(0, deleteStart) + text.slice(end) });
  }
  if (inputType === "deleteContentForward") {
    if (data !== null) return result(false, "invalid_delete", "Delete data must be null");
    const deleteEnd = start === end ? nextCodePointOffset(text, end) : end;
    return result(true, "ok", "Edit applied", { text: text.slice(0, start) + text.slice(deleteEnd) });
  }
  if (inputType === "insertReplacementText") {
    if (typeof data !== "string" || data.length === 0 || start === end) {
      return result(false, "invalid_replacement", "An editor-assisted replacement must replace text with a non-empty string");
    }
    return result(true, "ok", "Observed replacement applied", { text: text.slice(0, start) + data + text.slice(end) });
  }
  if (inputType === "observedMutation") {
    if (typeof data !== "string" || (data.length === 0 && start === end)) {
      return result(false, "invalid_replacement", "An editor-assisted mutation must change the reconstructed text");
    }
    return result(true, "ok", "Observed replacement applied", { text: text.slice(0, start) + data + text.slice(end) });
  }
  return result(false, "disallowed_input", `Input type ${String(inputType)} is not touch typing`);
}

function previousCodePointOffset(text, offset) {
  if (offset === 0) return 0;
  const previous = text.charCodeAt(offset - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && offset >= 2) {
    const lead = text.charCodeAt(offset - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return offset - 2;
  }
  return offset - 1;
}

function nextCodePointOffset(text, offset) {
  if (offset >= text.length) return text.length;
  const lead = text.charCodeAt(offset);
  if (lead >= 0xd800 && lead <= 0xdbff && offset + 1 < text.length) {
    const next = text.charCodeAt(offset + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return offset + 2;
  }
  return offset + 1;
}

function keyboardMatches(event) {
  const key = event.key;
  if (!key || typeof key.key !== "string" || typeof key.code !== "string" || key.code.length === 0) {
    return false;
  }
  if (key.ctrlKey || key.metaKey) return false;
  if (event.inputType === "insertText") return key.key === event.data;
  if (event.inputType === "insertLineBreak") return key.key === "Enter";
  if (event.inputType === "insertParagraph") return key.key === "Enter";
  if (event.inputType === "deleteContentBackward") return key.key === "Backspace";
  if (event.inputType === "deleteContentForward") return key.key === "Delete";
  return false;
}

export function replayTranscript(claim) {
  if (!claim || typeof claim.initialText !== "string" || typeof claim.finalText !== "string") {
    return result(false, "invalid_text", "A proof must contain initial and final text snapshots");
  }
  if (claim.initialText.length > MAX_TEXT_LENGTH || claim.finalText.length > MAX_TEXT_LENGTH) {
    return result(false, "text_too_large", "A text snapshot exceeds the protocol limit");
  }
  if (!Array.isArray(claim.events) || claim.events.length > MAX_EVENTS) {
    return result(false, "event_limit", "The transcript is absent or exceeds the protocol limit");
  }
  if (!Array.isArray(claim.violations) || claim.violations.length !== 0) {
    return result(false, "recording_violation", "The recorder reported a disallowed action", {
      violations: Array.isArray(claim.violations) ? claim.violations : []
    });
  }

  const protocolVersion = claim.protocolVersion || PROTOCOL_VERSION;
  let text = claim.initialText;
  let provenance = Array(text.length).fill(false);
  let elapsedMs = 0;
  let typedEventCount = 0;
  let observedEditCount = 0;
  for (let index = 0; index < claim.events.length; index += 1) {
    const event = claim.events[index];
    if (!event || event.sequence !== index || !Number.isSafeInteger(event.deltaMs) || event.deltaMs < 0) {
      return result(false, "invalid_sequence", `Event ${index} has invalid ordering or timing`);
    }
    const observedReplacement = OBSERVED_INPUT_TYPES.has(event.inputType);
    const observedMutation = event.inputType === "observedMutation";
    const trustClassificationOk = observedMutation ? typeof event.trusted === "boolean" : event.trusted === true;
    if (!trustClassificationOk || (!ALLOWED_INPUT_TYPES.has(event.inputType) && !observedReplacement)) {
      return result(false, "untrusted_event", `Event ${index} does not have an allowed input classification`);
    }
    if (event.inputType === "insertReplacementText" && !["1.2", "1.3", "1.4", PROTOCOL_VERSION].includes(protocolVersion)) {
      return result(false, "unsupported_replacement", `Event ${index} uses editor-assisted replacement outside a supported protocol`);
    }
    if (observedMutation && protocolVersion !== "1.3" && protocolVersion !== "1.4" && protocolVersion !== PROTOCOL_VERSION) {
      return result(false, "unsupported_replacement", `Event ${index} uses an observed mutation outside a supported protocol`);
    }
    if (observedReplacement && event.key !== null) {
      return result(false, "invalid_replacement", `Event ${index} must not claim a keyboard source for an editor-assisted replacement`);
    }
    if (event.inputType === "insertReplacementText" && event.browserInputType !== "insertText" && event.browserInputType !== "insertReplacementText") {
      return result(false, "invalid_replacement", `Event ${index} has an invalid browser replacement type`);
    }
    if (observedMutation && protocolVersion === "1.3" &&
        (event.trusted !== false || event.browserInputType !== null || event.source !== "dom-mutation" ||
          event.selectionStart === event.selectionEnd || typeof event.data !== "string" || event.data.length === 0)) {
      return result(false, "invalid_replacement", `Event ${index} has invalid protocol 1.3 observed-mutation metadata`);
    }
    const forbiddenBrowserType = typeof event.browserInputType === "string" && /(paste|drop)/iu.test(event.browserInputType);
    const domMutationMetadataOk = event.source === "dom-mutation" && event.trusted === false && event.browserInputType === null;
    const inputMutationMetadataOk = event.source === "input-event" && event.trusted === true &&
      typeof event.browserInputType === "string" && event.browserInputType.length > 0 && event.browserInputType.length <= 128 && !forbiddenBrowserType;
    if (observedMutation && (protocolVersion === "1.4" || protocolVersion === PROTOCOL_VERSION) &&
        !domMutationMetadataOk && !inputMutationMetadataOk) {
      return result(false, "invalid_replacement", `Event ${index} has invalid observed-mutation metadata`);
    }
    if (!observedReplacement && !keyboardMatches(event)) {
      return result(false, "keyboard_mismatch", `Event ${index} is not paired with the expected physical key`);
    }
    elapsedMs += event.deltaMs;
    if (!Number.isSafeInteger(elapsedMs)) return result(false, "invalid_timing", "Transcript timing exceeds safe numeric limits");
    const applied = applyEdit(text, event);
    if (!applied.ok) return { ...applied, eventIndex: index };
    provenance = applyProvenance(provenance, text, event);
    text = applied.text;
    if (observedReplacement) observedEditCount += 1;
    else typedEventCount += 1;
    if (text.length > MAX_TEXT_LENGTH) return result(false, "text_too_large", "The reconstructed text exceeds the protocol limit");
  }

  if (text !== claim.finalText) {
    return result(false, "content_mismatch", "The signed event transcript does not reconstruct the claimed text");
  }
  const certifiedRanges = rangesFromProvenance(provenance);
  const certifiedRange = claim.certifiedRange;
  const certifiedRangeOk = certifiedRanges.some((range) => range.start <= certifiedRange?.start && range.end >= certifiedRange?.end) &&
    Number.isInteger(certifiedRange?.start) && Number.isInteger(certifiedRange?.end) && certifiedRange.end > certifiedRange.start;
  const certifiedRangesOk = CERTIFIED_RANGES_PROTOCOL_VERSIONS.has(protocolVersion)
    ? rangesEqual(claim.certifiedRanges, certifiedRanges) && certifiedRanges.length > 0
    : certifiedRangeOk;
  const typedCharacterCount = certifiedRanges.reduce((total, range) => total + range.end - range.start, 0);
  const replayMessage = observedEditCount === 0
    ? "Every edit is reconstructed from an allowed keyboard event"
    : `Every edit is reconstructed; ${observedEditCount} editor-assisted change${observedEditCount === 1 ? " is" : "s are"} excluded from typed provenance`;
  return result(true, "valid_transcript", replayMessage, {
    reconstructedText: text,
    certifiedRanges,
    certifiedRangesOk,
    certifiedRangeOk,
    certifiedText: certifiedRangeOk ? text.slice(certifiedRange.start, certifiedRange.end) : undefined,
    typedCharacterCount,
    eventCount: claim.events.length,
    typedEventCount,
    observedEditCount,
    elapsedMs
  });
}

export function chooseCertifiedRanges(claim) {
  const replay = replayTranscript({ ...claim, certifiedRange: undefined, certifiedRanges: undefined });
  if (!replay.ok || replay.certifiedRanges.length === 0) return [];
  return replay.certifiedRanges.map(({ start, end }) => ({ start, end }));
}

export function chooseCertifiedRange(claim) {
  const certifiedRanges = chooseCertifiedRanges(claim);
  if (certifiedRanges.length === 0) return null;
  return certifiedRanges.reduce((best, range) =>
    range.end - range.start > best.end - best.start ? range : best
  );
}

function rangesEqual(claimed, derived) {
  return Array.isArray(claimed) && claimed.length === derived.length && claimed.every((range, index) =>
    Number.isInteger(range?.start) && Number.isInteger(range?.end) &&
    range.start === derived[index].start && range.end === derived[index].end
  );
}

function applyProvenance(provenance, text, event) {
  const { selectionStart: start, selectionEnd: end, inputType, data } = event;
  if (inputType === "insertText") {
    return [...provenance.slice(0, start), ...Array(data.length).fill(true), ...provenance.slice(end)];
  }
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
    return [...provenance.slice(0, start), true, ...provenance.slice(end)];
  }
  if (inputType === "deleteContentBackward") {
    const deleteStart = start === end ? previousCodePointOffset(text, start) : start;
    return [...provenance.slice(0, deleteStart), ...provenance.slice(end)];
  }
  if (inputType === "deleteContentForward") {
    const deleteEnd = start === end ? nextCodePointOffset(text, end) : end;
    return [...provenance.slice(0, start), ...provenance.slice(deleteEnd)];
  }
  if (inputType === "insertReplacementText" || inputType === "observedMutation") {
    return [...provenance.slice(0, start), ...Array(data.length).fill(false), ...provenance.slice(end)];
  }
  return provenance;
}

function rangesFromProvenance(provenance) {
  const ranges = [];
  let start = null;
  for (let index = 0; index <= provenance.length; index += 1) {
    if (provenance[index] && start === null) start = index;
    if (!provenance[index] && start !== null) {
      ranges.push({ start, end: index });
      start = null;
    }
  }
  return ranges;
}
