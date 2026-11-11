// Requests to the internet: ctx.net.fetch() reaches only the hosts the app
// holds net:<host> for, over HTTPS, and follows no redirect. Like every
// call, it carries JSON both ways.

/** The permission to reach one host, such as net:api.open-meteo.com. */
export const netPermission = (host: string) => `net:${host}`;

export type NetRequest = {
  /** An https: URL on a host the app may reach. */
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** How long to wait for the answer, in ms: at most, and by default, 10 s. */
  timeoutMs?: number;
};

export type NetResponse = {
  status: number;
  headers: Record<string, string>;
  /** The body as text, at most 1 MB. */
  body: string;
};
