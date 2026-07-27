import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { loadOrCreateWitnessKey } from "./key-store.mjs";
import { SessionStore } from "./session-store.mjs";
import { createProofService, ServiceError } from "./service.mjs";
import { ProofStore } from "./proof-store.mjs";
import { PROTOCOL_VERSION } from "../../../packages/proof-core/protocol.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(sourceDirectory, "../public");

export async function createTypeProofServer(options = {}) {
  const config = options.config || loadConfig();
  const witnessKey = options.witnessKey || await loadOrCreateWitnessKey(config.dataDirectory);
  const sessions = options.sessions || new SessionStore();
  const service = createProofService({ witnessKey, sessions, challengeTtlMs: config.challengeTtlMs, now: options.now });
  const proofStore = options.proofStore || new ProofStore(path.join(config.dataDirectory, "published-proofs"));
  await proofStore.initialize();

  const server = createServer(async (request, response) => {
    try {
      setCors(response);
      if (request.method === "OPTIONS") return sendEmpty(response, 204);
      const requestUrl = new URL(request.url, "http://localhost");

      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && requestUrl.pathname === "/v1/info") {
        return sendJson(response, 200, {
          service: "TypeProof witness",
          protocolVersion: PROTOCOL_VERSION,
          serverKeyId: witnessKey.keyId,
          serverPublicKey: witnessKey.publicKey
        });
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/sessions") {
        const body = await readJson(request, config.maxBodyBytes);
        return sendJson(response, 201, await service.createSession(body));
      }
      const checkpointMatch = requestUrl.pathname.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)\/checkpoints$/u);
      if (request.method === "POST" && checkpointMatch) {
        const body = await readJson(request, config.maxBodyBytes);
        return sendJson(response, 202, await service.checkpointSession(checkpointMatch[1], body));
      }
      const finalizeMatch = requestUrl.pathname.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)\/finalize$/u);
      if (request.method === "POST" && finalizeMatch) {
        const body = await readJson(request, config.maxBodyBytes);
        return sendJson(response, 200, await service.finalizeSession(finalizeMatch[1], body));
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/verify") {
        const body = await readJson(request, config.maxBodyBytes);
        const verification = await service.verify(body);
        return sendJson(response, verification.valid ? 200 : 422, verification);
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/proofs") {
        const proof = await readJson(request, config.maxBodyBytes);
        const verification = await service.verify(proof);
        if (!verification.valid) throw new ServiceError(422, "proof_rejected", "Only a valid proof from this witness can be published", { checks: verification.checks });
        const record = await proofStore.publish(proof);
        return sendJson(response, 201, publicationDetails(record, publicOrigin(server, config)));
      }
      const publicProofMatch = requestUrl.pathname.match(/^\/v1\/proofs\/(tp_[A-Za-z0-9_-]{22})$/u);
      if (request.method === "GET" && publicProofMatch) {
        const record = await proofStore.get(publicProofMatch[1]);
        if (!record) return sendJson(response, 404, { error: { code: "proof_not_found", message: "Published proof not found" } });
        return sendJson(response, 200, { ...publicationDetails(record, publicOrigin(server, config)), proof: record.proof, verification: await service.verify(record.proof) }, "public, max-age=300");
      }
      const badgeMatch = requestUrl.pathname.match(/^\/badge\/(tp_[A-Za-z0-9_-]{22})\.svg$/u);
      if (request.method === "GET" && badgeMatch) {
        const record = await proofStore.get(badgeMatch[1]);
        if (!record) return sendText(response, 404, "Badge not found", "text/plain; charset=utf-8");
        const verification = await service.verify(record.proof);
        return sendBadge(response, verification);
      }
      const proofPageMatch = requestUrl.pathname.match(/^\/p\/(tp_[A-Za-z0-9_-]{22})$/u);
      if (request.method === "GET" && proofPageMatch) return sendFile(response, path.join(publicDirectory, "proof.html"));
      if (request.method === "GET" && ["/", "/write", "/app.js", "/proof.js", "/styles.css"].includes(requestUrl.pathname)) {
        const fileName = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname === "/write" ? "write.html" : requestUrl.pathname.slice(1);
        return sendFile(response, path.join(publicDirectory, fileName));
      }
      sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
    } catch (error) {
      const status = error instanceof ServiceError ? error.status : error.status || 500;
      const code = error instanceof ServiceError ? error.code : error.code || "internal_error";
      const message = status >= 500 ? "Internal server error" : error.message;
      if (status >= 500) console.error(error);
      sendJson(response, status, { error: { code, message, details: error.details } });
    }
  });

  return { server, service, proofStore, witnessKey, config };
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

async function readJson(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body is too large");
      error.status = 413;
      error.code = "body_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function sendJson(response, status, value, cacheControl = "no-store") {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": cacheControl });
  response.end(body);
}

function sendText(response, status, body, contentType, cacheControl = "no-store") {
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), "Cache-Control": cacheControl });
  response.end(body);
}

function publicOrigin(server, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const address = server.address();
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const displayHost = host.includes(":") ? `[${host.replace(/^\[|\]$/gu, "")}]` : host;
  return `http://${displayHost}:${address.port}`;
}

function publicationDetails(record, origin) {
  const verificationUrl = `${origin}/p/${record.id}`;
  const badgeUrl = `${origin}/badge/${record.id}.svg`;
  return {
    id: record.id,
    publishedAt: record.publishedAt,
    verificationUrl,
    badgeUrl,
    embedHtml: `<a href="${verificationUrl}" rel="noreferrer"><img src="${badgeUrl}" alt="TypeProof verified typing" width="220" height="40"></a>`,
    embedMarkdown: `[![TypeProof verified typing](${badgeUrl})](${verificationUrl})`
  };
}

function sendBadge(response, verification) {
  const valid = verification.valid;
  const label = valid ? "TypeProof · verified typing" : "TypeProof · verification failed";
  const color = valid ? "#176b4d" : "#a33b32";
  const escaped = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="40" role="img" aria-label="${escaped}"><rect width="220" height="40" rx="10" fill="#fffdf8"/><rect x=".5" y=".5" width="219" height="39" rx="9.5" fill="none" stroke="#d8d2c5"/><circle cx="21" cy="20" r="11" fill="${color}"/><path d="m16 20 3 3 6-7" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><text x="41" y="25" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#17231f">${escaped}</text></svg>`;
  sendText(response, 200, svg, "image/svg+xml; charset=utf-8", "public, max-age=300");
}

function sendEmpty(response, status) {
  response.writeHead(status);
  response.end();
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath);
  const contentType = extension === ".html" ? "text/html; charset=utf-8" : extension === ".js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendJson(response, 404, { error: { code: "not_found", message: "File not found" } });
    else response.destroy();
  });
  stream.pipe(response);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const application = await createTypeProofServer();
  application.server.listen(application.config.port, application.config.host, () => {
    console.log(`TypeProof witness listening on http://${application.config.host}:${application.config.port}`);
    console.log(`Witness key: ${application.witnessKey.keyId}`);
  });
}
