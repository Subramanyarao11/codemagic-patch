// `cmpatch team list` / `cmpatch team show`: the teams this principal can see,
// as `GET /v1/teams` and `GET /v1/teams/:teamId` report them. Teams are not
// created or disabled from the CLI; these only read.

import type { TeamListCommand, TeamShowCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveTeamId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

export async function executeTeamList(
  command: TeamListCommand,
  deps: CommandDeps,
): Promise<unknown> {
  // The server filters to the caller's teams, so what is printed is its
  // response as it came.
  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, "/v1/teams"),
  });
}

export async function executeTeamShow(
  command: TeamShowCommand,
  deps: CommandDeps,
): Promise<unknown> {
  // The same resolution every team-scoped command uses: an id is taken as is,
  // a name is looked up, and no selector means the sole visible team or a
  // choice among several.
  const teamId = await resolveTeamId(
    command.team,
    command.serverUrl,
    command.token,
    deps,
  );

  return authenticatedRequest(deps, {
    init: {
      method: "GET",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(command.serverUrl, `/v1/teams/${encodeURIComponent(teamId)}`),
  });
}
