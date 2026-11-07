/**
 * @local/dsh-auv — AUV desktop automation as native DSH tools.
 *
 * `ctx.tools.register()` is effect-scoped by the tool registry, so registrations
 * are removed automatically when this plugin unloads; `apply` stays synchronous
 * and never touches the AUV binary (binary resolution happens lazily on the
 * first tool call).
 */

import { resolveAuvBinary } from './src/auv.mjs'
import { createTools } from './src/tools.mjs'

export const inject = ['tools']

export function apply(ctx) {
  for (const definition of createTools()) {
    ctx.tools.register(definition)
  }

  // Preflight: the Bridge is useless without the external AUV CLI. Do not fail
  // activation (the tools stay registered and each call reports its own error),
  // but log one actionable message so a missing prerequisite is visible in the
  // Host console instead of only on the first tool call.
  try {
    resolveAuvBinary()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dsh-auv] AUV is not available yet. The auv_* tools will fail until it is installed.\n${message}`)
  }
}
