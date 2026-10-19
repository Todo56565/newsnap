#!/bin/bash
export DSH_HOME=${E:-/workspace/work/ns-web}/home DEEPSEEK_BASE_URL=http://127.0.0.1:18891 DEEPSEEK_API_KEY=sk-fake NEWSNAP_DSH_DIR=/workspace/work/poc-e5b
cd ${E:-/workspace/work/ns-web}/ws
nohup /workspace/work/poc-e5b/node_modules/.bin/dsh --profile web --port 8791 > ../web.out 2> ../web.err &
echo $! > ../web.pid
