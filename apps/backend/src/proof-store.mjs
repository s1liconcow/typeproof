import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { objectDigest } from "../../../packages/proof-core/crypto.mjs";

const PUBLIC_ID_PATTERN = /^tp_[A-Za-z0-9_-]{22}$/u;

export class ProofStore {
  constructor(directory) {
    this.directory = directory;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async publish(proof, publishedAt = new Date().toISOString()) {
    const digest = await objectDigest(proof);
    const id = `tp_${digest.slice(0, 22)}`;
    const record = { id, publishedAt, proof };
    try {
      await writeFile(this.#path(id), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await this.get(id);
      if (await objectDigest(existing.proof) !== digest) throw new Error("Public proof identifier collision");
      return existing;
    }
    return record;
  }

  async get(id) {
    if (!PUBLIC_ID_PATTERN.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.#path(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #path(id) {
    return path.join(this.directory, `${id}.json`);
  }
}
