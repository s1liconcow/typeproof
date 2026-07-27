# Security model

## What the cryptography establishes

Assuming the recorder private key, witness private key, extension code, and verifier are not compromised, a valid proof establishes all of the following:

- The signed claim has not changed since the recorder sealed it.
- The witness issued the challenge before the claim was finalized.
- The witness received a recorder-signed rolling commitment for every accepted edit, in order, during the session.
- The event sequence exactly reconstructs the final content from the initial editor snapshot.
- Every claimed typed range exactly identifies characters introduced by accepted witnessed inserts; assisted and pre-existing content remains visible but outside typed provenance.
- The transcript contains only the strict input profile, explicitly unverified editor-assisted mutations, and no recorder-reported violations.
- The witness independently checked the transcript and bound its receipt to that exact signed envelope.
- When a witness key is externally pinned, the receipt came from that witness key rather than an arbitrary self-declared key.

This is provenance evidence about a recorder's observations. It is not semantic authorship detection.

## Threats and boundaries

| Threat | Result | Reason |
| --- | --- | --- |
| Edit the JSON text or transcript after sealing | Detected | Recorder signature, event root, envelope digest, and receipt fail |
| Reuse a challenge for different content | Detected | Session finalization is one-time and idempotent only for the identical envelope |
| Autocorrect, spellcheck, autocomplete, composition/IME, dictation, or another editor mutation | Recorded, not typed provenance | The complete document remains visible while the exact assisted splice receives unverified provenance |
| Scripted value or DOM mutation | Recorded, not certified | The observed splice reconstructs the document but cannot add typed provenance |
| Paste or drop | Detected | The recorder blocks/reports it and replay fails closed |
| Submit all events instantly at finalize | Detected | The witness requires a signed live checkpoint per event and a minimally plausible server-observed span |
| Substitute a different witness | Detected only when the relying party pins a trusted key | An embedded public key alone has no external identity |
| Manually retype AI-generated or copied text | **Not detected** | Keystrokes do not reveal where ideas came from |
| OS accessibility automation, USB keyboard emulator, remote desktop, or compromised input driver | **Not reliably detected** | Chrome may mark OS-injected events as trusted |
| Modified/malicious extension or browser | **Not reliably detected** | Chrome extensions lack remote attestation for their JavaScript and event source |
| Compromised witness key/service | **Not detected by that witness** | The witness is a trust anchor and can issue false receipts |
| Hostile page interferes with browser event delivery | May invalidate or evade observation | Use the included writing pad for the strongest supported environment |
| Traffic analysis before finalization | Partially exposed | Checkpoint count/timing is visible; content is hashed until finalization |
| Published verification link leaks content | By design | Publication is explicit and makes the full proof publicly retrievable to anyone with the link |
| Rich editor changes its DOM model | Text splice is noted; surface loss fails closed | A connected surface's text change is replayed as unverified, while replacement/removal of the captured surface invalidates the session |

## Why this cannot prove “not AI-generated” absolutely

Authorship provenance and text classification are different problems. A language model can produce text that a person later types. A person can copy from paper. A program can emulate a keyboard through the operating system. None of those facts is encoded in the resulting character stream, so no signature over browser events can recover them.

TypeProof therefore avoids AI probability scores and makes a narrower, auditable claim. The verifier shows named checks and the limitations beside the verdict. Applications embedding TypeProof should preserve that wording and must not relabel the result as guaranteed human authorship.

## Stronger future profiles

A higher-assurance deployment could add:

- a managed, locked-down browser and signed extension distribution;
- device posture/enterprise attestation;
- a hardware keyboard or trusted input path that signs scan codes;
- WebAuthn user verification at session start and finish;
- durable transparency logs for witness receipts;
- multiple independent witnesses;
- anomaly/keystroke-dynamics signals clearly labeled as probabilistic.

WebAuthn alone proves authenticator participation at a prompt; it does not attest every intervening keystroke. Behavioral classifiers can raise abuse cost but are not cryptographic proof.

## Reference-service deployment

The included service is suitable for local development and protocol evaluation. A production operator must add durable transactional session state, atomic one-use enforcement across replicas, authenticated/rate-limited callers, abuse controls, request timeouts, structured audit logging without text leakage, TLS, key rotation metadata, backup/recovery, and a KMS/HSM-held witness key. The public key and rotation history should be published through an authenticated channel so verifiers can pin them.
