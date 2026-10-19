// The failure drill-down behind the dashboard's failure dialog, at deployment
// and release scope: `deployment failures` / `release failures` read a
// reason's codes (`…/failures`) or one code bucket's distribution
// (`…/failures/distribution`); `deployment failure-events` /
// `release failure-events` page through that bucket's raw events
// (`…/failures/events`). The two nouns differ only in how the scope id is
// resolved and in the path prefix.

import type {
  DeploymentFailureEventsCommand,
  DeploymentFailuresCommand,
  FailureCodeBucket,
  ReleaseFailureEventsCommand,
  ReleaseFailuresCommand,
} from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord, type Palette } from "../output";
import { resolveDeploymentId, resolveReleaseId } from "./resolveNames";
import {
  buildApiUrlWithQuery,
  withUnavailableFeatureMessage,
  type CommandDeps,
} from "./shared";

export const FAILURE_DRILLDOWN_UNAVAILABLE_MESSAGE =
  "This server does not publish failure drill-down (server too old or failure detail disabled).";

type FailureLevel = "codes" | "distribution" | "events";

const LEVEL_PATHS: Record<FailureLevel, string> = {
  codes: "failures",
  distribution: "failures/distribution",
  events: "failures/events",
};

type FailureRequest = {
  codeBucket?: FailureCodeBucket;
  cursor?: string;
  limit?: number;
  reason: string;
  serverUrl: string;
  token?: string;
};

export async function executeDeploymentFailures(
  command: DeploymentFailuresCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );

  return requestFailures(
    deps,
    `deployments/${encodeURIComponent(deploymentId)}`,
    command.codeBucket === undefined ? "codes" : "distribution",
    command,
  );
}

export async function executeDeploymentFailureEvents(
  command: DeploymentFailureEventsCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const deploymentId = await resolveDeploymentId(
    command.deployment,
    command.serverUrl,
    command.token,
    deps,
  );

  return requestFailures(
    deps,
    `deployments/${encodeURIComponent(deploymentId)}`,
    "events",
    command,
  );
}

export async function executeReleaseFailures(
  command: ReleaseFailuresCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const releaseId = await resolveReleaseId(
    command.release,
    command.serverUrl,
    command.token,
    deps,
  );

  return requestFailures(
    deps,
    `releases/${encodeURIComponent(releaseId)}`,
    command.codeBucket === undefined ? "codes" : "distribution",
    command,
  );
}

export async function executeReleaseFailureEvents(
  command: ReleaseFailureEventsCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const releaseId = await resolveReleaseId(
    command.release,
    command.serverUrl,
    command.token,
    deps,
  );

  return requestFailures(
    deps,
    `releases/${encodeURIComponent(releaseId)}`,
    "events",
    command,
  );
}

/**
 * One request builder for every level and scope. The no-code bucket is an
 * omitted `code` parameter, as the server and the dashboard define it; the
 * codes level never carries a bucket, so it never sends `code` either.
 */
function requestFailures(
  deps: CommandDeps,
  scopePath: string,
  level: FailureLevel,
  request: FailureRequest,
): Promise<unknown> {
  return withUnavailableFeatureMessage(
    authenticatedRequest(deps, {
      init: {
        method: "GET",
      },
      serverUrl: request.serverUrl,
      token: request.token,
      url: buildApiUrlWithQuery(
        request.serverUrl,
        `/v1/metrics/${scopePath}/${LEVEL_PATHS[level]}`,
        {
          code:
            request.codeBucket?.kind === "code"
              ? request.codeBucket.code
              : undefined,
          cursor: request.cursor,
          limit: request.limit,
          reason: request.reason,
        },
      ),
    }),
    FAILURE_DRILLDOWN_UNAVAILABLE_MESSAGE,
  );
}

/** The line under an events page that names how to read the next one. */
export function renderFailureEventsCursorNote(
  result: unknown,
  palette: Palette,
): string {
  if (!isRecord(result) || typeof result.next_cursor !== "string") {
    return "";
  }

  return `\n${palette.dim(`More events: re-run with --cursor ${result.next_cursor}`)}\n`;
}
