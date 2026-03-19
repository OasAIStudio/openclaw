import {
  fetchWithSsrFGuard,
  withStrictGuardedFetchMode,
  withTrustedEnvProxyGuardedFetchMode,
} from "../infra/net/fetch-guard.js";
import { getProxyUrlFromFetch } from "../infra/net/proxy-fetch.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

export function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep policy tied to the configured host so private operator endpoints
    // continue to work, while cross-host redirects stay blocked.
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  auditContext?: string;
  fetchImpl?: typeof fetch;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const hasProxyFetch = typeof getProxyUrlFromFetch(params.fetchImpl) === "string";
  const guardedMode =
    hasProxyFetch || !params.fetchImpl
      ? withTrustedEnvProxyGuardedFetchMode({
          url: params.url,
          init: params.init,
          policy: params.ssrfPolicy,
          fetchImpl: params.fetchImpl,
          auditContext: params.auditContext ?? "memory-remote",
        })
      : withStrictGuardedFetchMode({
          url: params.url,
          init: params.init,
          policy: params.ssrfPolicy,
          fetchImpl: params.fetchImpl,
          auditContext: params.auditContext ?? "memory-remote",
        });
  const { response, release } = await fetchWithSsrFGuard(
    // Memory providers default to trusted env-proxy routing while preserving existing
    // proxy-aware fetch overrides when explicitly supplied.
    guardedMode,
  );
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
