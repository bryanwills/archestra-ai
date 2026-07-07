import { KbExternalUserGroupModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("KbExternalUserGroupModel", () => {
  test("upsertMany normalizes emails and findGroupTokensForUser resolves namespaced tokens", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "eng",
        memberEmail: "Alice@Example.com",
      },
      {
        organizationId: org.id,
        connectorId: connector.id,
        connectorType: "github",
        groupId: "ops",
        memberEmail: "bob@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: " alice@example.com ",
      connectorIds: [connector.id],
    });

    expect(tokens.sort()).toEqual(["group:github_eng"]);
  });

  test("mark-stale → re-upsert → delete-stale removes revoked memberships only", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connector = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });

    const seed = (groupId: string) => ({
      organizationId: org.id,
      connectorId: connector.id,
      connectorType: "github" as const,
      groupId,
      memberEmail: "user@example.com",
    });

    await KbExternalUserGroupModel.upsertMany([seed("eng"), seed("ops")]);

    // A fresh sync run: mark everything stale, re-observe only "eng".
    await KbExternalUserGroupModel.markStaleByConnector(connector.id);
    await KbExternalUserGroupModel.upsertMany([seed("eng")]);
    await KbExternalUserGroupModel.deleteStaleByConnector(connector.id);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connector.id],
    });

    // "ops" membership was revoked (stayed stale and got swept).
    expect(tokens).toEqual(["group:github_eng"]);
  });

  test("findGroupTokensForUser scopes to the given connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const connectorA = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "github",
      visibility: "auto-sync-permissions",
    });
    const connectorB = await makeKnowledgeBaseConnector(kb.id, org.id, {
      connectorType: "jira",
      visibility: "auto-sync-permissions",
    });

    await KbExternalUserGroupModel.upsertMany([
      {
        organizationId: org.id,
        connectorId: connectorA.id,
        connectorType: "github",
        groupId: "eng",
        memberEmail: "user@example.com",
      },
      {
        organizationId: org.id,
        connectorId: connectorB.id,
        connectorType: "jira",
        groupId: "dev",
        memberEmail: "user@example.com",
      },
    ]);

    const tokens = await KbExternalUserGroupModel.findGroupTokensForUser({
      memberEmail: "user@example.com",
      connectorIds: [connectorA.id],
    });

    expect(tokens).toEqual(["group:github_eng"]);
  });
});
