/**
 * Monotonic guard for async UI requests where only the newest completion may
 * commit state. Calling `invalidate` also makes every currently-running request
 * stale (used when navigation changes through another path).
 */
export class RequestGate {
  private version = 0;

  begin(): number {
    return ++this.version;
  }

  invalidate(): void {
    this.version += 1;
  }

  isCurrent(token: number): boolean {
    return token === this.version;
  }
}
