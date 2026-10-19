#!/bin/bash
# headless e2e（mock，不花额度）：拍照（命令行，停机）→ 改文件、再跑一轮 → 经 newsnap_dev 工具恢复 → 自动重启续一轮。
# 先决：DSH 0.2.1-rc.2 已装在 $DSH_DIR；mock 已在 18890 端口跑（MOCK_LOG=$E/mock.log node mock.mjs）；
#       newsnap 已 build 并 `dsh plugin --profile headless add file:<本仓库>` 装进 $E/home。
# 判定：target.txt 回到 v1、added.txt 消失、mock 收到带 [newsnap] 的续接请求，且其 messages 以快照前最后一次请求为前缀。
set -u
E=${E:?set E to a scratch dir}
DSH_DIR=${DSH_DIR:-/workspace/work/poc-e5b}
export DSH_HOME=$E/home DEEPSEEK_BASE_URL=http://127.0.0.1:18890 DEEPSEEK_API_KEY=sk-fake NEWSNAP_DSH_DIR=$DSH_DIR
DSH=$DSH_DIR/node_modules/.bin/dsh
CLI=$(cd "$(dirname "$0")/../../.." && pwd)/bin/newsnap.mjs
mkdir -p $E/ws && cd $E/ws && echo v1 > target.txt
timeout 400 $DSH --profile headless --json "hello one" > $E/r1.out 2> $E/r1.err || exit 1
SID=$(head -1 $E/r1.out | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).sessionId))')
mkdir -p .agent-teams/t1
echo "{\"name\":\"T1\",\"id\":\"t1\",\"captainSessionId\":\"$SID\",\"createdAt\":1,\"taskSeq\":0,\"members\":[],\"tasks\":[]}" > .agent-teams/t1/team.json
node $CLI snap --session $SID first || exit 1
SNAP=$(ls $DSH_HOME/newsnap/*/snaps/ | head -1)
echo v2 > target.txt; echo extra > added.txt
timeout 300 $DSH --profile headless --json --session-id $SID "turn two" > $E/r2.out 2> $E/r2.err || exit 1
NEWSNAP_DEV_TOOLS=1 timeout 300 $DSH --profile headless --json --session-id $SID "NSDEV: restore $SNAP confirm" > $E/r3.out 2> $E/r3.err
for i in $(seq 1 90); do grep -q "relaunched pid" $DSH_HOME/newsnap/*/helper.log 2>/dev/null && break; sleep 1; done
for i in $(seq 1 60); do grep -q '\[newsnap\]' $E/mock.log && break; sleep 2; done
sleep 5
cat $DSH_HOME/newsnap/*/helper.log
echo "target.txt=$(cat target.txt) added.txt=$([ -e added.txt ] && echo present || echo gone)"
node $CLI doctor
