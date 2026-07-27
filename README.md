# TypeProof

TypeProof is a Chrome extension and witness service that creates tamper-evident evidence of how a piece of text was entered. It records a strict, replayable edit transcript, commits each edit to a remote witness while the user types, signs the completed claim with a non-extractable browser key, and obtains a signed witness receipt.

The precise claim is:

> During the witnessed time window, the recorder observed a replayable sequence of trusted keyboard edits and explicitly marked unverified editor-assisted mutations. The complete document is reconstructed, while exact typed ranges distinguish keyboard-originated characters from autocorrected, assisted, or pre-existing text.

That is useful provenance evidence. It is deliberately **not** advertised as absolute proof that a human originated the ideas or that AI was not involved. A user can manually retype AI-generated text, and a compromised browser/OS or input-injection device can forge trusted-looking events. Cryptography makes the evidence tamper-evident and binds it to a witness timeline; it cannot turn a commodity browser into a trusted execution environment.

## What is included

- A Manifest V3 Chrome extension with a persistent, non-extractable P-256 signing key.
- Strict recording across `<textarea>`, plain-text `<input>`, rich `contenteditable`, multi-block editors, same/cross-origin frames, and open shadow roots.
- A subtle green capture outline that switches to red immediately when the session becomes invalid.
- Character-level provenance that excludes signatures, titles, pre-existing draft text, and editor-assisted mutation characters.
- A clean writing pad served by the backend for arbitrary prose.
- A Node.js witness API with no third-party runtime dependencies.
- One-time signed challenges and per-edit signed rolling hash checkpoints.
- Independent transcript replay, device-signature verification, and signed receipts.
- A browser verification page and a command-line verifier.
- Opt-in public permalinks with SVG badges plus HTML and Markdown embed snippets.
- Adversarial tests for tampering, paste-shaped events, nonce reuse, and trust-key substitution.

## Quick start

Requirements: Node.js 20+ and Chrome 109+.

```bash
npm test
npm run build
npm start
```

The witness and writing pad are now at `http://127.0.0.1:8787`.

In Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/extension`.
4. Open Gmail, Notion, Substack, the included writing pad, or another DOM-based editor.
5. Focus the editing surface, open the popup, and start a session.
6. Type, then use **Stop & seal proof**. The extension downloads the JSON proof and retains the latest proof in extension storage.
7. Optionally choose **Publish proof publicly…** to get a verification URL, badge URL, and embeddable HTML.

Verify the artifact in the web UI at `http://127.0.0.1:8787/`, or from the repository:

```bash
npm run verify -- /path/to/typeproof-session.json
```

For a verifier that must trust one particular service, pin the key shown by `GET /v1/info`:

```bash
npm run verify -- /path/to/proof.json --trusted-key-id 'p256:...'
```

Without `--trusted-key-id`, the CLI verifies the self-contained cryptographic chain but does not establish who operates the embedded witness key. The hosted verification page always pins its own witness key.

## How it works

```text
Chrome extension                         Witness service
       |                                       |
       |-- recorder public key + page origin ->|
       |<----- signed one-time challenge ------|
       |                                       |
 key 1 |-- signed rolling hash checkpoint ---->|
 key 2 |-- signed rolling hash checkpoint ---->|
  ...  |                  ...                  |
       |-- signed claim + complete transcript >|
       |<-- signed acceptance receipt ----------|
       |
       `-- self-contained JSON proof
