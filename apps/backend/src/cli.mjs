import { readFile } from "node:fs/promises";
import { verifyProof } from "../../../packages/proof-core/verify.mjs";

const [, , command, filePath, ...flags] = process.argv;

if (command !== "verify" || !filePath) {
  console.error("Usage: node apps/backend/src/cli.mjs verify <proof.json> [--trusted-key-id <id>]");
  process.exitCode = 2;
} else {
  try {
    const trustedIndex = flags.indexOf("--trusted-key-id");
    const trustedServerKeyId = trustedIndex === -1 ? undefined : flags[trustedIndex + 1];
    if (trustedIndex !== -1 && !trustedServerKeyId) throw new Error("--trusted-key-id requires a value");
    const proof = JSON.parse(await readFile(filePath, "utf8"));
    const verification = await verifyProof(proof, { trustedServerKeyId });
    console.log(JSON.stringify(verification, null, 2));
    process.exitCode = verification.valid ? 0 : 1;
  } catch (error) {
    console.error(`Could not verify proof: ${error.message}`);
    process.exitCode = 2;
  }
}
