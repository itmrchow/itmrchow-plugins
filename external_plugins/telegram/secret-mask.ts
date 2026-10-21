/**
 * Mask common secret shapes before text leaves for Telegram (JP-374).
 *
 * A port of `mask_secrets` in my-claude-config's hooks/tg-notify.sh
 * (SECRET_MASK_JQ_DEF), rule for rule and in the same order, so a command looks
 * the same in an approval request as in the existing permission notice. Change
 * both together.
 *
 * Masked: Authorization / Bearer values, key=value (also JSON-quoted keys and
 * spaces around `=` / `:`), known token prefixes (only at a word start, so
 * `task-` is left alone), and credentials in URLs. Not masked: space-separated
 * flags such as `--password <value>`; a quoted value with spaces is masked up
 * to its first space. A regex mask always lets something through — it lowers
 * common leaks, it is not a guarantee.
 */

const MASK = '***'

/** [pattern, replacement] in application order; `$<name>` keeps the captured prefix. */
const SECRET_RULES: readonly (readonly [RegExp, string])[] = [
  [/(?<key>authorization:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, `$<key>${MASK}`],
  [/(?<key>bearer\s+)[^\s"']+/gi, `$<key>${MASK}`],
  [/(?<key>(?:token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*["']?)[^\s"'&]+/gi, `$<key>${MASK}`],
  [/(?<![A-Za-z0-9_])(?:sk-|ghp_|gho_|github_pat_|glpat-|xox[abpr]-)[A-Za-z0-9_.-]{6,}/g, MASK],
  [/(?<scheme>:\/\/)[^/\s@]+@/g, `$<scheme>${MASK}@`],
]

/**
 * Replace common secret shapes with `***`.
 *
 * @param text - Text about to be shown in Telegram.
 * @returns The text with every rule applied.
 * @example
 * maskSecrets('curl -H "Authorization: Bearer sk-abc123456"') // 'curl -H "Authorization: Bearer ***"'
 */
export function maskSecrets(text: string): string {
  return SECRET_RULES.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text)
}
