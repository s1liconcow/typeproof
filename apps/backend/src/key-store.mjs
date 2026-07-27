import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateSigningKey, importPrivateJwk, normalizePublicJwk, publicKeyId } from "../../../packages/proof-core/crypto.mjs";

export async function loadOrCreateWitnessKey(dataDirectory) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDirectory, "witness-key.jwk");
  let privateJwk;

  try {
    privateJwk = JSON.parse(await readFile(keyPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const generated = await generateSigningKey(true);
    privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
    try {
      await writeFile(keyPath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      privateJwk = JSON.parse(await readFile(keyPath, "utf8"));
    }
  }

  await chmod(keyPath, 0o600);
  const privateKey = await importPrivateJwk(privateJwk);
  const publicKey = normalizePublicJwk(privateJwk);
  return { privateKey, publicKey, keyId: await publicKeyId(publicKey), keyPath };
}
