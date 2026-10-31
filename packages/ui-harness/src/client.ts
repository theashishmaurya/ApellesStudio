/**
 * client.ts — the harness's one connection to the running app (D-434).
 *
 * What it is: a minimal client for the app's control server
 *   (`app/src-tauri/src/chroma/control.rs`, `POST /op {op, args, timeout_ms}`),
 *   the same endpoint both MCP servers post to. The harness talks to it
 *   directly rather than through MCP (19790) because a scenario speaks in ops
 *   and their wire arguments, needs no MCP session, and must not depend on
 *   which MCP server happens to be configured.
 *
 * Every request carries `source: 'harness'` (H1) so the app never mistakes the
 *   harness's fixture ops for an agent's work.
 *
 * What it does NOT do: retry, interpret results, or know any op. An op the app
 *   answers with `ok: false` becomes an `OpError` carrying the app's own
 *   message; the runner decides whether that fails the scenario.
 */

export const DEFAULT_CONTROL_PORT = 19788;
/** Stamped on every request (H1): the control server forwards it and the app
 *  records the resulting history entries as the harness's, not the agent's —
 *  so the Agent activity dock stays empty and a person's undo is not flooded. */
export const HARNESS_SOURCE = 'harness';
/** The app's own default budget for an op that does not name one. */
export const DEFAULT_OP_TIMEOUT_MS = 20_000;
/** Client-side slack on top of the app-side budget, so a real app timeout
 *  arrives as the app's own explanatory answer rather than a socket error. */
const CLIENT_SLACK_MS = 15_000;

export class OpError extends Error {
  readonly op: string;
  constructor(op: string, message: string) {
    super(`${op}: ${message}`);
    this.op = op;
  }
}

export interface OpClient {
  op<T = unknown>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class ControlClient implements OpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(port: number = DEFAULT_CONTROL_PORT, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.fetchImpl = fetchImpl;
  }

  async op<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs: number = DEFAULT_OP_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + CLIENT_SLACK_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/op`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args, timeout_ms: timeoutMs, source: HARNESS_SOURCE }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string | null; result?: unknown } | null;
      if (!body) throw new OpError(op, `HTTP ${res.status} with no JSON body`);
      if (body.ok === false || (body.error !== undefined && body.error !== null)) {
        throw new OpError(op, body.error ?? `HTTP ${res.status}`);
      }
      return body.result as T;
    } catch (e) {
      if (e instanceof OpError) throw e;
      throw new OpError(op, `could not reach the control server at ${this.baseUrl} (${String((e as Error)?.message ?? e)}) — is the app running?`);
    } finally {
      clearTimeout(timer);
    }
  }
}
