/**
 * Microsoft Copilot (Entra ID) token redemption.
 *
 * The Microsoft 365 Copilot Chat API only supports delegated auth, so each
 * user holds a long-lived Entra ID refresh token (obtained via the Entra
 * device flow) which is NOT accepted by Microsoft Graph directly. It must be
 * redeemed at `POST /{tenant}/oauth2/v2.0/token` for a short-lived (~1h)
 * access token used against https://graph.microsoft.com.
 *
 * The redemption sits in the LLM proxy hot path, so this manager caches
 * access tokens per refresh token (refreshing 60s before expiry) and
 * single-flights concurrent redemptions for the same token.
 *
 * Unlike GitHub's OAuth tokens, Entra refresh tokens ROTATE: a redemption may
 * return a new refresh token. The manager keeps the newest one in memory
 * (`latestRefreshToken`) and persists it back to the stored provider key
 * best-effort — Entra keeps the previous refresh token valid until its own
 * expiry, so a failed write-back degrades longevity (the ~90-day inactivity
 * window keeps sliding only if the stored token is refreshed), never
 * per-request correctness.
 */
import { createHmac, randomBytes } from "node:crypto";
import { isVaultReference } from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * Delegated scopes the Microsoft 365 Copilot Chat API requires — ALL of the
 * Graph read scopes must be consented for the API to accept the token —
 * plus `offline_access` so the device flow issues a refresh token.
 * Shared by the device-flow start route and the refresh-token redemption so
 * the two can never drift.
 */
export const MICROSOFT_COPILOT_OAUTH_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "https://graph.microsoft.com/Sites.Read.All",
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/People.Read.All",
  "https://graph.microsoft.com/OnlineMeetingTranscript.Read.All",
  "https://graph.microsoft.com/Chat.Read",
  "https://graph.microsoft.com/ChannelMessage.Read.All",
  "https://graph.microsoft.com/ExternalItem.Read.All",
].join(" ");

// Not in the internal-helpers section: consts are not hoisted, and this one is
// read by a field initializer when the singleton is constructed at module eval.
const MAX_CACHED_TOKENS = 1000;

class MicrosoftCopilotTokenManager {
  private tokenCache = new LRUCacheManager<CachedAccessToken>({
    maxSize: MAX_CACHED_TOKENS,
  });
  private inFlightRedemptions = new Map<string, Promise<string>>();
  /**
   * Tail of the pending persist chain per provider-key id. Serializes secret
   * writes so two concurrent rotations for the same key can't interleave.
   */
  private persistQueues = new Map<string, Promise<void>>();

  /**
   * Returns a valid Graph access token for the given stored refresh token,
   * redeeming (and caching) it if needed.
   */
  async getAccessToken(params: {
    refreshToken: string;
    /**
     * Id of the llm_provider_api_keys row holding the refresh token. When
     * given, a rotated refresh token is persisted back to that key's secret;
     * without it rotation is tracked in memory only (e.g. key validation
     * before the row exists).
     */
    providerApiKeyId?: string;
  }): Promise<string> {
    const { refreshToken, providerApiKeyId } = params;
    const cacheKey = hashToken(refreshToken);

    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs - REFRESH_BUFFER_MS > Date.now()) {
      return cached.accessToken;
    }

