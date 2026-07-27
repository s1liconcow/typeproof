import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../packages/proof-core/canonical.mjs";
import { PROTOCOL_VERSION } from "../packages/proof-core/protocol.mjs";
import { applyEdit, chooseCertifiedRanges, replayTranscript } from "../packages/proof-core/replay.mjs";
import { typingEvents } from "./helpers.mjs";

test("canonical JSON sorts nested object keys deterministically", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: "x" } }), '{"a":{"b":"x","y":true},"z":1}');
  assert.throws(() => canonicalJson({ value: undefined }), /Undefined/u);
});

test("transcript replay reconstructs individual keyboard inserts", () => {
  const events = typingEvents("Hi\nthere");
  const replay = replayTranscript({ initialText: "", finalText: "Hi\nthere", events, violations: [] });
  assert.equal(replay.ok, true);
  assert.equal(replay.reconstructedText, "Hi\nthere");
});

test("replay applies selection replacement and surrogate-pair deletion", () => {
  assert.equal(applyEdit("hello", { inputType: "insertText", data: "a", selectionStart: 1, selectionEnd: 4 }).text, "hao");
  assert.equal(applyEdit("a😀b", { inputType: "deleteContentBackward", data: null, selectionStart: 3, selectionEnd: 3 }).text, "ab");
  assert.equal(applyEdit("a😀b", { inputType: "deleteContentForward", data: null, selectionStart: 1, selectionEnd: 1 }).text, "ab");
});

test("paste-shaped and synthetic events cannot pass replay", () => {
  const pasted = typingEvents("x");
  pasted[0].inputType = "insertFromPaste";
  assert.equal(replayTranscript({ initialText: "", finalText: "x", events: pasted, violations: [] }).code, "untrusted_event");

  const synthetic = typingEvents("x");
  synthetic[0].trusted = false;
  assert.equal(replayTranscript({ initialText: "", finalText: "x", events: synthetic, violations: [] }).code, "untrusted_event");
});

test("reported recorder violations invalidate an otherwise replayable transcript", () => {
  const events = typingEvents("x");
  const replay = replayTranscript({
    initialText: "",
    finalText: "x",
    events,
    violations: [{ code: "paste_attempted", detail: "blocked", atMs: 2 }]
  });
  assert.equal(replay.code, "recording_violation");
});

test("pre-existing editor text is reconstructed but excluded from certified typed provenance", () => {
  const events = typingEvents("new").map((event) => ({
    ...event,
    selectionStart: event.selectionStart + 10,
    selectionEnd: event.selectionEnd + 10
  }));
  const claim = {
    protocolVersion: PROTOCOL_VERSION,
    initialText: "signature\n",
    finalText: "signature\nnew",
    events,
    violations: []
  };
  claim.certifiedRanges = chooseCertifiedRanges(claim);
  const replay = replayTranscript(claim);
  assert.deepEqual(claim.certifiedRanges, [{ start: 10, end: 13 }]);
  assert.equal(replay.certifiedRangesOk, true);
  assert.equal(replay.typedCharacterCount, 3);
  assert.equal(replay.reconstructedText, "signature\nnew");
});

test("editor-assisted autocorrect is replayed but excluded from typed provenance", () => {
  const events = typingEvents("teh rest");
  events.push({
    sequence: events.length,
    deltaMs: 80,
    inputType: "insertReplacementText",
    browserInputType: "insertReplacementText",
    data: "he",
    selectionStart: 1,
    selectionEnd: 3,
    trusted: true,
    key: null
  });
  const claim = {
    protocolVersion: PROTOCOL_VERSION,
    initialText: "",
    finalText: "the rest",
    events,
    violations: []
  };
  claim.certifiedRanges = chooseCertifiedRanges(claim);
  const replay = replayTranscript(claim);
  assert.equal(replay.ok, true);
  assert.equal(replay.reconstructedText, "the rest");
  assert.equal(replay.typedEventCount, 8);
  assert.equal(replay.observedEditCount, 1);
  assert.deepEqual(replay.certifiedRanges, [{ start: 0, end: 1 }, { start: 3, end: 8 }]);
  assert.equal(replay.certifiedRangesOk, true);
  assert.equal(replay.typedCharacterCount, 6);

  const incompleteRanges = structuredClone(claim);
  incompleteRanges.certifiedRanges = [{ start: 3, end: 8 }];
  assert.equal(replayTranscript(incompleteRanges).certifiedRangesOk, false);

  const legacyRange = { ...claim, protocolVersion: "1.4", certifiedRanges: undefined, certifiedRange: { start: 3, end: 8 } };
  const legacyReplay = replayTranscript(legacyRange);
  assert.equal(legacyReplay.certifiedRangeOk, true);
  assert.equal(legacyReplay.certifiedText, " rest");

  const legacyClaim = { ...claim, protocolVersion: "1.1" };
  assert.equal(replayTranscript(legacyClaim).code, "unsupported_replacement");

  const autocomplete = structuredClone(claim);
  autocomplete.events.at(-1).selectionStart = 3;
  autocomplete.events.at(-1).selectionEnd = 3;
  assert.equal(replayTranscript(autocomplete).code, "invalid_replacement");
});

test("a witnessed localized DOM replacement is replayed as unverified", () => {
  const events = typingEvents("teh ");
  events.push({
    sequence: events.length,
    deltaMs: 40,
    inputType: "observedMutation",
    browserInputType: null,
    data: "he",
    selectionStart: 1,
    selectionEnd: 3,
    trusted: false,
    key: null,
    source: "dom-mutation"
  });
  const claim = {
    protocolVersion: PROTOCOL_VERSION,
    initialText: "",
    finalText: "the ",
    events,
    violations: [],
    certifiedRanges: [{ start: 0, end: 1 }, { start: 3, end: 4 }]
  };
  const replay = replayTranscript(claim);
  assert.equal(replay.ok, true);
  assert.equal(replay.certifiedRangesOk, true);
  assert.deepEqual(replay.certifiedRanges, claim.certifiedRanges);
  assert.equal(replay.observedEditCount, 1);

  const forgedTypedMutation = structuredClone(claim);
  forgedTypedMutation.events.at(-1).trusted = true;
  assert.equal(replayTranscript(forgedTypedMutation).code, "invalid_replacement");
});

test("observed input-event mutations can safely insert or delete unverified text", () => {
  const typed = typingEvents("ab");
  const inserted = {
    sequence: 2,
    deltaMs: 20,
    inputType: "observedMutation",
    browserInputType: "insertCompositionText",
    data: "X",
    selectionStart: 1,
    selectionEnd: 1,
    trusted: true,
    key: null,
    source: "input-event"
  };
  const deleted = {
    ...inserted,
    sequence: 3,
    browserInputType: "deleteWordBackward",
    data: "",
    selectionStart: 1,
    selectionEnd: 2
  };
  const replay = replayTranscript({
    protocolVersion: PROTOCOL_VERSION,
    initialText: "",
    finalText: "ab",
    events: [...typed, inserted, deleted],
    violations: [],
    certifiedRanges: [{ start: 0, end: 2 }]
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.reconstructedText, "ab");
  assert.equal(replay.certifiedRangesOk, true);
  assert.equal(replay.observedEditCount, 2);
});
