import type { TokenRevokeCommand } from "../commandTypes";
import { authenticatedRequest } from "../authenticatedRequest";
import { isRecord } from "../output";
import { assertMutationConfirmable, enforceMutationSafety } from "./mutationSafety";
import { buildApiUrl, UsageError, type CommandDeps } from "./shared";

export async function executeTokenRevoke(
  command: TokenRevokeCommand,
  deps: CommandDeps,
): Promise<unknown> {
  const safety = {
    commandName: "token revoke",
    nonInteractive: command.nonInteractive === true,
    yes: command.yes === true,
  };
  // A --name run reads the token list first; refuse a run that could not
  // answer the confirm before that read.
  assertMutationConfirmable(deps, safety);

  const tokenId =
    command.apiToken.tokenId ??
    (await resolveTokenIdByName(command, command.apiToken.name, deps));

  await enforceMutationSafety(deps, {
    ...safety,
    fields: [
      ["serverUrl", command.serverUrl],
      ["tokenId", tokenId],
      ...(command.apiToken.name !== undefined
        ? [["tokenName", command.apiToken.name] as [string, string]]
        : []),
    ],
  });

  return authenticatedRequest(deps, {
    init: {
      method: "DELETE",
    },
    serverUrl: command.serverUrl,
    token: command.token,
    url: buildApiUrl(
      command.serverUrl,
      `/v1/auth/tokens/${encodeURIComponent(tokenId)}`,
    ),
  });
}

/**
 * A display name is not unique, so it is matched exactly and never guessed
 * between: revoking the wrong one of two "ci" tokens breaks a pipeline the user
 * did not mean to touch.
 */
async function resolveTokenIdByName(
  command: TokenRevokeCommand,
  name: string,
  deps: CommandDeps,
): Promise<string> {
  const tokens = parseTokenListResponse(
    await authenticatedRequest(deps, {
      init: { method: "GET" },
      serverUrl: command.serverUrl,
      token: command.token,
      url: buildApiUrl(command.serverUrl, "/v1/auth/tokens"),
    }),
  );
  const matches = tokens.filter((candidate) => candidate.name === name);
  const [only] = matches;

  if (matches.length === 1 && only !== undefined) {
    return only.id;
  }

  if (matches.length > 1) {
    throw new UsageError(
      [
        `Token name "${name}" is ambiguous. Matching IDs: ${matches
          .map((match) => match.id)
          .join(", ")}`,
        "Next: pass --token-id with one of the IDs above.",
      ].join("\n"),
    );
  }

  const available = [...new Set(tokens.map((candidate) => candidate.name))];

  throw new UsageError(
    [
      `Token "${name}" not found. Available tokens: ${
        available.length === 0 ? "none" : available.join(", ")
      }`,
      "Next: pass --name with one of the names above, or --token-id from `cmpatch token list`.",
    ].join("\n"),
  );
}

function parseTokenListResponse(
  response: unknown,
): Array<{ id: string; name: string }> {
  const tokens = isRecord(response) ? response.api_tokens : undefined;

  if (!Array.isArray(tokens) || !tokens.every(isTokenEntry)) {
    throw new UsageError(
      'Malformed tokens response: expected { "api_tokens": [{ "id": string, "display_name": string }] }',
    );
  }

  return tokens.map((token) => ({ id: token.id, name: token.display_name }));
}

function isTokenEntry(
  value: unknown,
): value is { display_name: string; id: string } {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.display_name === "string"
  );
}
