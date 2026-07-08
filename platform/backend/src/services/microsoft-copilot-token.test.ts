import { vi } from "vitest";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import {
  getSecretValueForLlmProviderApiKey,
  secretManager,
} from "@/secrets-manager";
import {
  createMicrosoftCopilotFetch,
  microsoftCopilotTokenManager,
} from "@/services/microsoft-copilot-token";
import { afterEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";

vi.mock("@/models/llm-provider-api-key", () => ({
  default: { findById: vi.fn() },
}));

vi.mock("@/secrets-manager", () => ({
  secretManager: vi.fn(),
  getSecretValueForLlmProviderApiKey: vi.fn(),
}));

const findByIdMock = vi.mocked(LlmProviderApiKeyModel.findById);
const secretManagerMock = vi.mocked(secretManager);
const getSecretValueMock = vi.mocked(getSecretValueForLlmProviderApiKey);

/**
 * The token manager is a singleton with an internal cache, so every test uses
 * a unique refresh token to stay isolated from other tests' cache entries.
 */
let tokenCounter = 0;
function uniqueRefreshToken(): string {
  tokenCounter += 1;
  return `entra_rt_${Date.now()}_${tokenCounter}`;
}

function redemptionResponse(params?: {
  accessToken?: string;
  expiresInSeconds?: number;
  refreshToken?: string | null;
}): Response {
  return Response.json({
    access_token: params?.accessToken ?? "graph-access-token",
    expires_in: params?.expiresInSeconds ?? 3600,
    ...(params?.refreshToken === null
      ? {}
      : { refresh_token: params?.refreshToken ?? "rotated-refresh-token" }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  findByIdMock.mockReset();
  getSecretValueMock.mockReset();
  secretManagerMock.mockReset();
});

describe("microsoftCopilotTokenManager.getAccessToken", () => {
  test("redeems the refresh token with a form-encoded grant", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redemptionResponse({ refreshToken: null }));
    vi.stubGlobal("fetch", fetchMock);

    const accessToken = await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
    });

    expect(accessToken).toBe("graph-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/oauth2/v2.0/token");
    expect(init.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = init.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(refreshToken);
    expect(body.get("scope")).toContain("offline_access");
    expect(body.get("scope")).toContain(
      "https://graph.microsoft.com/Sites.Read.All",
    );
  });

  test("caches the access token until expiry and reuses it", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(redemptionResponse({ refreshToken: null }));
    vi.stubGlobal("fetch", fetchMock);

    await microsoftCopilotTokenManager.getAccessToken({ refreshToken });
    await microsoftCopilotTokenManager.getAccessToken({ refreshToken });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("single-flights concurrent redemptions for the same token", async () => {
    const refreshToken = uniqueRefreshToken();
    let resolveRedemption: (response: Response) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveRedemption = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = [
      microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
      microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ];
    resolveRedemption(redemptionResponse({ refreshToken: null }));

    expect(await first).toBe("graph-access-token");
    expect(await second).toBe("graph-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uses the rotated refresh token on the next redemption", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        redemptionResponse({
          accessToken: "first",
          refreshToken: "rotated-rt",
          // expires in 30s — within the 60s refresh buffer on the next call
          expiresInSeconds: 30,
        }),
      )
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "second", refreshToken: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await microsoftCopilotTokenManager.getAccessToken({ refreshToken });
    const accessToken = await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
    });

    expect(accessToken).toBe("second");
    const secondBody = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(secondBody.get("refresh_token")).toBe("rotated-rt");
  });

  test("persists a rotated refresh token back to the stored key", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(redemptionResponse({ refreshToken: "rotated-rt" })),
    );
    findByIdMock.mockResolvedValue({ secretId: "secret-1" } as Awaited<
      ReturnType<typeof LlmProviderApiKeyModel.findById>
    >);
    getSecretValueMock.mockResolvedValue(refreshToken);
    const updateSecret = vi.fn().mockResolvedValue(null);
    secretManagerMock.mockReturnValue({ updateSecret } as unknown as ReturnType<
      typeof secretManager
    >);

    await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
      providerApiKeyId: "key-1",
    });

    await vi.waitFor(() => {
      expect(updateSecret).toHaveBeenCalledWith("secret-1", {
        apiKey: "rotated-rt",
      });
    });
    expect(findByIdMock).toHaveBeenCalledWith("key-1");
  });

  test("skips persistence for vault-referenced keys", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(redemptionResponse({ refreshToken: "rotated-rt" })),
    );
    findByIdMock.mockResolvedValue({ secretId: "secret-1" } as Awaited<
      ReturnType<typeof LlmProviderApiKeyModel.findById>
    >);
    getSecretValueMock.mockResolvedValue("secret/data/team#apiKey");
    const updateSecret = vi.fn();
    secretManagerMock.mockReturnValue({ updateSecret } as unknown as ReturnType<
      typeof secretManager
    >);

    await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
      providerApiKeyId: "key-1",
    });

    await vi.waitFor(() => {
      expect(getSecretValueMock).toHaveBeenCalled();
    });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  test("a failed persistence keeps serving access tokens", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(redemptionResponse({ refreshToken: "rotated-rt" })),
    );
    findByIdMock.mockRejectedValue(new Error("db down"));

    const accessToken = await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
      providerApiKeyId: "key-1",
    });

    expect(accessToken).toBe("graph-access-token");
    await vi.waitFor(() => {
      expect(findByIdMock).toHaveBeenCalled();
    });
  });

  test("maps 400/401 to a 401 ApiError telling the user to reconnect", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        ),
    );

    await expect(
      microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("Reconnect your Microsoft account"),
    });
  });

  test("maps upstream 5xx to a 502 ApiError", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 503 })),
    );

    await expect(
      microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  test("a failed redemption does not poison subsequent attempts", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(redemptionResponse({ refreshToken: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).rejects.toThrow(ApiError);

    const accessToken = await microsoftCopilotTokenManager.getAccessToken({
      refreshToken,
    });
    expect(accessToken).toBe("graph-access-token");
  });

  test("invalidate() with a stale access token keeps an already-refreshed entry", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "fresh", refreshToken: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).toBe("fresh");
    // A concurrent 401 handler that used an older token must not evict it.
    microsoftCopilotTokenManager.invalidate(refreshToken, "stale");
    expect(
      await microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("invalidate() drops the cached access token but keeps the rotated refresh token", async () => {
    const refreshToken = uniqueRefreshToken();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "first", refreshToken: "rotated" }),
      )
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "second", refreshToken: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).toBe("first");
    microsoftCopilotTokenManager.invalidate(refreshToken);
    expect(
      await microsoftCopilotTokenManager.getAccessToken({ refreshToken }),
    ).toBe("second");
    // The re-redemption after invalidation still uses the rotated token.
    const secondBody = fetchMock.mock.calls[1][1].body as URLSearchParams;
    expect(secondBody.get("refresh_token")).toBe("rotated");
  });
});