    const inFlight = this.inFlightRedemptions.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const redemption = this.redeemRefreshToken({
      refreshToken,
      cacheKey,
      providerApiKeyId,
      // A stale cache entry may hold a newer rotated token than the caller's.
      latestRefreshToken: cached?.latestRefreshToken,
    }).finally(() => {
      this.inFlightRedemptions.delete(cacheKey);
    });
    this.inFlightRedemptions.set(cacheKey, redemption);
    return redemption;
  }

  /**
   * Drops the cached access token for a refresh token. Called when Graph
   * rejects a cached access token (e.g. revoked early) so the next request
   * re-redeems. When `staleAccessToken` is given, only that exact token is
   * evicted — a concurrent 401 handler must not throw away a token another
   * request already refreshed.
   */
  invalidate(refreshToken: string, staleAccessToken?: string): void {
    const cacheKey = hashToken(refreshToken);
    const cached = this.tokenCache.get(cacheKey);
    if (!cached) {
      return;
    }
    if (
      staleAccessToken !== undefined &&
      cached.accessToken !== staleAccessToken
    ) {
      return;
    }
    // Keep the rotated refresh token alive across the eviction: re-inserting
    // an already-expired entry preserves `latestRefreshToken` for the next
    // redemption while failing the freshness check above.
    this.tokenCache.set(cacheKey, { ...cached, expiresAtMs: 0 });
  }

  private async redeemRefreshToken(params: {
    refreshToken: string;
    cacheKey: string;
    providerApiKeyId?: string;
    latestRefreshToken?: string;
  }): Promise<string> {
    const { refreshToken, cacheKey, providerApiKeyId, latestRefreshToken } =
      params;
    const { authBaseUrl, tenantId, clientId } = config.llm["microsoft-copilot"];

    const response = await fetch(
      `${authBaseUrl}/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: "refresh_token",
          refresh_token: latestRefreshToken ?? refreshToken,
          scope: MICROSOFT_COPILOT_OAUTH_SCOPES,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      logger.warn(
        { status: response.status, body: body.slice(0, 500) },
        "[MicrosoftCopilot] refresh token redemption failed",
      );
      // Entra reports expired/revoked refresh tokens as 400 invalid_grant.
      if (response.status === 400 || response.status === 401) {
        throw new ApiError(
          401,
          "Microsoft sign-in has expired or been revoked. Reconnect your Microsoft account to keep using Microsoft Copilot.",
        );
      }
      throw new ApiError(
        502,
        `Microsoft Copilot token redemption failed with status ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!payload.access_token || typeof payload.expires_in !== "number") {
      throw new ApiError(
        502,
        "Microsoft Copilot token redemption returned an unexpected payload",
      );
    }

    const expiresAtMs = Date.now() + payload.expires_in * 1000;
    const rotatedRefreshToken = payload.refresh_token;
    this.tokenCache.set(
      cacheKey,
      {
        accessToken: payload.access_token,
        expiresAtMs,
        latestRefreshToken: rotatedRefreshToken ?? latestRefreshToken,
      },
      // Freshness is enforced via expiresAtMs above; the LRU entry outlives
      // the access token so `latestRefreshToken` is still around for the next
      // redemption (it matters when persistence to the stored key fails).
      Math.max(expiresAtMs - Date.now(), 0) + ROTATED_TOKEN_RETENTION_MS,
    );

    if (
      rotatedRefreshToken &&
      rotatedRefreshToken !== refreshToken &&
      providerApiKeyId
    ) {
      this.queuePersist(providerApiKeyId, rotatedRefreshToken);
    }

    return payload.access_token;
  }

  private queuePersist(providerApiKeyId: string, newRefreshToken: string) {
    const tail = this.persistQueues.get(providerApiKeyId) ?? Promise.resolve();
    const next = tail
      .then(() =>
        this.persistRotatedRefreshToken(providerApiKeyId, newRefreshToken),
      )
      .catch((error) => {
        // Best-effort: the in-memory `latestRefreshToken` keeps serving, and
        // Entra accepts the previously stored token until its own expiry.
        logger.warn(
          { providerApiKeyId, error },
          "[MicrosoftCopilot] failed to persist rotated refresh token",
        );
      });
    this.persistQueues.set(providerApiKeyId, next);
    next.finally(() => {
      if (this.persistQueues.get(providerApiKeyId) === next) {
        this.persistQueues.delete(providerApiKeyId);
      }
    });
  }

  private async persistRotatedRefreshToken(
    providerApiKeyId: string,
    newRefreshToken: string,
  ): Promise<void> {
    const keyRow = await LlmProviderApiKeyModel.findById(providerApiKeyId);
    if (!keyRow?.secretId) {
      return;
    }
    const storedValue = await getSecretValueForLlmProviderApiKey(
      keyRow.secretId,
    );
    if (storedValue !== undefined && isVaultReference(storedValue)) {
      // BYOS vault reference: the actual token lives in an external read-only
      // vault we must not (and cannot) overwrite.
      logger.warn(
        { providerApiKeyId },
        "[MicrosoftCopilot] skipping rotated refresh token persistence for vault-referenced key",
      );
      return;
    }
    await secretManager().updateSecret(keyRow.secretId, {
      apiKey: newRefreshToken,
    });
  }
}

