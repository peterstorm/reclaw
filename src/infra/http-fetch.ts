/** The slice of `fetch` the adapters use — narrow so tests pass a plain function. */
export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;
