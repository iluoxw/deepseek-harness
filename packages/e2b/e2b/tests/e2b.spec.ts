import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Sandbox as SandboxType } from 'e2b'
import E2BRuntime, {
  e2bControlEnvs,
  FileType,
  SandboxNotFoundError,
  quoteE2BShellArg,
  remapHostCwdToSandbox,
  remapHostPathToSandbox,
} from '@deepseek-ai/dsh-e2b'
import * as E2BInvariant from '../src/invariant.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
}))

vi.mock('e2b', async (importOriginal) => {
  const actual = await importOriginal<typeof import('e2b')>()
  // The mock replaces only the SDK's static factory surface and is never constructed.
  // oxlint-disable-next-line typescript/no-extraneous-class -- The SDK contract is a class with a static factory.
  class FakeSandbox {
    static create(...args: unknown[]): unknown {
      return sdk.create(...args)
    }
  }
  return { ...actual, Sandbox: FakeSandbox }
})

interface SandboxFixture {
  sandbox: SandboxType
  makeDir: ReturnType<typeof vi.fn>
  getInfo: ReturnType<typeof vi.fn>
  run: Mock<RunCommand>
  kill: ReturnType<typeof vi.fn>
  setTimeout: ReturnType<typeof vi.fn>
}

type RunCommand = (
  command: string,
  options?: { envs?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

function fakeSandbox(id = 'sandbox-1'): SandboxFixture {
  const makeDir = vi.fn().mockResolvedValue(true)
  const getInfo = vi.fn().mockResolvedValue({ type: FileType.DIR })
  const run = vi.fn<RunCommand>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  const kill = vi.fn().mockResolvedValue(undefined)
  const setTimeout = vi.fn().mockResolvedValue(undefined)
  const sandbox = {
    sandboxId: id,
    files: { makeDir, getInfo },
    commands: { run },
    kill,
    setTimeout,
  } as unknown as SandboxType
  return { sandbox, makeDir, getInfo, run, kill, setTimeout }
}

/** Minimal valid self-hosted connection block shared by the lifecycle tests. */
const SELFHOST = {
  apiKey: 'test-key',
  apiUrl: 'https://api.example.internal',
  domain: 'example.internal',
  template: 'tmpl-1234567890',
}

beforeEach(() => {
  sdk.create.mockReset()
  vi.unstubAllEnvs()
})

describe('E2BRuntime', () => {
  it('gives each SDK login shell a fresh non-overridable control home', () => {
    const first = e2bControlEnvs({ HOME: '/hostile', NPM_TOKEN: '' })
    const second = e2bControlEnvs()

    expect(first.HOME).toMatch(/^\/\.dsh-e2b-control-/)
    expect(first).toEqual({ HOME: first.HOME, NPM_TOKEN: '' })
    expect(first.HOME).not.toBe(second.HOME)
  })

  it('creates one protected shared sandbox and kills it on default disposal', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })

    const service = ctx.e2b
    await expect(service.getSandbox()).resolves.toBe(fixture.sandbox)
    expect(service.cwd).toBe('/home/user/workspace')
    expect(service.runtimeRoot).toBe('/home/user/workspace/.dsh-e2b')
    expect(sdk.create).toHaveBeenCalledWith(SELFHOST.template, {
      apiKey: SELFHOST.apiKey,
      apiUrl: SELFHOST.apiUrl,
      domain: SELFHOST.domain,
      timeoutMs: 300_000,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    expect(fixture.makeDir).toHaveBeenNthCalledWith(1, '/home/user/workspace')
    expect(fixture.makeDir).toHaveBeenNthCalledWith(2, '/home/user/workspace/.dsh-e2b')
    expect(fixture.getInfo).toHaveBeenCalledWith('/home/user/workspace/.dsh-e2b')
    const runOptions = fixture.run.mock.calls[0]?.[1]
    expect(runOptions?.envs?.HOME).toMatch(/^\/\.dsh-e2b-control-/)
    expect(fixture.run).toHaveBeenCalledWith(
      "chmod 700 -- '/home/user/workspace/.dsh-e2b'",
      { envs: { HOME: runOptions?.envs?.HOME } },
    )

    expect(fixture.setTimeout).toHaveBeenCalledWith(300_000)
    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    await expect(service.getSandbox()).rejects.toThrow(/disposing/)
  })

  it('resets the sandbox TTL on every successful getSandbox', async () => {
    const fixture = fakeSandbox()
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST, timeoutMs: 1_800_000 })
    const service = ctx.e2b

    await expect(service.getSandbox()).resolves.toBe(fixture.sandbox)
    await expect(service.getSandbox()).resolves.toBe(fixture.sandbox)
    expect(fixture.setTimeout).toHaveBeenNthCalledWith(1, 1_800_000)
    expect(fixture.setTimeout).toHaveBeenNthCalledWith(2, 1_800_000)
    expect(fixture.setTimeout).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    await expect(service.getSandbox()).rejects.toThrow(/disposing/)
    expect(fixture.setTimeout).toHaveBeenCalledTimes(2)
  })

  it('rejects handle acquisition when disposal starts during setup', async () => {
    const fixture = fakeSandbox()
    const opening = Promise.withResolvers<SandboxType>()
    sdk.create.mockReturnValue(opening.promise)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })

    const acquisition = ctx.e2b.getSandbox()
    const disposing = fiber.dispose()
    opening.resolve(fixture.sandbox)

    await expect(acquisition).rejects.toThrow(/disposing/)
    await expect(disposing).resolves.toBeUndefined()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('reads the whole connection block from the environment and honors the configured cwd and lifetime', async () => {
    vi.stubEnv('E2B_API_KEY', 'environment-key')
    vi.stubEnv('E2B_API_URL', 'https://api.env.example')
    vi.stubEnv('E2B_DOMAIN', 'env.example')
    vi.stubEnv('E2B_TEMPLATE', 'env-template-id')
    const fixture = fakeSandbox('configured-sandbox')
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, {
      cwd: '/workspace/project',
      timeoutMs: 60_000,
    })
    await ctx.e2b.getSandbox()

    expect(sdk.create).toHaveBeenCalledWith('env-template-id', {
      apiKey: 'environment-key',
      apiUrl: 'https://api.env.example',
      domain: 'env.example',
      timeoutMs: 60_000,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    expect(ctx.e2b.cwd).toBe('/workspace/project')
    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it('accepts a missing sandbox when disposal itself requests deletion', async () => {
    const fixture = fakeSandbox()
    fixture.kill.mockRejectedValue(new SandboxNotFoundError('already deleted'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })
    await ctx.e2b.getSandbox()

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(errors).toEqual([])
  })

  it('does not classify other disposal failures as an already-gone sandbox', async () => {
    const fixture = fakeSandbox()
    const failure = new Error('disposition unknown')
    fixture.kill.mockRejectedValue(failure)
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })
    await ctx.e2b.getSandbox()
    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(fixture.kill).toHaveBeenCalledOnce()
    expect(errors).toContain(failure)
  })

  it('kills a newly created sandbox when remote directory setup fails', async () => {
    const fixture = fakeSandbox()
    fixture.makeDir.mockRejectedValueOnce(new Error('setup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('setup failed')
    expect(fixture.kill).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('preserves the setup failure after its one rollback attempt fails', async () => {
    const fixture = fakeSandbox()
    fixture.run.mockRejectedValueOnce(new Error('chmod failed'))
    fixture.kill.mockRejectedValueOnce(new Error('cleanup failed'))
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    const fiber = await ctx.plugin(E2BRuntime, { ...SELFHOST })
    await expect(ctx.e2b.getSandbox()).rejects.toThrow('chmod failed')
    expect(fixture.kill).toHaveBeenCalledOnce()

    await fiber.dispose()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it.each([
    ['symbolic link', { type: FileType.DIR, symlinkTarget: '/tmp/redirected' }],
    ['regular file', { type: FileType.FILE }],
  ])('rejects a reserved runtime root that is a %s', async (_label, info) => {
    const fixture = fakeSandbox()
    fixture.getInfo.mockResolvedValueOnce(info)
    sdk.create.mockResolvedValue(fixture.sandbox)
    const ctx = new Context()
    await ctx.plugin(E2BRuntime, { ...SELFHOST })

    await expect(ctx.e2b.getSandbox()).rejects.toThrow('runtime root must be a real directory')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(fixture.kill).toHaveBeenCalledOnce()
  })

  it.each([
    ['apiKey', { ...SELFHOST, apiKey: '' }, /configure apiKey/],
    ['apiUrl', { ...SELFHOST, apiUrl: '' }, /E2B_API_URL/],
    ['domain', { ...SELFHOST, domain: '' }, /E2B_DOMAIN/],
    ['template', { ...SELFHOST, template: '' }, /E2B_TEMPLATE/],
    ['cwd', { ...SELFHOST, cwd: 'relative' }, /absolute Linux path/],
    ['timeoutMs', { ...SELFHOST, timeoutMs: 0 }, /positive finite/],
  ] as const)('fails self-contained configuration before opening E2B when %s is missing: %j', async (_label, config, message) => {
    vi.stubEnv('E2B_API_KEY', '')
    vi.stubEnv('E2B_API_URL', '')
    vi.stubEnv('E2B_DOMAIN', '')
    vi.stubEnv('E2B_TEMPLATE', '')
    const ctx = new Context()
    await expect(ctx.plugin(E2BRuntime, config)).rejects.toThrow(message)
    expect(sdk.create).not.toHaveBeenCalled()
  })

  it('requires a key when both config and the environment omit it', async () => {
    const original = process.env.E2B_API_KEY
    delete process.env.E2B_API_KEY
    try {
      const ctx = new Context()
      await expect(ctx.plugin(E2BRuntime, {})).rejects.toThrow(/configure apiKey/)
    } finally {
      if (original === undefined) delete process.env.E2B_API_KEY
      else process.env.E2B_API_KEY = original
    }
  })
})

describe('E2B helpers and invariant companion', () => {
  it('quotes opaque shell arguments without interpolation', () => {
    expect(quoteE2BShellArg("a'b $HOME")).toBe("'a'\"'\"'b $HOME'")
  })

  it('rewrites host-absolute GUI cwd paths onto the sandbox cwd', () => {
    const sandbox = '/home/user/workspace'
    const host = '/Users/me/Documents/DSH-WorkSpace'
    expect(remapHostCwdToSandbox(sandbox, host)).toBe(sandbox)
    expect(remapHostPathToSandbox(sandbox, 'README.md')).toBe('/home/user/workspace/README.md')
    expect(remapHostPathToSandbox(sandbox, 'src/a.ts', host)).toBe('/home/user/workspace/src/a.ts')
    expect(remapHostPathToSandbox(sandbox, `${host}/src/a.ts`, host)).toBe('/home/user/workspace/src/a.ts')
    expect(remapHostPathToSandbox(sandbox, host, host)).toBe(sandbox)
    expect(remapHostPathToSandbox(sandbox, `${host}/README.md`)).toBe('/home/user/workspace/README.md')
    expect(remapHostPathToSandbox(sandbox, 'C:\\Users\\me\\proj\\a.ts')).toBe('/home/user/workspace/a.ts')
    expect(remapHostPathToSandbox(sandbox, '/home/user/workspace/src/a.ts')).toBe('/home/user/workspace/src/a.ts')
    expect(remapHostPathToSandbox(sandbox, 'a.ts', sandbox)).toBe('/home/user/workspace/a.ts')
    expect(remapHostPathToSandbox(sandbox, '/tmp/scratch.txt')).toBe('/tmp/scratch.txt')
  })

  it('registers the package-owned empty invariant installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(E2BInvariant).await()
    await fiber.dispose()
  })
})
