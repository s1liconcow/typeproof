import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTypeProofServer } from "../apps/backend/src/server.mjs";
import { verifyProof } from "../packages/proof-core/verify.mjs";

const chromeBinary = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const chromeVersion = spawnSync(chromeBinary, ["--version"], { encoding: "utf8" }).stdout.trim();
const brandedChromeMatch = chromeVersion.match(/^Google Chrome (\d+)/u);
if (brandedChromeMatch && Number(brandedChromeMatch[1]) >= 137) {
  throw new Error(
    `${chromeVersion} disables --load-extension. Set CHROME_BIN to a Chrome for Testing or Chromium executable. ` +
    "See https://developer.chrome.com/blog/extension-news-june-2025#removing-the---load-extension-flag"
  );
}
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "typeproof-chrome-e2e-"));
let browser;
let application;

try {
  application = await createTypeProofServer({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataDirectory: path.join(temporaryRoot, "witness"),
      challengeTtlMs: 60_000,
      maxBodyBytes: 20 * 1024 * 1024
    }
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const serverPort = application.server.address().port;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const extensionPath = path.resolve("dist/extension");

  const chromeArguments = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    `--user-data-dir=${path.join(temporaryRoot, "chrome-profile")}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "about:blank"
  ];
  if (process.env.TYPEPROOF_CHROME_HEADLESS !== "0") chromeArguments.unshift("--headless=new");
  browser = spawn(chromeBinary, chromeArguments, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });

  const cdp = createPipeTransport(browser);
  const contexts = [];
  cdp.onEvent((message) => {
    if (message.method === "Runtime.executionContextCreated") contexts.push({ sessionId: message.sessionId, ...message.params.context });
    if (message.method === "Runtime.executionContextDestroyed") {
      const index = contexts.findIndex((context) => context.sessionId === message.sessionId && context.id === message.params.executionContextId);
      if (index !== -1) contexts.splice(index, 1);
    }
    if (message.method === "Runtime.executionContextsCleared") {
      for (let index = contexts.length - 1; index >= 0; index -= 1) {
        if (contexts[index].sessionId === message.sessionId) contexts.splice(index, 1);
      }
    }
  });

  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: `${serverUrl}/write` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  let isolatedContextId;
  try {
    isolatedContextId = await waitFor(async () => {
    for (const context of contexts.filter((item) => item.sessionId === sessionId)) {
      try {
        const result = await evaluate(cdp, sessionId, context.id, "Boolean(globalThis.__typeProofRecorderInstalled && chrome?.runtime?.sendMessage)");
        if (result === true) return context.id;
      } catch {
        // Navigation may invalidate a context between discovery and evaluation.
      }
    }
    return null;
    }, 10_000, "TypeProof content-script execution context");
  } catch (error) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    throw new Error(`${error.message}\nContexts: ${JSON.stringify(contexts)}\nTargets: ${JSON.stringify(targetInfos.map(({ type, url, title }) => ({ type, url, title })))}\nChrome: ${cdp.getStderr()}`);
  }
  await (async () => {
    const mainContext = contexts.find((item) => item.sessionId === sessionId && item.auxData?.isDefault)?.id;
    assert.ok(mainContext, "Chrome created a main execution context");
    assert.equal(await evaluate(cdp, sessionId, mainContext, "Boolean(document.querySelector('#writing-pad')?.focus() || true)"), true);

    const saved = await evaluate(cdp, sessionId, isolatedContextId,
      `(async () => chrome.runtime.sendMessage({type: "SET_SERVER_URL", serverUrl: ${JSON.stringify(serverUrl)}}))()`);
    assert.equal(saved.ok, true, saved.error);
    assert.equal(await evaluate(cdp, sessionId, isolatedContextId, `(() => {
      globalThis.__typeProofRecorderInstallation.dispose();
      delete globalThis.__typeProofRecorderInstallation;
      globalThis.__typeProofRecorderInstalled = true;
      return true;
    })()`), true);
    const started = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(started.ok, true, started.error);
    assert.equal(await evaluate(cdp, sessionId, isolatedContextId,
      "globalThis.__typeProofRecorderInstallation?.version === chrome.runtime.getManifest().version"), true);
    const validVisualState = await evaluate(cdp, sessionId, mainContext, `(() => {
      const pad = document.querySelector("#writing-pad");
      return { state: pad.dataset.typeproofRecording, outline: pad.style.getPropertyValue("outline") };
    })()`);
    assert.equal(validVisualState.state, "true");
    assert.match(validVisualState.outline, /31, 143, 87/u);

    const content = "hello proof";
    for (const character of content) {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }

    const stopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(stopped.ok, true, stopped.error);
    const clearedVisualState = await evaluate(cdp, sessionId, mainContext, `(() => {
      const pad = document.querySelector("#writing-pad");
      return { state: pad.hasAttribute("data-typeproof-recording"), outline: pad.style.getPropertyValue("outline") };
    })()`);
    assert.equal(clearedVisualState.state, false);
    assert.equal(clearedVisualState.outline, "");
    assert.equal(stopped.proof.claim.finalText, content);
    const verification = await verifyProof(stopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(verification.valid, true, JSON.stringify(verification.checks.filter((check) => !check.ok)));
    assert.equal(verification.content, content);
    const apiResponse = await fetch(`${serverUrl}/v1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stopped.proof)
    });
    const apiVerification = await apiResponse.json();
    assert.equal(apiResponse.status, 200);
    assert.equal(apiVerification.valid, true);

    const publicationResponse = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'PUBLISH_LAST_PROOF'}))()");
    assert.equal(publicationResponse.ok, true, publicationResponse.error);
    assert.match(publicationResponse.publication.verificationUrl, /\/p\/tp_/u);
    assert.match(await (await fetch(publicationResponse.publication.badgeUrl)).text(), /verified typing/u);

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const rich = document.createElement("div");
      rich.id = "rich-editor";
      rich.contentEditable = "true";
      rich.innerHTML = "<div>Existing signature</div><div><br></div>";
      document.body.replaceChildren(rich);
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await delay(50);
    const richStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(richStarted.ok, true, richStarted.error);
    for (const character of "rich") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    await dispatchEnter(cdp, sessionId);
    await delay(30);
    for (const character of "surface") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    const richStopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(richStopped.ok, true, richStopped.error);
    const richVerification = await verifyProof(richStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(richVerification.valid, true, JSON.stringify(richVerification.checks.filter((check) => !check.ok)));
    assert.equal(richVerification.content, "Existing signature\nrich\nsurface");
    assert.deepEqual(richVerification.typedRanges, [{ start: 19, end: 31 }]);
    assert.equal(richStopped.proof.claim.initialText, "Existing signature\n");

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const gmail = document.createElement("div");
      gmail.id = "gmail-editor";
      gmail.contentEditable = "true";
      gmail.setAttribute("role", "textbox");
      gmail.setAttribute("aria-label", "Message Body");
      gmail.innerHTML = "<div><br></div>";
      gmail.addEventListener("input", (event) => {
        if (!event.isTrusted) return;
        if (gmail.__correctNextInput) {
          gmail.__correctNextInput = false;
          const walker = document.createTreeWalker(gmail, NodeFilter.SHOW_TEXT);
          let text = walker.nextNode();
          while (text && !text.nodeValue.includes("teh")) text = walker.nextNode();
          if (!text) throw new Error("Autocorrect fixture could not find the misspelled text");
          text.nodeValue = text.nodeValue.replace("teh", "the");
          const range = document.createRange();
          range.selectNodeContents(gmail);
          range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        gmail.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: event.inputType,
          data: event.data
        }));
      });
      document.body.replaceChildren(gmail);
      gmail.focus();
      const range = document.createRange();
      range.selectNodeContents(gmail);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await delay(50);
    const gmailStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(gmailStarted.ok, true, gmailStarted.error);
    for (const character of "teh") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    await evaluate(cdp, sessionId, mainContext,
      "Boolean(document.querySelector('#gmail-editor').__correctNextInput = true)");
    await dispatchCharacter(cdp, sessionId, " ");
    await delay(30);
    assert.equal(await evaluate(cdp, sessionId, mainContext,
      "document.querySelector('#gmail-editor').dataset.typeproofRecording"), "true");
    await evaluate(cdp, sessionId, mainContext, `(() => {
      const gmail = document.querySelector("#gmail-editor");
      const walker = document.createTreeWalker(gmail, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await cdp.send("Input.insertText", { text: "The" }, sessionId);
    await delay(30);
    for (const character of "rest") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    const gmailStopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(gmailStopped.ok, true, gmailStopped.error);
    const gmailVerification = await verifyProof(gmailStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(gmailVerification.valid, true, JSON.stringify(gmailVerification.checks.filter((check) => !check.ok)));
    assert.deepEqual(gmailStopped.proof.claim.violations, []);
    assert.equal(gmailVerification.documentContent, "Therest ");
    assert.equal(gmailVerification.content, "Therest ");
    assert.deepEqual(gmailVerification.typedRanges, [{ start: 3, end: 8 }]);
    assert.equal(gmailVerification.metrics.typedCharacterCount, 5);
    assert.equal(gmailVerification.metrics.documentCharacterCount, 8);
    assert.equal(gmailVerification.metrics.observedEditCount, 2);
    const gmailAssistedEvents = gmailStopped.proof.claim.events.filter((event) => event.inputType === "observedMutation");
    assert.deepEqual(gmailAssistedEvents.map((event) => event.source).sort(), ["dom-mutation", "input-event"]);
    assert.deepEqual(gmailAssistedEvents.map((event) => event.trusted).sort(), [false, true]);

    const gmailPublication = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'PUBLISH_LAST_PROOF'}))()");
    assert.equal(gmailPublication.ok, true, gmailPublication.error);
    const { targetId: proofTargetId } = await cdp.send("Target.createTarget", { url: gmailPublication.publication.verificationUrl });
    const { sessionId: proofSessionId } = await cdp.send("Target.attachToTarget", { targetId: proofTargetId, flatten: true });
    await cdp.send("Runtime.enable", {}, proofSessionId);
    await cdp.send("Page.enable", {}, proofSessionId);
    const proofContextId = await waitFor(() =>
      contexts.find((item) => item.sessionId === proofSessionId && item.auxData?.isDefault)?.id || null,
    5000, "published proof execution context");
    const renderedProof = await waitFor(async () => {
      try {
        return await evaluate(cdp, proofSessionId, proofContextId, `(() => {
          const content = document.querySelector("#certified-content");
          if (!content || document.querySelector("#published-result")?.hidden) return null;
          return {
            content: content.textContent,
            assisted: [...content.querySelectorAll(".assisted-text")].map((node) => node.textContent),
            typed: [...content.querySelectorAll(".typed-text")].map((node) => node.textContent)
          };
        })()`);
      } catch {
        return null;
      }
    }, 5000, "published proof rendering");
    assert.equal(renderedProof.content, "Therest ");
    assert.deepEqual(renderedProof.assisted, ["The"]);
    assert.deepEqual(renderedProof.typed, ["rest "]);
    await cdp.send("Target.closeTarget", { targetId: proofTargetId });

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const root = document.createElement("section");
      root.dataset.contentEditableRoot = "true";
      root.innerHTML = '<div contenteditable="true">Existing title</div><div id="block" contenteditable="true"><br></div>';
      document.body.replaceChildren(root);
      const block = document.querySelector("#block");
      block.focus();
      const range = document.createRange();
      range.selectNodeContents(block);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    })()`);
    await delay(50);
    const blockStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(blockStarted.ok, true, blockStarted.error);
    for (const character of "block editor") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    const blockStopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(blockStopped.ok, true, blockStopped.error);
    const blockVerification = await verifyProof(blockStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(blockVerification.valid, true, JSON.stringify(blockVerification.checks.filter((check) => !check.ok)));
    assert.equal(blockVerification.content, "Existing title\nblock editor");
    assert.deepEqual(blockVerification.typedRanges, [{ start: 15, end: 27 }]);
    assert.equal(blockStopped.proof.claim.context.fieldKind, "block-editor");

    const mainFrameId = contexts.find((item) => item.sessionId === sessionId && item.id === mainContext).auxData.frameId;
    await evaluate(cdp, sessionId, mainContext, `(async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = '<textarea id="framed"></textarea>';
      document.body.replaceChildren(frame);
      await new Promise((resolve) => frame.addEventListener("load", resolve, {once: true}));
      return true;
    })()`);
    const childDefaultContext = await waitFor(() => {
      return contexts.find((item) => item.sessionId === sessionId && item.auxData?.isDefault && item.auxData.frameId !== mainFrameId)?.id || null;
    }, 5000, "iframe default execution context");
    const childFrameId = contexts.find((item) => item.sessionId === sessionId && item.id === childDefaultContext).auxData.frameId;
    const childIsolatedContext = await waitFor(async () => {
      for (const context of contexts.filter((item) => item.sessionId === sessionId && item.auxData?.frameId === childFrameId && !item.auxData?.isDefault)) {
        try {
          if (await evaluate(cdp, sessionId, context.id, "Boolean(globalThis.__typeProofRecorderInstalled && chrome?.runtime?.sendMessage)")) return context.id;
        } catch {
          // The iframe may still be establishing its isolated world.
        }
      }
      return null;
    }, 5000, "iframe TypeProof content context");
    await evaluate(cdp, sessionId, childDefaultContext, "Boolean(document.querySelector('#framed').focus() || true)");
    await delay(50);
    const iframeStarted = await evaluate(cdp, sessionId, childIsolatedContext,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(iframeStarted.ok, true, iframeStarted.error);
    for (const character of "iframe text") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    const iframeStopped = await evaluate(cdp, sessionId, childIsolatedContext,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(iframeStopped.ok, true, iframeStopped.error);
    const iframeVerification = await verifyProof(iframeStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(iframeVerification.valid, true, JSON.stringify(iframeVerification.checks.filter((check) => !check.ok)));
    assert.equal(iframeVerification.content, "iframe text");

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const host = document.createElement("div");
      document.body.replaceChildren(host);
      const shadow = host.attachShadow({mode: "open"});
      shadow.innerHTML = '<textarea id="shadow-editor"></textarea>';
      shadow.querySelector("#shadow-editor").focus();
      return true;
    })()`);
    await delay(50);
    const shadowStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(shadowStarted.ok, true, shadowStarted.error);
    for (const character of "shadow text") {
      await dispatchCharacter(cdp, sessionId, character);
      await delay(30);
    }
    const shadowStopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(shadowStopped.ok, true, shadowStopped.error);
    const shadowVerification = await verifyProof(shadowStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(shadowVerification.valid, true, JSON.stringify(shadowVerification.checks.filter((check) => !check.ok)));
    assert.equal(shadowVerification.content, "shadow text");

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const focusEditor = document.createElement("div");
      focusEditor.id = "focus-editor";
      focusEditor.contentEditable = "true";
      focusEditor.innerHTML = "<br>";
      focusEditor.addEventListener("focus", () => {
        if (!focusEditor.__applyFocusInitialization) return;
        focusEditor.__applyFocusInitialization = false;
        focusEditor.textContent = "Gmail signature";
        const range = document.createRange();
        range.selectNodeContents(focusEditor);
        range.collapse(false);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      document.body.replaceChildren(focusEditor);
      focusEditor.focus();
      return true;
    })()`);
    await delay(50);
    const focusStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(focusStarted.ok, true, focusStarted.error);
    await evaluate(cdp, sessionId, mainContext, `(() => {
      const editor = document.querySelector("#focus-editor");
      const button = document.createElement("button");
      document.body.append(button);
      editor.__applyFocusInitialization = true;
      button.focus();
      editor.focus();
      return true;
    })()`);
    await delay(300);
    assert.equal(await evaluate(cdp, sessionId, mainContext,
      "document.querySelector('#focus-editor').dataset.typeproofRecording"), "true");
    await dispatchCharacter(cdp, sessionId, "x");
    await delay(30);
    const focusStopped = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'STOP_RECORDING'}))()", 30_000);
    assert.equal(focusStopped.ok, true, focusStopped.error);
    assert.equal(focusStopped.proof.claim.initialText, "Gmail signature");
    assert.equal(focusStopped.proof.claim.finalText, "Gmail signaturex");
    const focusVerification = await verifyProof(focusStopped.proof, { trustedServerKeyId: application.witnessKey.keyId });
    assert.equal(focusVerification.valid, true, JSON.stringify(focusVerification.checks.filter((check) => !check.ok)));
    assert.equal(focusVerification.content, "Gmail signaturex");
    assert.deepEqual(focusVerification.typedRanges, [{ start: 15, end: 16 }]);

    await evaluate(cdp, sessionId, mainContext, `(() => {
      const invalidEditor = document.createElement("textarea");
      invalidEditor.id = "invalid-editor";
      document.body.replaceChildren(invalidEditor);
      invalidEditor.focus();
      return true;
    })()`);
    await delay(50);
    const invalidStarted = await evaluate(cdp, sessionId, isolatedContextId,
      "(async () => chrome.runtime.sendMessage({type: 'START_RECORDING'}))()");
    assert.equal(invalidStarted.ok, true, invalidStarted.error);
    await evaluate(cdp, sessionId, mainContext,
      "document.querySelector('#invalid-editor').dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true}))");
    const invalidVisualState = await evaluate(cdp, sessionId, mainContext, `(() => {
      const editor = document.querySelector("#invalid-editor");
      return { state: editor.dataset.typeproofRecording, outline: editor.style.getPropertyValue("outline") };
    })()`);
    assert.equal(invalidVisualState.state, "invalid");
    assert.match(invalidVisualState.outline, /190, 54, 54/u);
  })();

  console.log("Chrome E2E passed: Gmail autocorrect capture and full provenance rendering, focus initialization, green/red capture UX, stale-recorder recovery, textarea, block editor, iframe, open shadow DOM, publishing, badge, and both verifier paths.");
} finally {
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await Promise.race([exited, delay(3000)]);
  }
  if (application?.server.listening) await new Promise((resolve) => application.server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function createPipeTransport(process) {
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const eventListeners = new Set();
  let stderr = "";

  process.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  process.on("exit", (code) => {
    for (const { reject } of pending.values()) reject(new Error(`Chrome exited with code ${code}\n${stderr}`));
    pending.clear();
  });
  process.stdio[4].on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const delimiter = buffer.indexOf(0);
      if (delimiter === -1) break;
      const raw = buffer.subarray(0, delimiter).toString("utf8");
      buffer = buffer.subarray(delimiter + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.id) {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
      } else {
        for (const listener of eventListeners) listener(message);
      }
    }
  });

  return {
    onEvent(listener) { eventListeners.add(listener); },
    getStderr() { return stderr; },
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        process.stdio[3].write(`${JSON.stringify(message)}\0`);
      });
    }
  };
}

async function evaluate(cdp, sessionId, contextId, expression, timeout = 10_000) {
  const operation = cdp.send("Runtime.evaluate", {
    expression,
    contextId,
    awaitPromise: true,
    returnByValue: true
  }, sessionId).then((response) => {
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  });
  return Promise.race([
    operation,
    delay(timeout).then(() => { throw new Error(`Runtime.evaluate timed out: ${expression.slice(0, 80)}`); })
  ]);
}

async function dispatchCharacter(cdp, sessionId, character) {
  const isSpace = character === " ";
  const key = isSpace ? " " : character;
  const code = isSpace ? "Space" : `Key${character.toUpperCase()}`;
  const virtualKeyCode = isSpace ? 32 : character.toUpperCase().charCodeAt(0);
  const common = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: character, unmodifiedText: character, ...common }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
}

async function dispatchEnter(cdp, sessionId) {
  const common = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...common }, sessionId);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
}

async function waitFor(operation, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
