import { expect, test } from 'bun:test'
import { maskSecrets } from './secret-mask'

// Expected values are what tg-notify.sh's SECRET_MASK_JQ_DEF (jq) produced for
// the same inputs, so the two masks are pinned to the same output.
const CASES: readonly (readonly [string, string])[] = [
  ["curl -H 'Authorization: Bearer sk-SECRET1234567' https://u:pw123@x.io/a?token=abc123&x=1 --data password=hunter2 ghp_ABCDEFGH12345678 glpat-XYZXYZXYZ123", "curl -H 'Authorization: Bearer ***' https://***@x.io/a?token=***&x=1 --data password=*** *** ***"],
  ["curl -d '{\"password\":\"jsonpw1\",\"api_key\": \"jsonkey2\"}' && export TOKEN = spacedtok3 && password = spacedpw4", "curl -d '{\"password\":\"***\",\"api_key\": \"***\"}' && export TOKEN = *** && password = ***"],
  ["cat /tmp/task-management-report desk-pattern-12345", "cat /tmp/task-management-report desk-pattern-12345"],
  ["mysql --password knowngap5", "mysql --password knowngap5"],
  ["curl -H \"Authorization: Bearer sk-SUBSECRET999\" x.io", "curl -H \"Authorization: Bearer ***\" x.io"],
  ["已設定 token=ghp_abcdefghijk123，header 用 Authorization: Bearer xyzSECRET9。\n連線 https://u:pw123@x.io 要保留嗎？", "已設定 token=*** 用 Authorization: Bearer ***\n連線 https://***@x.io 要保留嗎？"],
  ["AUTHORIZATION: basic dXNlcjpwYXNz && Access-Key: AKIA1234 SECRET=abc PWD='x y'", "AUTHORIZATION: basic *** && Access-Key: *** SECRET=*** PWD='*** y'"],
  ["xoxb-123456789 sk-short xoxp-abcdefgh_ijk", "*** sk-short ***"],
]

test.each(CASES)('遮罩結果與 tg-notify 的 jq 版相同：%s', (input: string, expected: string) => {
  expect(maskSecrets(input)).toBe(expected)
})

test('沒有機密樣式的文字原樣保留', () => {
  expect(maskSecrets('ls -la /tmp && echo done')).toBe('ls -la /tmp && echo done')
})
