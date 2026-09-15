import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  interceptReauth,
  parseReauthCommand,
  replyForExit,
  runReauthBin,
  REAUTH_BIN_TIMEOUT_MS,
  REAUTH_EXIT_BUSY,
  REAUTH_EXIT_INVALID_CODE,
  REAUTH_EXIT_NO_PENDING,
  REAUTH_EXIT_NOT_ADMIN,
  REAUTH_EXIT_NOT_CONFIGURED,
  REAUTH_EXIT_NOT_DM,
  REAUTH_EXIT_OK,
  REAUTH_EXIT_UNAUTHORIZABLE,
  REAUTH_EXIT_USAGE,
  type ReauthDeps,
  type ReauthSource,
} from './reauth-command'

const DM: ReauthSource = { platform: 'telegram', senderId: '777', chatId: '777', chatType: 'dm', botUsername: 'jr_bot' }

function fakeDeps(exit: number | null, overrides: Partial<ReauthDeps> = {}) {
  const calls: { bin: string; args: readonly string[]; stdin?: string }[] = []
  const replies: string[] = []
  const logs: string[] = []
  let discarded = 0
  const deps: ReauthDeps = {
    bin: '/x/reauth.sh',
    run: async (bin, args, stdin) => {
      calls.push({ bin, args, stdin })
      return exit
    },
    reply: async text => {
      replies.push(text)
    },
    log: line => {
      logs.push(line)
    },
    discardCommandMessage: async () => {
      discarded += 1
    },
    ...overrides,
  }
  return { deps, calls, replies, logs, discarded: () => discarded }
}

function writeScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reauth-bin-'))
  const script = join(dir, 'fake.sh')
  writeFileSync(script, `#!/usr/bin/env bash\n${body.replaceAll('$DIR', dir)}\n`)
  chmodSync(script, 0o755)
  return script
}

describe('parseReauthCommand', () => {
  test('plain commands', () => {
    expect(parseReauthCommand('/reauth')).toEqual({ kind: 'reauth' })
    expect(parseReauthCommand('/reauth ')).toEqual({ kind: 'reauth' })
    expect(parseReauthCommand('  /authcode abc#def  ')).toEqual({ kind: 'authcode', code: 'abc#def' })
    expect(parseReauthCommand('/authcode    abc#def')).toEqual({ kind: 'authcode', code: 'abc#def' })
  })
  test('authcode without a code still intercepts (executor answers invalid)', () => {
    expect(parseReauthCommand('/authcode')).toEqual({ kind: 'authcode', code: '' })
    expect(parseReauthCommand('/authcode ')).toEqual({ kind: 'authcode', code: '' })
  })
  test('authcode with extra words keeps the whole rest, never routes it to the agent', () => {
    expect(parseReauthCommand('/authcode a b')).toEqual({ kind: 'authcode', code: 'a b' })
    expect(parseReauthCommand('/authcode a\nb')).toEqual({ kind: 'authcode', code: 'a\nb' })
  })
  test('@mention must be this bot', () => {
    expect(parseReauthCommand('/reauth@jr_bot', 'jr_bot')).toEqual({ kind: 'reauth' })
    expect(parseReauthCommand('/reauth@JR_BOT', 'jr_bot')).toEqual({ kind: 'reauth' })
    expect(parseReauthCommand('/reauth@other_bot', 'jr_bot')).toBeNull()
    expect(parseReauthCommand('/authcode@other_bot abc#def', 'jr_bot')).toBeNull()
    expect(parseReauthCommand('/reauth@jr_bot')).toBeNull()
  })
  test('not a command', () => {
    for (const text of ['/reauthx', 'reauth', '/re auth', 'please /reauth', '/REAUTH', '/reauth now', '/authcodex abc', '']) {
      expect(parseReauthCommand(text)).toBeNull()
    }
  })
})

