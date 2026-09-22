/**
 * OpenCode Zen free-tier adapter plugin.
 * @module dsh-opencode-free
 */

import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { ZenAdapter } from './adapter.js'
import type { ZenImageAccessResolver } from './adapter.js'
import { resolveZenOptions } from './config.js'
import type { Options, ResolvedZenOptions } from './config.js'
import { ZEN_ANONYMOUS_KEY, ZEN_PROVIDER } from './zen.js'

export { ZenAdapter, zenAuth, zenModels } from './adapter.js'
export { Config, resolveZenOptions } from './config.js'
export type { Options, ResolvedZenOptions, ZenReasoning } from './config.js'
export { ZEN_API_KEY_ENV, ZEN_BASE_URL, ZEN_PROVIDER } from './zen.js'

/**
 * Plugin name.
 */
export const name = 'opencode-free'

/**
 * Required services.
 */
export const inject = ['llm']

const NS = 'opencode-free'

/**
 * Resolve one attachment into the current execution world.
 * @param ctx - plugin context.
 * @returns image access resolver for this plugin.
 */
function imageAccessOf(ctx: Context): ZenImageAccessResolver {
  return (attachments, ref) => resolveImageAttachmentAccess(
    attachments,
    hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
    ref,
  )
}

/**
 * Register the Zen free-tier route.
 * @param ctx - plugin context.
 * @param config - static configuration.
 */
export function apply(ctx: Context, config: Options): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
  const options = (): ResolvedZenOptions => resolveZenOptions(config)
  options()

  const resolveApiKey = async (): Promise<string> => {
    const ref = options().apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'dsh-opencode-free', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'dsh-opencode-free', ref)
      }
    }
    // The launch environment already layers the managed store, project and
    // user `.env` files, and the inherited process environment, so absence
    // here means the anonymous tier.
    return ZEN_ANONYMOUS_KEY
  }

  const adapter = new ZenAdapter({
    options,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: imageAccessOf(ctx),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger.warn(`dsh-opencode-free: unusable replay for "${provider}/${model}" (${reason}); sending neutral content`)
    },
  })
  ctx.llm.registerConfigurableProviders([
    {
      provider: ZEN_PROVIDER,
      displayName: 'OpenCode Zen Free',
      settingsNs: ctx.fiber.entry?.options.id ?? NS,
      settingsPath: [],
    },
  ])
  ctx.llm.registerAdapter([ZEN_PROVIDER], adapter)
}
