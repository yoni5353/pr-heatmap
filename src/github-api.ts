// Minimal GitHub REST client. Only ever talks to api.github.com.

const API = "https://api.github.com";
const MAX_CONCURRENCY = 6;

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function getToken(): Promise<string | undefined> {
  const { token } = await chrome.storage.local.get("token");
  return typeof token === "string" && token ? token : undefined;
}

async function request(path: string, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path.startsWith(API) ? path : API + path, { headers });
  if (!res.ok) {
    let detail = res.statusText;
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      detail = `rate limit exhausted until ${new Date(reset).toLocaleTimeString()}`;
    } else {
      try {
        detail = ((await res.json()) as { message?: string }).message ?? detail;
      } catch {
        // keep statusText
      }
    }
    throw new GitHubError(`GitHub API ${res.status}: ${detail}`, res.status);
  }
  return res;
}

export async function getJson<T>(path: string, token: string | undefined): Promise<T> {
  return (await (await request(path, token)).json()) as T;
}

function nextLink(res: Response): string | undefined {
  const link = res.headers.get("link");
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
}

/** Follows `Link: rel="next"` pages, concatenating what `pick` extracts from each page. */
export async function getPaginated<T, P = T[]>(
  path: string,
  token: string | undefined,
  pick: (page: P) => T[] = (page) => page as unknown as T[],
): Promise<T[]> {
  const items: T[] = [];
  let url: string | undefined = path;
  while (url) {
    const res = await request(url, token);
    items.push(...pick((await res.json()) as P));
    url = nextLink(res);
  }
  return items;
}

/** Runs `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, worker));
  return results;
}
