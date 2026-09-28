/**
 * Configuration variables carried the BYTER_ prefix before the project was renamed to
 * Squasher. They are public configuration — documented in .env.example and set in real
 * .env files and shell invocations — so the old names keep working rather than silently
 * dropping settings on upgrade.
 *
 * SQUASHER_ wins when both are set, so a deployment can migrate one variable at a time.
 */
export function brandedEnv(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`SQUASHER_${suffix}`] ?? env[`BYTER_${suffix}`];
}

/** Names accepted for one setting, newest first, for reporting which alias supplied it. */
export function brandedEnvNames(suffix: string): [string, string] {
  return [`SQUASHER_${suffix}`, `BYTER_${suffix}`];
}
