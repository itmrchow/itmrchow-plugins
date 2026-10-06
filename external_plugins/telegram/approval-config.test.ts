import { expect, test } from 'bun:test'
import {
  DEFAULT_APPROVAL_TIMEOUT_SECONDS,
  DEFAULT_COMMENT_TIMEOUT_SECONDS,
  isValidTimeoutSeconds,
  resolveApprovalConfig,
} from './approval-config'

test.each([undefined, '', '   ', '0', 'false', 'FALSE', 'no', 'off', 'yes', '2', 'enabled'])(
  '開關值 %p 視同未設，功能關閉',
  value => {
    expect(resolveApprovalConfig({ TELEGRAM_APPROVAL_BUTTONS: value }).enabled).toBe(false)
  },
)

test.each(['1', 'true', 'TRUE', ' true '])('開關值 %p 啟用功能', value => {
  expect(resolveApprovalConfig({ TELEGRAM_APPROVAL_BUTTONS: value }).enabled).toBe(true)
})

test('啟用且未指定逾時時用預設值', () => {
  expect(resolveApprovalConfig({ TELEGRAM_APPROVAL_BUTTONS: '1' })).toEqual({
    enabled: true,
    defaultTimeoutSeconds: DEFAULT_APPROVAL_TIMEOUT_SECONDS,
    defaultCommentTimeoutSeconds: DEFAULT_COMMENT_TIMEOUT_SECONDS,
  })
})

test('逾時可用環境變數調整，接受小數', () => {
  const config = resolveApprovalConfig({
    TELEGRAM_APPROVAL_BUTTONS: '1',
    TELEGRAM_APPROVAL_TIMEOUT_SECONDS: '1.5',
    TELEGRAM_APPROVAL_COMMENT_TIMEOUT_SECONDS: '0.2',
  })
  expect(config.defaultTimeoutSeconds).toBe(1.5)
  expect(config.defaultCommentTimeoutSeconds).toBe(0.2)
})

test.each(['abc', '0', '-5', '99999999'])('逾時值 %p 不合法時退回預設值', value => {
  const config = resolveApprovalConfig({
    TELEGRAM_APPROVAL_BUTTONS: '1',
    TELEGRAM_APPROVAL_TIMEOUT_SECONDS: value,
  })
  expect(config.defaultTimeoutSeconds).toBe(DEFAULT_APPROVAL_TIMEOUT_SECONDS)
})

test('逾時秒數只接受大於 0 且不超過上限的有限數字', () => {
  expect(isValidTimeoutSeconds(0.05)).toBe(true)
  expect(isValidTimeoutSeconds(0)).toBe(false)
  expect(isValidTimeoutSeconds(Number.NaN)).toBe(false)
  expect(isValidTimeoutSeconds('60')).toBe(false)
  expect(isValidTimeoutSeconds(604_801)).toBe(false)
})