describe('replyForExit', () => {
  test('silent verdicts', () => {
    for (const code of [REAUTH_EXIT_USAGE, REAUTH_EXIT_UNAUTHORIZABLE, REAUTH_EXIT_NOT_ADMIN, 99, null]) {
      expect(replyForExit('reauth', code)).toBeNull()
      expect(replyForExit('authcode', code)).toBeNull()
    }
  })
  test('spoken verdicts', () => {
    expect(replyForExit('reauth', REAUTH_EXIT_OK)).toBe('已開始重新驗證，授權連結稍後私訊給你。')
    expect(replyForExit('authcode', REAUTH_EXIT_OK)).toBe('已收到驗證碼，處理中，完成或失敗都會再通知你。')
    expect(replyForExit('reauth', REAUTH_EXIT_NOT_DM)).toBe('這個指令只能在私訊使用')
    expect(replyForExit('authcode', REAUTH_EXIT_NOT_DM)).toBe('這個指令只能在私訊使用')
    expect(replyForExit('reauth', REAUTH_EXIT_NOT_CONFIGURED)).toBe('重新驗證功能未完整設定，請到 VM 查看 poller 的 journal。')
    expect(replyForExit('reauth', REAUTH_EXIT_BUSY)).toBe('已有進行中的重新驗證流程，請等它結束後再試。')
    expect(replyForExit('authcode', REAUTH_EXIT_BUSY)).toBe('驗證碼已收過，流程處理中，請等候結果通知。')
    expect(replyForExit('authcode', REAUTH_EXIT_NO_PENDING)).toBe('目前沒有等待驗證碼的流程（可能已逾時），需要時請重新 /reauth。')
    expect(replyForExit('authcode', REAUTH_EXIT_INVALID_CODE)).toBe('驗證碼格式不正確，請貼上授權頁顯示的完整驗證碼：/authcode <驗證碼>')
  })
  test('no reply ever repeats a code or a url', () => {
    for (const kind of ['reauth', 'authcode'] as const) {
      for (let code = 0; code < 20; code++) {
        expect(replyForExit(kind, code) ?? '').not.toMatch(/https?:|#/)
      }
    }
  })
})

describe('interceptReauth', () => {
  test('REAUTH_BIN unset -> not intercepted, executor never runs', async () => {
    const f = fakeDeps(REAUTH_EXIT_OK, { bin: undefined })
    expect(await interceptReauth('/reauth', DM, f.deps)).toBe(false)
    expect(await interceptReauth('/authcode abc#def', DM, f.deps)).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
  test('ordinary text and other slash commands -> not intercepted', async () => {
    const f = fakeDeps(REAUTH_EXIT_OK)
    expect(await interceptReauth('hello', DM, f.deps)).toBe(false)
    expect(await interceptReauth('/restart', DM, f.deps)).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
  test('/reauth -> start with identity args, no stdin', async () => {
    const f = fakeDeps(REAUTH_EXIT_OK)
    expect(await interceptReauth('/reauth', DM, f.deps)).toBe(true)
    expect(f.calls[0]).toEqual({
      bin: '/x/reauth.sh',
      args: ['start', '--platform', 'telegram', '--sender', '777', '--chat', '777', '--chat-type', 'dm'],
      stdin: undefined,
    })
    expect(f.replies).toEqual(['已開始重新驗證，授權連結稍後私訊給你。'])
    expect(f.discarded()).toBe(0)
  })
  test('group chat type is passed through for the executor to refuse', async () => {
    const f = fakeDeps(REAUTH_EXIT_NOT_DM)
    await interceptReauth('/reauth', { ...DM, chatId: '-100123', chatType: 'group' }, f.deps)
    expect(f.calls[0].args).toEqual(['start', '--platform', 'telegram', '--sender', '777', '--chat', '-100123', '--chat-type', 'group'])
    expect(f.replies).toEqual(['這個指令只能在私訊使用'])
  })
  test('/authcode -> code via stdin, never argv; message discarded before replying', async () => {
    const order: string[] = []
    const f = fakeDeps(REAUTH_EXIT_OK, {
      discardCommandMessage: async () => {
        order.push('discard')
      },
      reply: async () => {
        order.push('reply')
      },
    })
    await interceptReauth('/authcode abc#def', DM, f.deps)
    expect(f.calls[0].args).toEqual(['code', '--platform', 'telegram', '--sender', '777', '--chat', '777', '--chat-type', 'dm'])
    expect(f.calls[0].args.join(' ')).not.toContain('abc#def')
    expect(f.calls[0].stdin).toBe('abc#def\n')
    expect(order).toEqual(['discard', 'reply'])
  })
  test('non-admin -> intercepted but silent, nothing discarded', async () => {
    for (const exit of [REAUTH_EXIT_NOT_ADMIN, REAUTH_EXIT_UNAUTHORIZABLE, REAUTH_EXIT_USAGE]) {
      const f = fakeDeps(exit)
      expect(await interceptReauth('/authcode abc#def', DM, f.deps)).toBe(true)
      expect(f.replies).toHaveLength(0)
      expect(f.discarded()).toBe(0)
    }
  })
  test('executor failure (null) -> intercepted, silent, logged', async () => {
    const f = fakeDeps(null)
    expect(await interceptReauth('/reauth', DM, f.deps)).toBe(true)
    expect(f.replies).toHaveLength(0)
    expect(f.logs.join('\n')).toContain('exit=none')
  })
  test('run / reply / discard throwing never escapes', async () => {
    const boom = async () => {
      throw new Error('boom')
    }
    expect(await interceptReauth('/reauth', DM, fakeDeps(REAUTH_EXIT_OK, { reply: boom }).deps)).toBe(true)
    expect(await interceptReauth('/reauth', DM, fakeDeps(REAUTH_EXIT_OK, { run: boom }).deps)).toBe(true)
    expect(await interceptReauth('/authcode a#b', DM, fakeDeps(REAUTH_EXIT_OK, { discardCommandMessage: boom }).deps)).toBe(true)
  })
  test('log lines never carry the code', async () => {
    for (const exit of [REAUTH_EXIT_OK, REAUTH_EXIT_INVALID_CODE, null]) {
      const f = fakeDeps(exit)
      await interceptReauth('/authcode secret#value', DM, f.deps)
      expect(f.logs.join('\n')).not.toContain('secret')
    }
    const f = fakeDeps(REAUTH_EXIT_OK, {
      run: async () => {
        throw new Error('spawn failed')
      },
    })
    await interceptReauth('/authcode secret#value', DM, f.deps)
    expect(f.logs.join('\n')).not.toContain('secret')
  })
})

describe('runReauthBin', () => {
  test('returns exit code and feeds stdin', async () => {
    const script = writeScript('cat > "$DIR/stdin.txt"\necho "$@" > "$DIR/argv.txt"\nexit 13')
    const dir = join(script, '..')
    expect(await runReauthBin(script, ['code', '--sender', '1'], 'abc#def\n')).toBe(13)
    expect(readFileSync(join(dir, 'stdin.txt'), 'utf8')).toBe('abc#def\n')
    expect(readFileSync(join(dir, 'argv.txt'), 'utf8')).toBe('code --sender 1\n')
  })
  test('missing binary -> null', async () => {
    expect(await runReauthBin('/nonexistent/reauth.sh', ['start'])).toBeNull()
  })
  test('an executor that exits without reading a huge stdin does not crash the poller', async () => {
    const script = writeScript('exit 14')
    expect(await runReauthBin(script, ['code'], 'a'.repeat(1024 * 1024))).toBe(14)
  })
  test(
    'a hung executor is killed and reported as no verdict',
    async () => {
      const script = writeScript('sleep 60')
      const started = Date.now()
      expect(await runReauthBin(script, ['start'])).toBeNull()
      expect(Date.now() - started).toBeLessThan(REAUTH_BIN_TIMEOUT_MS + 5_000)
    },
    REAUTH_BIN_TIMEOUT_MS + 10_000,
  )
})