describe("createMicrosoftCopilotFetch", () => {
  test("injects the redeemed access token into requests", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(redemptionResponse({ refreshToken: null })),
    );
    const innerFetch = vi.fn().mockResolvedValue(new Response("ok"));

    const graphFetch = createMicrosoftCopilotFetch({
      refreshToken,
      innerFetch,
    });
    await graphFetch("https://graph.microsoft.com/beta/copilot/conversations", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    expect(innerFetch).toHaveBeenCalledTimes(1);
    const [, init] = innerFetch.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer graph-access-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("on 401 with a cached token: invalidates, re-redeems, and retries exactly once", async () => {
    const refreshToken = uniqueRefreshToken();
    const redemptionMock = vi
      .fn()
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "stale", refreshToken: null }),
      )
      .mockResolvedValueOnce(
        redemptionResponse({ accessToken: "fresh", refreshToken: null }),
      );
    vi.stubGlobal("fetch", redemptionMock);

    const innerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const graphFetch = createMicrosoftCopilotFetch({
      refreshToken,
      innerFetch,
    });
    const response = await graphFetch(
      "https://graph.microsoft.com/beta/copilot/conversations",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    expect(redemptionMock).toHaveBeenCalledTimes(2);
    expect(innerFetch).toHaveBeenCalledTimes(2);
    const retryHeaders = innerFetch.mock.calls[1][1].headers as Headers;
    expect(retryHeaders.get("authorization")).toBe("Bearer fresh");
  });

  test("returns the redemption failure as an OpenAI-shaped error Response instead of throwing", async () => {
    const refreshToken = uniqueRefreshToken();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        ),
    );
    const innerFetch = vi.fn();

    const graphFetch = createMicrosoftCopilotFetch({
      refreshToken,
      innerFetch,
    });
    const response = await graphFetch(
      "https://graph.microsoft.com/beta/copilot/conversations",
      { method: "POST", body: "{}" },
    );

    expect(innerFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("Reconnect your Microsoft account");
  });

  test("passes requests through untouched when no refresh token is present", async () => {
    const innerFetch = vi.fn().mockResolvedValue(new Response("nope"));
    const redemptionMock = vi.fn();
    vi.stubGlobal("fetch", redemptionMock);

    const graphFetch = createMicrosoftCopilotFetch({
      refreshToken: undefined,
      innerFetch,
    });
    await graphFetch("https://graph.microsoft.com/beta/copilot/conversations");

    expect(redemptionMock).not.toHaveBeenCalled();
    expect(innerFetch).toHaveBeenCalledTimes(1);
    const init = innerFetch.mock.calls[0][1];
    expect(init).toBeUndefined();
  });
});
