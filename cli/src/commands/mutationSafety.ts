import { PRODUCT_NAME } from "../branding";
import { isInteractiveOutput } from "../output";
import { writeNote } from "../notice";
import {
  canPromptOnStderr,
  type CommandDeps,
  DeclinedError,
  UsageError,
} from "./shared";

export type MutationSafetyInput = {
  commandName: string;
  dryRun?: boolean;
  fields: Array<[string, string | undefined]>;
  nonInteractive: boolean;
  yes: boolean;
};

export async function enforceMutationSafety(
  deps: CommandDeps,
  input: MutationSafetyInput,
): Promise<void> {
  if (input.dryRun === true || input.yes) {
    return;
  }

  if (deps.stderr !== undefined && isInteractiveOutput(deps.stderr)) {
    writeNote(
      deps.stderr,
      `${input.commandName} will mutate ${PRODUCT_NAME} state:`,
      input.fields.map(([key, value]) => `${key}: ${value ?? "-"}`),
    );
  }

  // Interactive fallback: in a real TTY (and not forced non-interactive — JSON
  // output forces it upstream via withJsonNonInteractiveMode), confirm instead
  // of hard-failing. The stderr check matters: the confirm renders to stderr,
  // so with `2>file` we fail fast instead of blocking on an invisible prompt.
  // Explicit decline → DeclinedError (exit 1); Ctrl-C during the prompt still
  // raises PromptAbortError → "Aborted." with exit 130.
  const canPrompt = canPromptOnStderr(deps, input.nonInteractive);

  if (canPrompt && deps.confirm !== undefined) {
    const confirmed = await deps.confirm({
      initial: false,
      message: `Proceed with ${input.commandName}?`,
    });
    if (confirmed) {
      return;
    }
    throw new DeclinedError(
      `Aborted: ${input.commandName} was not confirmed.`,
    );
  }

  throw missingYesError(input);
}

/**
 * The same gate, asked before anything is read. A command whose note names
 * what it looked up (an app's name, the team it is in) can only call
 * enforceMutationSafety after those reads; this lets it refuse a run that
 * could neither skip nor answer the confirm before it sends a request.
 */
export function assertMutationConfirmable(
  deps: CommandDeps,
  input: Omit<MutationSafetyInput, "fields">,
): void {
  if (input.dryRun === true || input.yes) {
    return;
  }

  if (
    canPromptOnStderr(deps, input.nonInteractive) &&
    deps.confirm !== undefined
  ) {
    return;
  }

  throw missingYesError(input);
}

function missingYesError(
  input: Pick<MutationSafetyInput, "commandName" | "dryRun">,
): UsageError {
  // Only commands that actually accept --dry-run pass `dryRun` here, so the
  // suggestion never points at a flag the command would reject.
  const dryRunHint =
    input.dryRun === undefined
      ? ""
      : ", or use --dry-run to inspect the payload first";
  return new UsageError(
    `Missing --yes for ${input.commandName}. Re-run with --yes after validating the command inputs${dryRunHint}.`,
  );
}
