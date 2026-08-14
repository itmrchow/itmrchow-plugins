# external_plugins/im-core/scripts/lib/spawn-contract.sh
# shellcheck shell=bash
# shellcheck disable=SC2034  # 本檔全是給宿主與測試 source 的常數，檔內不自用
# scope-spawn 的 exit code 契約 —— 宿主的 spawn 腳本與 channel plugin 的 poller
# 之間唯一的介面。
#
# 為什麼值住在這裡而不是宿主：poller.ts / discord-poller.ts 各有一份同樣的
# 常數（SPAWN_EXIT_*），宿主的 scope-spawn.sh 以前用裸數字。三份字面值分在
# 兩個 repo，沒有任何測試比得到。搬進 plugin 之後 shell 這份與 TS 那兩份同
# repo，tests/parity.test.sh 逐一比對。
#
# 改任一個值 = 改契約：三邊要一起改，parity test 會擋住只改一邊的情況。

# 已開好，或本來就活著（idempotent）。
SPAWN_EXIT_OK=0
# tmux 拒絕，或 spawn lock 拿不到。呼叫端當成暫時性失敗，回覆「暫時無法服務」。
SPAWN_EXIT_TRANSIENT=1
# MAX_SCOPES 已滿。呼叫端告訴使用者這台機器滿了。
SPAWN_EXIT_CAP_REACHED=2
# scope-id 不合法。呼叫端記 log 並丟棄該訊息。
SPAWN_EXIT_INVALID_SCOPE=3
