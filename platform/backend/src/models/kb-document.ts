import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AclEntry,
  ConnectorType,
  InsertKbDocument,
  KbDocument,
  UpdateKbDocument,
} from "@/types";

type KbDocumentListItem = KbDocument & {
  connectorType: ConnectorType;
};

type KbDocumentListItemWithoutContent = Omit<KbDocumentListItem, "content">;

class KbDocumentModel {
  static async findById(id: string): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KbDocument[]> {
    if (ids.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(inArray(schema.kbDocumentsTable.id, ids));
  }

  static async findByKnowledgeBase(params: {
    knowledgeBaseId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KbDocument[]> {
    const normalizedSearch = params.search?.trim();
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        aclSyncGeneration: schema.kbDocumentsTable.aclSyncGeneration,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findListItemsByConnector(params: {
    connectorId: string;
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KbDocumentListItemWithoutContent[]> {
    const normalizedSearch = params.search?.trim();
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        title: schema.kbDocumentsTable.title,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        aclSyncGeneration: schema.kbDocumentsTable.aclSyncGeneration,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.updatedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findBySourceId(params: {
    connectorId: string;
    sourceId: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.sourceId, params.sourceId),
        ),
      );

    return result ?? null;
  }

  static async findBySourceIds(params: {
    connectorId: string;
    sourceIds: string[];
  }): Promise<KbDocument[]> {
    if (params.sourceIds.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          inArray(schema.kbDocumentsTable.sourceId, params.sourceIds),
        ),
      );
  }

  static async findByConnectorSourcePairs(
    pairs: { connectorId: string; sourceId: string }[],
  ): Promise<KbDocument[]> {
    if (pairs.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        or(
          ...pairs.map((pair) =>
            and(
              eq(schema.kbDocumentsTable.connectorId, pair.connectorId),
              eq(schema.kbDocumentsTable.sourceId, pair.sourceId),
            ),
          ),
        ),
      );
  }

  static async create(data: InsertKbDocument): Promise<KbDocument> {
    const [result] = await db
      .insert(schema.kbDocumentsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKbDocument>,
  ): Promise<KbDocument | null> {
    const [result] = await db
      .update(schema.kbDocumentsTable)
      .set(data)
      .where(eq(schema.kbDocumentsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Recover documents whose embedding stalled. A `batch_embedding` task that
   * exhausts its retries (or a worker that dies mid-embed) leaves a document at
   * `pending`/`processing` with nothing queued to finish it — and the sync
   * checkpoint has already advanced past it, so a resume won't re-ingest it.
   * Reset any such document not touched for `olderThanSeconds` back to `pending`
   * (bumping `updated_at` so the next sweep won't re-grab it) and return their
   * ids, capped at `limit`, for the caller to re-enqueue embedding.
   *
   * Age-gated well beyond the batch task's total retry window so a batch still
   * legitimately in flight is never disturbed; re-embedding is idempotent anyway
   * (the embedder skips any document that is no longer `pending`).
   */
  static async recoverStalledEmbeddings(params: {
    olderThanSeconds: number;
    limit: number;
  }): Promise<string[]> {
    const { rows } = await db.execute<{ id: string }>(sql`
      UPDATE kb_documents
      SET embedding_status = 'pending', updated_at = now()
      WHERE id IN (
        SELECT id FROM kb_documents
        WHERE embedding_status IN ('pending', 'processing')
          AND updated_at < now() - make_interval(secs => ${params.olderThanSeconds})
        ORDER BY updated_at ASC
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    return rows.map((r) => r.id);
  }

  static async countByConnector(connectorId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result?.count ?? 0;
  }

  static async countByConnectorWithSearch(params: {
    connectorId: string;
    organizationId: string;
    search?: string;
  }): Promise<number> {
    const normalizedSearch = params.search?.trim();
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      );

    return result?.count ?? 0;
  }

  static async findListItemByIdAndConnector(params: {
    documentId: string;
    connectorId: string;
    organizationId: string;
  }): Promise<KbDocumentListItem | null> {
    const [result] = await db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        aclSyncGeneration: schema.kbDocumentsTable.aclSyncGeneration,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.id, params.documentId),
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result.rowCount ?? 0;
  }

  static async deleteByConnectorAndSourceId(params: {
    connectorId: string;
    sourceId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.sourceId, params.sourceId),
        ),
      )
      .returning({ id: schema.kbDocumentsTable.id });
    return result.length > 0;
  }

  static async deleteByOrganization(organizationId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.organizationId, organizationId));

    return result.rowCount ?? 0;
  }

  /**
   * Bulk-apply a connector-level ACL to every document (org-wide / team-scoped
   * connectors, via `refreshConnectorDocumentAccessControlLists`). Epoch-fenced:
   * if the connector's `acl_config_epoch` changed since the caller read it (a
   * concurrent visibility/teamIds change), the whole write no-ops so the newest
   * config change wins regardless of ordering. Rows already at the target ACL
   * are skipped to avoid needless GIN churn.
   */
  static async updateAclByConnector(params: {
    connectorId: string;
    acl: AclEntry[];
    aclConfigEpoch: number;
  }): Promise<number> {
    const aclJson = JSON.stringify(params.acl);
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl = ${aclJson}::jsonb
        FROM ${schema.knowledgeBaseConnectorsTable} AS c
        WHERE d.connector_id = c.id
          AND d.connector_id = ${params.connectorId}
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
          AND d.acl IS DISTINCT FROM ${aclJson}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  // ===== Permission-sync pass (auto-sync-permissions connectors) =====

  /**
   * Lean projection of the current per-document ACL state for a batch of source
   * ids, used by the permission-sync pass to diff without loading document
   * content. O(batch) memory.
   */
  static async findAclStateBySourceIds(params: {
    connectorId: string;
    sourceIds: string[];
  }): Promise<{ id: string; sourceId: string | null; acl: string[] }[]> {
    if (params.sourceIds.length === 0) return [];

    return await db
      .select({
        id: schema.kbDocumentsTable.id,
        sourceId: schema.kbDocumentsTable.sourceId,
        acl: schema.kbDocumentsTable.acl,
      })
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          inArray(schema.kbDocumentsTable.sourceId, params.sourceIds),
        ),
      );
  }

  /**
   * Keyset-paginated read-back of a connector's ingested documents for
   * container-scoped permission tagging (GitHub: repo → its docs). Filters by an
   * optional `metadata` JSONB equality map, orders by id ascending, and returns
   * a lean `{ id, sourceId, metadata }` projection. O(limit) memory.
   */
  static async findIngestedForReadback(params: {
    connectorId: string;
    metadataFilter?: Record<string, string>;
    afterId?: string | null;
    limit: number;
  }): Promise<
    {
      id: string;
      sourceId: string | null;
      metadata: Record<string, unknown> | null;
    }[]
  > {
    const t = schema.kbDocumentsTable;
    const metadataConditions = Object.entries(params.metadataFilter ?? {}).map(
      ([key, value]) => sql`${t.metadata}->>${key} = ${value}`,
    );
    return await db
      .select({
        id: t.id,
        sourceId: t.sourceId,
        metadata: t.metadata,
      })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          params.afterId ? sql`${t.id} > ${params.afterId}::uuid` : undefined,
          ...metadataConditions,
        ),
      )
      .orderBy(t.id)
      .limit(params.limit);
  }

  /**
   * Write a changed document's ACL and stamp it with the current reconcile
   * generation, in one epoch-fenced statement. The chunk ACLs must already have
   * been rewritten (crash-safe ordering: chunks first, then this doc row). If
   * the connector's `acl_config_epoch` changed since the ACL was computed, the
   * write no-ops (returns false). Returns whether the row was updated.
   */
  static async updateAclAndGeneration(params: {
    documentId: string;
    connectorId: string;
    acl: AclEntry[];
    generation: number;
    aclConfigEpoch: number;
  }): Promise<boolean> {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE ${schema.kbDocumentsTable} AS d
      SET acl = ${JSON.stringify(params.acl)}::jsonb,
          acl_sync_generation = ${params.generation}
      FROM ${schema.knowledgeBaseConnectorsTable} AS c
      WHERE d.id = ${params.documentId}
        AND d.connector_id = ${params.connectorId}
        AND c.id = d.connector_id
        AND c.acl_config_epoch = ${params.aclConfigEpoch}
      RETURNING d.id
    `);
    return result.rows.length > 0;
  }

  /**
   * Stamp a batch of unchanged documents with the current reconcile generation
   * (the narrow, HOT-friendly per-run cost — no ACL rewrite). Epoch-fenced.
   * Returns the number of rows stamped.
   */
  static async stampGeneration(params: {
    documentIds: string[];
    connectorId: string;
    generation: number;
    aclConfigEpoch: number;
  }): Promise<number> {
    if (params.documentIds.length === 0) return 0;

    const ids = sql.join(
      params.documentIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl_sync_generation = ${params.generation}
        FROM ${schema.knowledgeBaseConnectorsTable} AS c
        WHERE d.connector_id = ${params.connectorId}
          AND c.id = d.connector_id
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
          AND d.id IN (${ids})
          AND d.acl_sync_generation IS DISTINCT FROM ${params.generation}
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);
    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  /**
   * Fail-close (acl=[]) a bounded batch of documents left behind by the current
   * generation `G` — i.e. no longer visible upstream (deleted, or access fully
   * removed). Clears both the document and its chunk ACLs and stamps the doc to
   * `G` so the batch terminates. MUST be called only after generation `G`
   * enumerates end-to-end (a partial generation never sweeps). Epoch-fenced.
   * Loop until it returns 0. Returns the number of documents fail-closed.
   */
  static async failCloseStaleDocuments(params: {
    connectorId: string;
    generation: number;
    aclConfigEpoch: number;
    batchSize: number;
  }): Promise<number> {
    const result = await db.execute<{ id: string }>(sql`
      WITH stale AS (
        SELECT d.id
        FROM ${schema.kbDocumentsTable} AS d
        JOIN ${schema.knowledgeBaseConnectorsTable} AS c
          ON c.id = d.connector_id
        WHERE d.connector_id = ${params.connectorId}
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
          AND d.acl_sync_generation IS DISTINCT FROM ${params.generation}
        ORDER BY d.id
        LIMIT ${params.batchSize}
      ),
      cleared_chunks AS (
        UPDATE ${schema.kbChunksTable} AS chunk
        SET acl = '[]'::jsonb
        FROM stale
        WHERE chunk.document_id = stale.id
          AND chunk.acl IS DISTINCT FROM '[]'::jsonb
        RETURNING 1
      ),
      cleared_docs AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl = '[]'::jsonb, acl_sync_generation = ${params.generation}
        FROM stale
        WHERE d.id = stale.id
        RETURNING d.id
      )
      SELECT id FROM cleared_docs
    `);
    return result.rows.length;
  }

  static async countByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, number>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
        count: count(),
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        inArray(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      )
      .groupBy(schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId);

    return new Map(results.map((r) => [r.knowledgeBaseId, r.count]));
  }
}

export default KbDocumentModel;
