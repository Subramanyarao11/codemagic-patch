import type { SqlMigration } from "./index";

/**
 * `sdk_version` left the metric envelope: the SDKs stopped sending it, the
 * server stopped storing it, and nothing ever read it.
 *
 * Deliberately not backward compatible. A server older than this migration
 * still INSERTs the column, so its metric ingest fails while it keeps serving
 * during a rollout (the new Cloud Run revision migrates before the old one
 * stops) and after a rollback to an older image. Accepted when the field was
 * dropped, rather than deferring the drop to a later release.
 *
 * DROP COLUMN only marks the column dropped in the catalog — no table rewrite —
 * so the ACCESS EXCLUSIVE lock it takes on `metric_event` is brief.
 */
export const dropMetricEventSdkVersionMigration: SqlMigration = {
  name: "0018_drop_metric_event_sdk_version",
  sql: `
    ALTER TABLE metric_event
      DROP COLUMN sdk_version;
  `,
};
