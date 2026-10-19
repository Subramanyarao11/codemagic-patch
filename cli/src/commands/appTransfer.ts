// `cmpatch app transfer`: move an app, with its deployments, to another team
// through `POST /v1/apps/:appId/transfer`, the route behind the dashboard's
// Transfer action. Where the dashboard asks for confirmation in a dialog, the
// CLI's mutation confirm (or --yes) is that stop; nothing is typed.

import type { AppTransferCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord } from "../output";
import { HttpProblemError } from "../problem-details";
import { withAppTransferProblemHint } from "../serverProblemHints";
import { assertMutationConfirmable, enforceMutationSafety } from "./mutationSafety";
import {
  canPickDestinationTeam,
  missingDestinationTeamError,
  resolveAppId,
  resolveDestinationTeam,
  type TransferTeam,
} from "./resolveNames";
import { buildApiUrl, type CommandDeps, UsageError } from "./shared";

export async function executeAppTransfer(
  command: AppTransferCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const nonInteractive = command.nonInteractive === true;
  const yes = command.yes === true;
  const resolveOptions = { nonInteractive: nonInteractive || yes };

  // Both refusals that need no server come first, so a run that cannot finish
  // sends nothing: a destination nobody named and nobody can be asked for, and
  // a confirm nobody can answer.
  if (
    command.destTeam.teamId === undefined &&
    command.destTeam.teamName === undefined &&
    !canPickDestinationTeam(deps, resolveOptions)
  ) {
    throw missingDestinationTeamError(command.serverUrl);
  }

  assertMutationConfirmable(deps, {
    commandName: "app transfer",
    nonInteractive,
    yes,
  });

  const appId = await resolveAppId(
    command.app,
    command.serverUrl,
    command.token,
    deps,
    resolveOptions,
  );
  // An id is not checked against this CLI's framework (appFramework.ts), so
  // an app found with `cmpatch-capacitor app list` is transferred the same
  // way. The read supplies the app's current team, which is never a
  // destination, and the name the note shows.
  const app = parseAppResponse(
    await authenticatedRequest(deps, {
      init: {
        method: "GET",
      },
      serverUrl: command.serverUrl,
      token: command.token,
      url: buildApiUrl(command.serverUrl, `/v1/apps/${encodeURIComponent(appId)}`),
    }),
  );
  const { from, to } = await resolveDestinationTeam(
    command.destTeam,
    app,
    command.serverUrl,
    command.token,
    deps,
    resolveOptions,
  );

  await enforceMutationSafety(deps, {
    commandName: "app transfer",
    fields: [
      ["serverUrl", command.serverUrl],
      ["appId", app.id],
      ["appName", app.name],
      ["fromTeam", formatTransferTeam(from)],
      ["destTeam", formatTransferTeam(to)],
    ],
    nonInteractive,
    yes,
  });

  try {
    return await authenticatedRequest(deps, {
      init: {
        body: JSON.stringify({ team_id: to.id }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": deps.randomUUID(),
        },
        method: "POST",
      },
      serverUrl: command.serverUrl,
      token: command.token,
      url: buildApiUrl(
        command.serverUrl,
        `/v1/apps/${encodeURIComponent(app.id)}/transfer`,
      ),
    });
  } catch (error) {
    if (error instanceof HttpProblemError) {
      throw new HttpProblemError(
        withAppTransferProblemHint(error.problem, {
          appName: app.name,
          destTeam: to.name ?? to.id,
        }),
        error.responseStatus,
        error.serverUrl,
      );
    }

    throw error;
  }
}

function formatTransferTeam(team: TransferTeam): string {
  return team.name === undefined ? team.id : `${team.name} (${team.id})`;
}

function parseAppResponse(response: unknown): {
  id: string;
  name: string;
  teamId: string;
} {
  const app = isRecord(response) ? response.app : undefined;

  if (
    !isRecord(app) ||
    typeof app.id !== "string" ||
    typeof app.name !== "string" ||
    typeof app.team_id !== "string"
  ) {
    throw new UsageError(
      'Malformed app response: expected { "app": { "id": string, "name": string, "team_id": string } }',
    );
  }

  return { id: app.id, name: app.name, teamId: app.team_id };
}
