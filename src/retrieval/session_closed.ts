export class SessionClosedError extends Error {
  readonly code = "session-closed" as const;
  constructor(what: string) {
    super(`${what}: the session is closed — open a new one`);
    this.name = "SessionClosedError";
  }
}
