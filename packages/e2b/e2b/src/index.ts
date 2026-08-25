/**
 * Shared ownership of one E2B sandbox. Capability adapters await the same SDK
 * handle, so filesystem and process operations inhabit one remote Linux world.
 * @module @deepseek-ai/dsh-e2b
 */

import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileType, Sandbox, SandboxNotFoundError } from 'e2b'

export {
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
} from 'e2b'
export type { CommandHandle, CommandResult, EntryInfo } from 'e2b'

/**
 * Quote one opaque argument for the SDK's unavoidable `/bin/bash -l -c` layer.
 * @param value - Exact argument value to preserve.
 * @returns A single shell word with no interpolation.
 */
export function quoteE2BShellArg(value: string): string {
  return `'${value.replaceAll('\'', "'\"'\"'")}'`
}

/**
 * Isolate E2B's hard-coded login shell behind a fresh randomized home path.
 * @param overrides - Additional environment entries for the internal command.
 * @returns A fresh mutable map that the E2B SDK may extend.
 */
export function e2bControlEnvs(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...overrides, HOME: `/.dsh-e2b-control-${randomUUID()}` }
}

/**
 * Map a host (or mixed) path onto the sandbox cwd.
 *
 * Web sessions carry `session.header.cwd` from the GUI picker — typically a
 * macOS/Windows absolute path. Official fs/bash consumers pass that through
 * as `opts.cwd` / `spec.cwd`. posix.resolve keeps a host-absolute first
 * argument, so the model then reads `/Users/...` inside Linux.
 */
export function remapHostCwdToSandbox(sandboxCwd: string, cwd: string): string {
  const posixCwd = toPosixPath(cwd)
  if (isHostAbsolute(posixCwd)) return sandboxCwd
  return posix.isAbsolute(posixCwd) ? posixCwd : posix.resolve(sandboxCwd, posixCwd)
}

export function remapHostPathToSandbox(sandboxCwd: string, path: string, cwd?: string): string {
  const posixPath = toPosixPath(path)
  const originalCwd = cwd !== undefined && cwd.length > 0 ? toPosixPath(cwd) : sandboxCwd
  if (isHostAbsolute(posixPath)) {
    if (isHostAbsolute(originalCwd)) {
      const relative = posix.relative(originalCwd, posixPath)
      if (relative === '') return sandboxCwd
      if (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)) {
        return posix.resolve(sandboxCwd, relative)
      }
    }
    return posix.resolve(sandboxCwd, posix.basename(posixPath))
  }
  return posix.resolve(remapHostCwdToSandbox(sandboxCwd, originalCwd), posixPath)
}

export function isHostAbsolute(path: string): boolean {
  const posixPath = toPosixPath(path)
  if (/^[A-Za-z]:\//.test(posixPath) || posixPath.startsWith('//')) return true
  return (
    posixPath === '/Users' || posixPath.startsWith('/Users/')
    || posixPath === '/Volumes' || posixPath.startsWith('/Volumes/')
    || posixPath === '/private' || posixPath.startsWith('/private/')
    || posixPath === '/Applications' || posixPath.startsWith('/Applications/')
    || posixPath === '/System' || posixPath.startsWith('/System/')
    || posixPath === '/Library' || posixPath.startsWith('/Library/')
    || posixPath === '/opt/homebrew' || posixPath.startsWith('/opt/homebrew/')
  )
}

function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Configuration for the shared E2B sandbox owner. */
export interface Config {
  /** API key; omission reads `E2B_API_KEY`. It is never forwarded into the sandbox. */
  apiKey?: string
  /**
   * Self-hosted API entry (e.g. `https://api.example.internal`); omission reads
   * `E2B_API_URL`. Required: never defaults to the E2B cloud.
   */
  apiUrl?: string
  /**
   * Sandbox wildcard domain (e.g. `example.internal`); omission reads
   * `E2B_DOMAIN`. Required: without it the SDK routes envd traffic to
   * `e2b.app` and reports sandbox-not-found for live sandboxes.
   */
  domain?: string
  /**
   * Template **ID** (never an alias — aliases are rejected by the self-hosted
   * API); omission reads `E2B_TEMPLATE`. Required.
   */
  template?: string
  /** Shared remote working directory, created before adapters receive the sandbox. */
  cwd?: string
  /** E2B sandbox lifetime in milliseconds; expiry always deletes the sandbox. */
  timeoutMs?: number
}

interface ResolvedConfig {
  apiKey: string
  apiUrl: string
  domain: string
  template: string
  cwd: string
  timeoutMs: number
}

interface SchemaResolvedConfig extends Config {
  cwd: string
  timeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    e2b: E2BRuntime
  }
}

/**
 * Creates one lazily consumable E2B SDK handle and deletes the sandbox at
 * timeout or disposal. Creation begins at plugin construction; adapters await
 * {@link getSandbox} before their first operation.
 */
