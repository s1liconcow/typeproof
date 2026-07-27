/**
 * Canonical JSON for the deliberately small TypeProof data model.
 *
 * Objects are key-sorted, undefined values are rejected, and only finite JSON
 * numbers are accepted. Protocol numeric fields are integers, avoiding the
 * cross-runtime edge cases that a general RFC 8785 implementation must handle.
 */
export function canonicalJson(value) {
  return serialize(value, new Set());
}

function serialize(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }

  if (typeof value !== "object" || value === undefined) {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cyclic values");
  ancestors.add(value);

  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => serialize(item, ancestors)).join(",")}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON only accepts plain objects");
    }
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined) throw new TypeError(`Undefined value at key ${key}`);
        return `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`;
      });
    result = `{${entries.join(",")}}`;
  }

  ancestors.delete(value);
  return result;
}

export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}