```

The verifier then:

1. Recomputes the recorder and witness key identifiers.
2. Verifies the witness-signed challenge and its session/key/origin binding.
3. Verifies the recorder signature over the complete claim.
4. Replays every insert/delete from the initial editor snapshot and compares the exact final text.
5. Tracks provenance per final character and certifies every range made entirely from witnessed inserts.
6. Recomputes the rolling event-chain root.
7. Checks that the receipt covers one live checkpoint per event with a plausible timeline.
8. Verifies that the witness receipt binds the exact signed envelope, complete document, and typed ranges.
9. Optionally compares the witness key to an external trust anchor.

See [Protocol](docs/protocol.md) for the signed structures and [Security model](docs/security.md) for the threat analysis.

## Recorder profile

Accepted edits:

- One Unicode character from a matching trusted `keydown` + `beforeinput` + `input` sequence.
- Enter/line break.
- Rich-editor paragraph insertion.
- Backspace and forward delete.
- Selection replacement using one accepted character.

Noted without invalidating the session:

- Autocorrect, spellcheck, autocomplete, composition/IME, dictation, formatting changes, and other editor mutations that cannot be attributed to one matching physical key. Each splice is checkpointed and replayed, but inserted characters do not receive typed provenance.

The following invalidate the entire session, even when blocked before the field changes:

- Paste and drop.
- The captured editing surface being replaced or removed.
- Proof-size limits being exceeded.
- Losing the live witness checkpoint stream.

For rich editors, the recorder canonicalizes visible editor text and infers the single plain-text splice caused by each change. A matching trusted key event receives typed provenance. Other input-event or DOM changes are checkpointed as unverified editor mutations. Formatting-only actions are ignored when they do not change text.

Some editors finish initializing their compose body when focus returns from the extension popup. Until the first accepted edit, these focus-time changes are absorbed into the unverified initial snapshot. Later editor changes are retained as assisted mutations rather than being represented as keyboard-originated text.

The generic adapters cover the DOM editing models used by Gmail, Notion-style block editors, Substack/ProseMirror, and similar applications without relying on site-specific class names. The fail-closed model means a site update or unusual editor action may invalidate a session rather than create a false proof. Canvas-based editors, closed shadow roots, browser-internal pages, and editors that do not expose standard keyboard/`beforeinput`/`input` events cannot be recorded.

## Backend configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPEPROOF_HOST` | `127.0.0.1` | Listen address |
| `TYPEPROOF_PORT` | `8787` | Listen port |
| `TYPEPROOF_DATA_DIR` | `.data` | Persistent witness signing key directory |
| `TYPEPROOF_CHALLENGE_TTL_MS` | `3600000` | Session lifetime, 1 minute–24 hours |
| `TYPEPROOF_MAX_BODY_BYTES` | `20971520` | Maximum JSON request size |
| `TYPEPROOF_PUBLIC_BASE_URL` | unset | HTTPS public origin used in published links and badges |

Remote witness URLs must use HTTPS. The extension permits plaintext HTTP only for `localhost`, `127.0.0.1`, and `[::1]` development.

The reference service keeps in-flight sessions and checkpoint logs in memory. Explicitly published proofs are stored under `TYPEPROOF_DATA_DIR/published-proofs`; unpublished completed proofs are not retained. For production, replace `SessionStore` with transactional durable storage, make one-time finalization atomic, keep the witness key in a KMS/HSM, add authentication/rate limits, publish and pin the witness key, and operate behind TLS. Do not put the current reference server directly on the public internet without those controls.

The optional real-browser smoke test drives Chrome through its debugging pipe and exercises the unpacked extension against an ephemeral witness:

```bash
# Chrome for Testing or Chromium is required because branded Chrome 137+
# disables command-line unpacked-extension loading.
CHROME_BIN=/path/to/chrome-for-testing npm run test:chrome

# Add TYPEPROOF_CHROME_HEADLESS=0 when using a desktop/Xvfb display if needed.
```

## Project layout

```text
apps/extension/       Manifest V3 recorder and popup
apps/backend/         Witness API, writing pad, and verifier UI
packages/proof-core/  Canonicalization, crypto, replay, verification
scripts/              Reproducible zero-dependency build
test/                 Unit, adversarial, service, and HTTP tests
```

## Privacy

The proof artifact contains the initial/final editor snapshots and the character-level edit transcript. The witness receives only signed rolling hashes while typing, then receives the full transcript and text at finalization so it can replay and approve the claim. Completed proofs remain local unless the user explicitly publishes one. Publishing stores the full artifact and certified text on the witness for anyone with the unguessable link; it is not a private-share mechanism. Normal reverse-proxy/access logging and production storage policies are operator responsibilities. Treat proof files as sensitive documents.

## License

MIT
