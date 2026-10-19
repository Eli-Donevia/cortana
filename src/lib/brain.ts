import * as bridge from './bridge'
import type { Blade, DataPath } from '../store'

export type { AskHandlers, ConnectionState } from './bridge'

/**
 * The brain: Claude Code on this Mac, through the local bridge.
 *
 * Conversation state lives in the bridge's agent session, so there is no
 * history to thread through here. Upstream also had a browser-direct path that
 * needed an Anthropic API key in the bundle; Donevia Jarvis does not.
 */

export function ask(prompt: string, handlers: bridge.AskHandlers): Promise<{ text: string; tools: string[] }> {
  return bridge.ask(prompt, handlers)
}

export const warm = (): Promise<void> => bridge.warmBridge()

/** HQ, connectors and local servers, for the SYSTEMS rail. */
export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

export function watchDataPath(fn: (p: DataPath) => void): void {
  bridge.watchDataPath(fn)
}

/** Cards from the `display` tool, pushed mid-turn. */
export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

/** Theme, reactor and effect commands from the `ui_*` tools. */
export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

/** Barge-in: stop the bridge and settle the outstanding ask() locally. */
export function interrupt(): void {
  bridge.cancel()
}

export const isConnected = (): boolean => bridge.isConnected()

export function watchConnection(fn: (state: bridge.ConnectionState) => void): void {
  bridge.watchConnection(fn)
}

export const connectedLabels = (): string[] => bridge.bridgeServers()
