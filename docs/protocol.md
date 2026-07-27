# TypeProof protocol 1.5

This document describes the interoperability and signed-data rules implemented by `packages/proof-core`. It is a deliberately narrow protocol, not a general claim that browser input is hardware-attested.

## Encoding and algorithms

- All signed objects use UTF-8 canonical JSON: arrays retain order and object keys are lexicographically sorted.
- Numeric protocol values are non-negative safe integers.
- Hashes use SHA-256 and unpadded base64url encoding.
- Recorder and witness signatures use ECDSA P-256 with SHA-256.
- Key IDs are `p256:` plus the SHA-256 canonical-object digest of `{crv,kty,x,y}`.
- The initial event-chain value is the literal string `typeproof:event-chain:v1`.
- Each new root is `SHA-256(canonical({previous, event}))`, encoded as base64url.

New sessions use `protocolVersion: "1.5"`. The verifier retains read-only support for version 1.1 through 1.4 proofs; unknown versions fail closed.

## Session challenge

The recorder submits its public JWK, key ID, and exact page origin. The witness returns:

```json
{
  "challenge": {
    "payload": {
      "protocolVersion": "1.5",
      "sessionId": "random 144-bit identifier",
      "nonce": "random 256-bit value",
      "issuedAt": "ISO-8601 timestamp",
      "expiresAt": "ISO-8601 timestamp",
      "recorderKeyId": "p256:...",
      "origin": "https://example.test",
      "serverKeyId": "p256:..."
    },
    "signature": "witness ECDSA signature"
  },
  "serverPublicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }
}
```

The witness retains the recorder public key and one-time session state.

## Events and live checkpoints

An edit event contains:

```json
{
  "sequence": 0,
  "deltaMs": 123,
  "inputType": "insertText",
  "data": "a",
  "selectionStart": 0,
  "selectionEnd": 0,
  "trusted": true,
  "key": {
    "key": "a",
    "code": "KeyA",
    "altKey": false,
    "ctrlKey": false,
    "metaKey": false,
    "shiftKey": false,
    "repeat": false
  }
}
```

After accepting each edit locally, the recorder advances the chain and signs a checkpoint payload containing the protocol version, session ID, nonce, zero-based sequence, and new root. It posts this signature to the witness before finalization. The witness accepts checkpoints strictly in order and timestamps receipt.

Protocols 1.2 and 1.3 represented a trusted editor-assisted replacement with this explicit unverified event, which remains supported for verification:

```json
{
  "sequence": 3,
  "deltaMs": 41,
  "inputType": "insertReplacementText",
  "browserInputType": "insertText",
  "data": "he",
  "selectionStart": 1,
  "selectionEnd": 3,
  "trusted": true,
  "key": null
}
```

This event reconstructs the exact replacement and receives a live checkpoint, but `data` is assigned unverified provenance. It must replace a non-empty range; autocomplete-style insertion without replaced text remains disallowed.

Protocols 1.4 and 1.5 represent any non-keyboard editor splice as `observedMutation`. A mutation associated with a trusted input event uses `source: "input-event"`, retains the browser's input type, and carries `trusted: true`. A change detected only from the DOM uses `source: "dom-mutation"`, `browserInputType: null`, and `trusted: false`:

```json
{
  "sequence": 3,
  "deltaMs": 250,
  "inputType": "observedMutation",
  "browserInputType": null,
  "data": "he",
  "selectionStart": 1,
  "selectionEnd": 3,
  "trusted": false,
  "key": null,
  "source": "dom-mutation"
}
```

Observed mutations may insert, delete, or replace text. The recorder checkpoints each observation immediately. Removed text loses its previous provenance; inserted text receives unverified provenance. Composition/IME output is observed rather than treated as typed provenance. Paste and drop remain explicit violations rather than observed mutations.

Checkpoints do not disclose typed content before finalization: SHA-256 roots are opaque commitments. They do reveal activity volume and timing to the witness.

## Signed claim

At stop, the recorder signs `claim`, which binds:

- protocol version, session ID, and nonce;
- recorder public key, key ID, and extension version;
- exact page origin and supported field kind;
- client start/end timestamps;
- the exact initial and final plain-text editor snapshots;
- the complete ordered set of final-text ranges whose characters all have witnessed keyboard provenance;
- the complete ordered edit transcript;
- any recorder violations;
- the final event-chain root;
- the witness-signed challenge.

The submitted envelope is:

```json
{
  "protocolVersion": "1.5",
  "claim": { "...": "signed claim fields" },
  "deviceSignature": "recorder ECDSA signature"
}
```

The witness accepts only if every signature, binding, timestamp, checkpoint, event, replay result, and final root is valid. At least one event is required. It also requires the server-observed checkpoint span to average at least 5 ms between events; this catches instant batch submission but is not a human classifier.

## Receipt and complete proof

The witness signs a receipt containing:

- session ID;
- digest of the exact submitted signed envelope;
- digest of the complete reconstructed document, its exact ordered typed ranges, and the typed-character count;
- accepted verdict;
- total, typed, editor-assisted, and checkpoint counts plus the server-observed checkpoint span;
- client-claimed duration;
- witness timestamp and key ID.

The complete artifact adds:

```json
{
  "witness": {
    "serverPublicKey": { "...": "P-256 public JWK" },
    "receipt": {
      "payload": { "...": "receipt fields" },
      "signature": "witness ECDSA signature"
    }
  }
}
```

An embedded key proves internal cryptographic consistency, not operator identity. A relying party that cares which witness issued a receipt must compare `serverKeyId` against a key obtained through an authenticated external channel.

## Replay rules

Replay starts from the signed initial editor snapshot. Every initial UTF-16 code unit begins with unverified provenance. Accepted keyboard inserts add verified provenance. Deletions preserve or remove provenance as their splice dictates. Editor-assisted mutations preserve provenance outside the changed range and assign unverified provenance to every inserted code unit. The signed `certifiedRanges` array must exactly equal every non-empty keyboard-provenance range derived by replay; omitting a range or including an unverified code unit fails verification. This allows pre-existing Gmail signatures, Notion titles, autocorrected words, and other editor changes to remain visible in the complete witnessed document without being presented as touch typed.

Selection offsets are JavaScript UTF-16 offsets, matching browser input controls. Backspace/delete remove an entire adjacent surrogate pair when present.

`insertText` must contain exactly one Unicode code point and its `key.key` must match. `insertLineBreak`/`insertParagraph`, `deleteContentBackward`, and `deleteContentForward` must pair with Enter, Backspace, and Delete respectively. Legacy `insertReplacementText` events must be trusted replacements. Protocols 1.4 and 1.5 `observedMutation` events carry `key: null` and either valid input-event metadata or valid DOM-mutation metadata; they must describe a non-empty splice. Ctrl/Command-modified typed edits are not treated as typed provenance. Any violation entry fails the claim.

## Public publication

Publication is separate from finalization and requires an already valid proof. The reference service derives a non-enumerable public ID from the proof digest, persists the immutable artifact, and exposes a verification page, JSON representation, and dynamically verified SVG badge. The public URL and embed snippets are distribution metadata, not part of the signed proof.
