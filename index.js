/**
 * @local/dsh-auv — AUV desktop automation as native DSH tools.
 *
 * `ctx.tools.register()` is effect-scoped by the tool registry, so registrations
 * are removed automatically when this plugin unloads; `apply` stays synchronous
 * and never touches the AUV binary or the SDK daemon (the transport is resolved
 * lazily on the first tool call).
 *
 * The SDK transport is attach-first: the first tool call attaches to a running
 * discoverable AUV daemon, and only starts a plugin-owned daemon when none is
 * reachable. The connection (and the owned daemon, if any) is a module
 * resource, not a tool registration, so it is registered for disposal
 * explicitly: unloading or reloading the plugin closes the connection and stops
 * the daemon only when this plugin started it.
 */

import { resolveAuvBinary } from './src/auv.mjs'
import { createTools } from './src/tools.mjs'
import { disposeSdkTransport } from './src/transport/sdk.mjs'

export const inject = ['tools']

export function apply(ctx) {
  for (const definition of createTools()) {
    ctx.tools.register(definition)
  }

  // Best-effort teardown of the SDK transport. `ctx.effect` (Cordis) runs the
  // callback immediately and calls the returned disposer on unload; fall back to
  // a dispose event listener if the Host context lacks it.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => disposeSdkTransport())
  } else if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      void disposeSdkTransport()
    })
  }

  // Preflight: an owned daemon needs the external AUV executable; attaching to a
  // running daemon does not. Do not fail activation (the tools stay registered
  // and each call reports its own error), but log one actionable message so a
  // missing prerequisite is visible in the Host console instead of only on the
  // first tool call.
  try {
    resolveAuvBinary()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `[dsh-auv] AUV was not found on PATH. The auv_* tools can still attach to an already-running AUV daemon, but cannot start their own until AUV is installed.\n${message}`,
    )
  }
}