export class E2BRuntime extends Service {
  static Config: z<Config> = z.object({
    apiKey: z.string(),
    apiUrl: z.string(),
    domain: z.string(),
    template: z.string(),
    cwd: z.string().default('/home/user/workspace'),
    timeoutMs: z.number().default(300_000),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string
  /** Remote directory reserved for adapter-owned process and terminal state. */
  readonly runtimeRoot: string

  private readonly config: ResolvedConfig
  private readonly ready: Promise<Sandbox>
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'e2b')
    // Schemastery fills these fields before construction; the type does not encode that step.
    const resolved = config as SchemaResolvedConfig
    this.config = {
      apiKey: config.apiKey ?? process.env.E2B_API_KEY ?? '',
      apiUrl: config.apiUrl ?? process.env.E2B_API_URL ?? '',
      domain: config.domain ?? process.env.E2B_DOMAIN ?? '',
      template: config.template ?? process.env.E2B_TEMPLATE ?? '',
      cwd: resolved.cwd,
      timeoutMs: resolved.timeoutMs,
    }
    this.validate()
    this.cwd = this.config.cwd
    this.runtimeRoot = posix.join(this.cwd, '.dsh-e2b')
    this.ready = this.open()
    // A deployment may load the owner before any adapter uses it. Keep a
    // failed eager connection observed; getSandbox() still returns the error.
    void this.ready.catch(() => {})

    ctx.effect(() => async () => {
      this.disposed = true
      let sandbox: Sandbox
      try {
        sandbox = await this.ready
      } catch (_sandboxSetupFailure) {
        // open() either acquired no sandbox or already made the POC's one rollback attempt.
        return
      }
      try {
        await sandbox.kill()
      } catch (error: unknown) {
        if (!(error instanceof SandboxNotFoundError)) throw error
      }
    }, 'e2b sandbox teardown')
  }

  /**
   * Return the shared live SDK handle.
   * Each successful acquisition also resets the sandbox TTL to `timeoutMs`
   * (official create is kill-on-timeout with no keep-alive; an idle Web GUI
   * otherwise dies before the first tool call).
   * @returns the created sandbox after the configured cwd exists.
   * @throws when E2B rejects creation or the service is disposing.
   */
  async getSandbox(): Promise<Sandbox> {
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    const sandbox = await this.ready
    // Disposal can race the awaited sandbox readiness despite the synchronous precheck.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaiting readiness yields to disposal.
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    await sandbox.setTimeout(this.config.timeoutMs)
    if (this.disposed) throw new Error('E2B sandbox service is disposing')
    return sandbox
  }

  private validate(): void {
    if (this.config.apiKey.length === 0) {
      throw new Error('dsh-e2b: configure apiKey or set E2B_API_KEY')
    }
    // Fail closed: an empty self-hosted endpoint must never fall through to the
    // E2B cloud defaults baked into the SDK.
    if (this.config.apiUrl.length === 0) {
      throw new Error('dsh-e2b: configure apiUrl or set E2B_API_URL (the cloud default does not apply to a self-hosted cluster)')
    }
    if (this.config.domain.length === 0) {
      throw new Error('dsh-e2b: configure domain or set E2B_DOMAIN (without it envd traffic routes to e2b.app and live sandboxes look missing)')
    }
    if (this.config.template.length === 0) {
      throw new Error('dsh-e2b: configure template (a template ID, not an alias) or set E2B_TEMPLATE')
    }
    if (!posix.isAbsolute(this.config.cwd)) {
      throw new Error(`dsh-e2b: cwd must be an absolute Linux path: ${this.config.cwd}`)
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs <= 0) {
      throw new Error('dsh-e2b: timeoutMs must be a positive finite number')
    }
  }

  private async open(): Promise<Sandbox> {
    const sandbox = await Sandbox.create(this.config.template, {
      apiKey: this.config.apiKey,
      apiUrl: this.config.apiUrl,
      domain: this.config.domain,
      timeoutMs: this.config.timeoutMs,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    try {
      await sandbox.files.makeDir(this.cwd)
      await sandbox.files.makeDir(this.runtimeRoot)
      const runtimeRoot = await sandbox.files.getInfo(this.runtimeRoot)
      if (runtimeRoot.type !== FileType.DIR || runtimeRoot.symlinkTarget !== undefined) {
        throw new Error(`dsh-e2b: runtime root must be a real directory: ${this.runtimeRoot}`)
      }
      await sandbox.commands.run(
        `chmod 700 -- ${quoteE2BShellArg(this.runtimeRoot)}`,
        { envs: e2bControlEnvs() },
      )
      return sandbox
    } catch (error: unknown) {
      try {
        await sandbox.kill()
      } catch (_sandboxSetupRollbackFailure) {
        // TODO(e2b-setup-rollback): Add retry state only if a real double failure
        // outlives E2B's configured sandbox timeout.
      }
      throw error
    }
  }
}

export default E2BRuntime
