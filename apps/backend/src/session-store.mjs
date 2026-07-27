export class SessionStore {
  #sessions = new Map();

  create(record) {
    this.prune();
    this.#sessions.set(record.id, record);
    return record;
  }

  get(id) {
    this.prune();
    return this.#sessions.get(id);
  }

  prune(now = Date.now()) {
    for (const [id, session] of this.#sessions) {
      const retentionDeadline = Date.parse(session.challenge.payload.expiresAt) + 60 * 60 * 1000;
      if (retentionDeadline < now) this.#sessions.delete(id);
    }
  }
}
