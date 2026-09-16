# external_plugins/im-core/scripts/lib/reauth-contract.sh
# shellcheck shell=bash
# shellcheck disable=SC2034  # 常數檔，給 reauth.sh 與測試 source
# 重新驗證執行器（scripts/reauth.sh）與 channel poller（reauth-command.ts）之間的契約。
#
# poller 依 exit code 決定「回一句話」或「沉默」。沉默的那幾個值代表「還不知道對方是不是
# 管理員」—— 回話等於告訴陌生人這個指令存在。改任一值 = 改契約，tests/parity.test.sh 會擋。

REAUTH_EXIT_OK=0
# 參數不合法。poller 沉默。
REAUTH_EXIT_USAGE=2
# 已確認是管理員，但執行器設定不完整。poller 告訴管理員去看 journal。
REAUTH_EXIT_NOT_CONFIGURED=3
# 無法判定是否為管理員（AGENT_SCOPES_DIR 缺、lib 載不起來）。poller 沉默。
REAUTH_EXIT_UNAUTHORIZABLE=4
REAUTH_EXIT_NOT_ADMIN=10
REAUTH_EXIT_NOT_DM=11
# start：已有進行中流程；code：流程已不在等驗證碼。
REAUTH_EXIT_BUSY=12
# code：沒有屬於這位管理員、仍在期限內的流程。
REAUTH_EXIT_NO_PENDING=13
REAUTH_EXIT_INVALID_CODE=14

# 產生日記錄檔名。carrier 的 watchdog（token-expiry.sh 的 TOKEN_ISSUED_FILE_NAME）讀同一個檔，
# 兩處字面值必須相同。
REAUTH_ISSUED_FILE_NAME="token-issued.json"
# setup-token 印的是「valid for 1 year」；以 365 天計。
REAUTH_TOKEN_VALID_DAYS=365
