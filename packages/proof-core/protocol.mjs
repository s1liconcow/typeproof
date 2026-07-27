export const PROTOCOL_VERSION = "1.5";
export const SUPPORTED_PROTOCOL_VERSIONS = new Set(["1.1", "1.2", "1.3", "1.4", PROTOCOL_VERSION]);
export const CERTIFIED_RANGES_PROTOCOL_VERSIONS = new Set(["1.5"]);
export const EXTENSION_VERSION = "0.6.0";
export const MAX_EVENTS = 100_000;
export const MAX_TEXT_LENGTH = 1_000_000;
export const ALLOWED_INPUT_TYPES = new Set([
  "insertText",
  "insertLineBreak",
  "insertParagraph",
  "deleteContentBackward",
  "deleteContentForward"
]);
export const OBSERVED_INPUT_TYPES = new Set(["insertReplacementText", "observedMutation"]);

export const VIOLATION_CODES = Object.freeze({
  ALREADY_INVALID: "already_invalid",
  COMPOSITION: "composition_or_ime",
  DISALLOWED_INPUT: "disallowed_input_type",
  DROP: "drop_attempted",
  ELEMENT_CHANGED: "element_changed",
  EVENT_MISMATCH: "event_mismatch",
  INITIAL_CONTENT: "field_not_empty",
  MISSING_KEYDOWN: "missing_keyboard_event",
  NON_TRUSTED: "non_trusted_event",
  PASTE: "paste_attempted",
  PROGRAMMATIC_CHANGE: "programmatic_change",
  TOO_LARGE: "proof_limit_exceeded"
});

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