/** @public — exercised directly by unit tests (cache/single-flight/rotation) */
export const microsoftCopilotTokenManager = new MicrosoftCopilotTokenManager();

/**
 * Wraps fetch so every Microsoft Graph request carries a fresh short-lived
 * access token (redeemed from the stored Entra refresh token). A 401 on a
 * cached access token invalidates it and retries exactly once.
 *
 * Used by the microsoft-copilot proxy adapter's Graph client and the model
 * fetcher (the chat LLM client routes through the local proxy instead, so the
 * redemption happens exactly once — in the adapter).
 *
 * Redemption failures are returned as a synthetic error Response rather than
 * thrown: the adapter surfaces the real status and message through the
 * standard OpenAI-shaped provider error path instead of a generic
 * connection failure.
 */
export function createMicrosoftCopilotFetch(params: {
  refreshToken: string | undefined;
  providerApiKeyId?: string;
  innerFetch?: FetchLike;
}): FetchLike {
  const { refreshToken, providerApiKeyId, innerFetch } = params;
  const baseFetch: FetchLike = innerFetch ?? fetch;

  return async (input, init) => {
    if (!refreshToken) {
      // Keyless calls cannot be redeemed; let Graph reject the request so the
      // standard provider error path reports it.
      return baseFetch(input, init);
    }

    const doFetch = async (accessToken: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return baseFetch(input, { ...init, headers });
    };

    let accessToken: string;
    try {
      accessToken = await microsoftCopilotTokenManager.getAccessToken({
        refreshToken,
        providerApiKeyId,
      });
    } catch (error) {
      return redemptionErrorResponse(error);
    }
    const response = await doFetch(accessToken);

    // A cached access token can be rejected before its reported expiry (e.g.
    // Conditional Access revocation). Re-redeem once; non-replayable bodies
    // are never produced by our Graph client (it serializes JSON strings).
    const bodyIsReplayable =
      init?.body === undefined || typeof init.body === "string";
    if (response.status === 401 && bodyIsReplayable) {
      await response.body?.cancel();
      microsoftCopilotTokenManager.invalidate(refreshToken, accessToken);
      let freshAccessToken: string;
      try {
        freshAccessToken = await microsoftCopilotTokenManager.getAccessToken({
          refreshToken,
          providerApiKeyId,
        });
      } catch (error) {
        return redemptionErrorResponse(error);
      }
      return doFetch(freshAccessToken);
    }

    return response;
  };
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  /**
   * Newest rotated refresh token seen for this cache slot. Redemptions prefer
   * it over the caller's (stored) token so rotation keeps working even while
   * persistence to the stored key lags or fails.
   */
  latestRefreshToken?: string;
}

/** Refresh this long before the access token's reported expiry. */
const REFRESH_BUFFER_MS = 60 * 1000;

/** How long a cache entry outlives its access token (see set() call above). */
const ROTATED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Converts a token-redemption ApiError into an OpenAI-shaped error Response so
 * SDK-style consumers raise a proper status error (no retries, real message).
 */
function redemptionErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: {
          message: error.message,
          type: error.statusCode === 401 ? "authentication_error" : "api_error",
        },
      },
      { status: error.statusCode },
    );
  }
  throw error;
}

// Per-process random key for the cache-key HMAC below. Regenerated on each
// boot — the cache is in-memory only, so a cold start on restart is fine.
const TOKEN_CACHE_HMAC_KEY = randomBytes(32);

// Derives an in-memory cache key for the token LRU. It is never stored,
// persisted, or compared against a stored hash, so a slow password KDF
// (bcrypt/scrypt/argon2) would only add latency to every proxy request. HMAC
// with a per-process key (rather than bare SHA-256) means an observer of cache
// keys can't pre-compute lookups against known token formats.
// codeql[js/insufficient-password-hash] Derives an in-memory cache key from a high-entropy OAuth refresh token, not a stored user-password hash.
function hashToken(token: string): string {
  return createHmac("sha256", TOKEN_CACHE_HMAC_KEY).update(token).digest("hex");
}
