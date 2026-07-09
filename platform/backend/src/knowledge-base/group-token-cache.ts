// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createHash } from "node:crypto";
import { MIN_PERMISSION_SYNC_INTERVAL_SECONDS } from "@archestra/shared";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { KbExternalUserGroupModel } from "@/models";
import type { AclEntry } from "@/types";
import { normalizeEmail } from "./acl-tokens";

/**
 * Group memberships only change when a permission-sync pass writes them, so a
 * cached lookup is exactly as fresh as the table as long as every finished
 * pass invalidates (permission-sync.ts does). The TTL is a backstop, bounded
 * by the shortest interval any connector can sync at.
 */
const GROUP_TOKEN_CACHE_TTL_MS = MIN_PERMISSION_SYNC_INTERVAL_SECONDS * 1000;

/**
 * Cached wrapper around `KbExternalUserGroupModel.findGroupTokensForUser`, the
 * per-request group-membership join on the knowledge-query hot path. Caches
 * per (user email, connector set) — including EMPTY results, which are the
 * common case (most users belong to no upstream group) and cost the same join
 * to recompute.
 */
export async function findGroupTokensForUserCached(params: {
  memberEmail: string;
  connectorIds: string[];
}): Promise<AclEntry[]> {
  if (params.connectorIds.length === 0) return [];

  const key = buildCacheKey(params);
  const cached = await cacheManager.get<AclEntry[]>(key);
  if (cached !== undefined) return cached;

  const tokens = await KbExternalUserGroupModel.findGroupTokensForUser(params);
  try {
    await cacheManager.set(key, tokens, GROUP_TOKEN_CACHE_TTL_MS);
  } catch (error) {
    // A lost cache write only costs a recompute — never fail the query. (It
    // cannot over-grant: what we cache is exactly what we would return.)
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to cache group tokens; serving the uncached result",
    );
  }
  return tokens;
}

/**
 * Drop every cached group-token resolution. Called whenever a permission-sync
 * pass finishes (it is the only writer of group memberships), so freshly
 * synced access — including a manual pass an admin just triggered — is
 * visible on the next query instead of after the TTL.
 */
export async function invalidateGroupTokenCache(): Promise<void> {
  await cacheManager.deleteByPrefix(CacheKey.KbGroupTokens);
}

// ===== Internal helpers =====

function buildCacheKey(params: {
  memberEmail: string;
  connectorIds: string[];
}): `${typeof CacheKey.KbGroupTokens}-${string}` {
  // The connector set varies per agent/gateway scope; hash it so the key stays
  // bounded regardless of how many connectors are in scope.
  const connectorSetHash = createHash("sha256")
    .update([...params.connectorIds].sort().join(","))
    .digest("hex")
    .slice(0, 16);
  return `${CacheKey.KbGroupTokens}-${normalizeEmail(params.memberEmail)}:${connectorSetHash}`;
}
// SPDX-SnippetEnd
