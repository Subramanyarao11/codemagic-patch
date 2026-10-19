import type { AppSettingCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { resolveAppId } from "./resolveNames";
import { buildApiUrl, type CommandDeps } from "./shared";

/**
 * Without a setting flag this is a read of the app; with one it is the update.
 * Both routes answer `{ app }`, so one view renders either result.
 */
export async function executeAppSetting(
  command: AppSettingCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const appId = await resolveAppId(
    command.app,
    command.serverUrl,
    command.token,
    deps,
  );
  const url = buildApiUrl(
    command.serverUrl,
    `/v1/apps/${encodeURIComponent(appId)}`,
  );

  if (command.requireCodeSigning === undefined) {
    return authenticatedRequest(deps, {
      init: { method: "GET" },
      serverUrl: command.serverUrl,
      token: command.token,
      url,
    });
  }

  return authenticatedRequest(deps, {
    init: {
      body: JSON.stringify({
        require_code_signing: command.requireCodeSigning,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "PATCH",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url,
  });
}
