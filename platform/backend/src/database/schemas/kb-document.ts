import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EmbeddingStatus, KbDocumentMetadata } from "@/types/kb-document";
import knowledgeBaseConnectorsTable from "./knowledge-base-connector";

const kbDocumentsTable = pgTable(
  "kb_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id"),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => knowledgeBaseConnectorsTable.id, {
        onDelete: "cascade",
      }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUrl: text("source_url"),
    acl: jsonb("acl").$type<string[]>().notNull().default([]),
    // Generation stamp written by the permission-sync pass's generation-gated
    // full reconcile. Each run enumerates upstream under a fresh generation `G`
    // and stamps every document it (re)tags with `G`; only after `G` enumerates
    // end-to-end does the pass fail-close (acl=[]) documents left at a prior
    // generation. Unindexed / HOT-friendly (a narrow bigint, not the wide GIN
    // `acl` column). NULL = never touched by a permission pass.
    aclSyncGeneration: bigint("acl_sync_generation", { mode: "number" }),
    metadata: jsonb("metadata").$type<KbDocumentMetadata>().default({}),
    embeddingStatus: text("embedding_status")
      .$type<EmbeddingStatus>()
      .notNull()
      .default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("kb_documents_org_id_idx").on(table.organizationId),
    uniqueIndex("kb_documents_source_idx").on(
      table.connectorId,
      table.sourceId,
    ),
  ],
);

export default kbDocumentsTable;
