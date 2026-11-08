/**
 * @local/dsh-auv — AUV desktop automation as native DSH tools.
 *
 * `ctx.tools.register()` is effect-scoped by the tool registry, so registrations
 * are removed automatically when this plugin unloads; `apply` stays synchronous
 * and never touches the AUV binary or the SDK daemon (both are resolved lazily
 * on the first tool call).
 *
 * The app-owned `@auv-js/sdk` daemon is a module resource, not a tool
 * registration, so it is registered for disposal explicitly: unloading or
 * reloading the plugin stops the daemon instead of leaking it.
 */

import { resolveAuvBinary } from './src/auv.mjs'
import { createTools } from './src/tools.mjs'
import { disposeSdkTransport } from './src/transport/sdk.mjs'

export const inject = ['tools']

export function apply(ctx) {
  for (const definition of createTools()) {
    ctx.tools.register(definition)
  }

  // Best-effort teardown of the SDK transport's owned daemon. `ctx.effect`
  // (Cordis) runs the callback immediately and calls the returned disposer on
  // unload; fall back to a dispose event listener if the Host context lacks it.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => disposeSdkTransport())
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      void disposeSdkTransport()
    })
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
