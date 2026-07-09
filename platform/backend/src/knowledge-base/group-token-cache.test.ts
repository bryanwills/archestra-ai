import { vi } from "vitest";

vi.mock("@/cache-manager");

import { KbExternalUserGroupModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  findGroupTokensForUserCached,
  invalidateGroupTokenCache,
} from "./group-token-cache";

async function grantGroup(params: {
  organizationId: string;
  connectorId: string;
  groupId: string;
  memberEmail: string;
}) {
  await KbExternalUserGroupModel.upsertMany([
    {
      organizationId: params.organizationId,
      connectorId: params.connectorId,
      connectorType: "github",
      groupId: params.groupId,
      externalAccountId: params.memberEmail,
      memberEmail: params.memberEmail,
    },
  ]);
}

describe("findGroupTokensForUserCached", () => {
  test("caches per user — including an EMPTY result — until invalidated", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    const lookup = () =>
      findGroupTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [connector.id],
      });

    // No memberships yet → empty, and the EMPTY answer is cached.
    expect(await lookup()).toEqual([]);

    await grantGroup({
      organizationId: org.id,
      connectorId: connector.id,
      groupId: "eng",
      memberEmail: "alice@example.com",
    });

    // Still empty: served from cache, not the table.
    expect(await lookup()).toEqual([]);

    // A finished permission sync invalidates → the new grant is visible.
    await invalidateGroupTokenCache();
    expect(await lookup()).toEqual(["group:github_eng"]);
  });

  test("scopes the cache to the connector set", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const a = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    const b = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
      connectorType: "github",
    });
    await grantGroup({
      organizationId: org.id,
      connectorId: b.id,
      groupId: "ops",
      memberEmail: "alice@example.com",
    });

    // Warm the cache for connector set [a] (empty).
    expect(
      await findGroupTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [a.id],
      }),
    ).toEqual([]);

    // A different connector set is a different cache entry — no false share.
    expect(
      await findGroupTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [a.id, b.id],
      }),
    ).toEqual(["group:github_ops"]);
  });

  test("an empty connector set short-circuits without touching the cache", async () => {
    expect(
      await findGroupTokensForUserCached({
        memberEmail: "alice@example.com",
        connectorIds: [],
      }),
    ).toEqual([]);
  });
});
