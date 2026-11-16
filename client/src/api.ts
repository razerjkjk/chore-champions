// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. This is a plain `fetch` replacement for the SDK's
// `createActionClient`: every call POSTs `{action, args}` to `./actions`
// and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import type { z } from "zod";

type ReqOf<K extends keyof typeof Actions> =
  (typeof Actions)[K] extends { request: infer R }
    ? R extends z.ZodType
      ? z.infer<R>
      : never
    : never;

type ResOf<K extends keyof typeof Actions> =
  (typeof Actions)[K] extends { response: infer S }
    ? S extends z.ZodType
      ? z.infer<S>
      : never
    : never;

type ActionClient = {
  [K in keyof typeof Actions]: (args: ReqOf<K>) => Promise<ResOf<K>>;
};

// Every action call carries a hard 25-second timeout. A dropped
// request or answer on a phone connection must turn into an ordinary
// error (buttons come back, the app can say "it may have gone
// through") instead of hanging the UI forever — the recurring stall
// that froze the Grown-Up Zone PIN pad in the original app.
const ACTION_TIMEOUT_MS = 25_000;

async function callAction(action: string, args: unknown): Promise<unknown> {
  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
  try {
    res = await fetch("./actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, args }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("That request could not confirm in time — it may have gone through. Check before trying again.");
    }
    throw new Error("Could not reach the server. Check your connection and try again.");
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // A non-JSON error body is still an error; the message below covers it.
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `The request failed (${res.status}).`;
    throw new Error(message);
  }
  return data;
}

export const api = new Proxy({} as ActionClient, {
  get(_target, prop: string | symbol) {
    if (typeof prop !== "string") return undefined;
    return (args: unknown) => callAction(prop, args);
  },
});

// Convenience types so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Bill = ApiResponse<typeof api, "listBills">["bills"][number];
//
export type ApiRequest<C, A extends keyof C> = C[A] extends (args: infer P) => unknown
  ? P
  : never;

export type ApiResponse<C, A extends keyof C> = C[A] extends (
  ...args: any[]
) => Promise<infer R>
  ? R
  : never;
