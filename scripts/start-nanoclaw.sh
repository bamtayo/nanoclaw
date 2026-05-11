#!/bin/bash
sudo kill -9 $(pgrep -f "dist/index.js") 2>/dev/null
sudo fuser -k 4500/tcp 2>/dev/null
sleep 3
rm -f ~/nanoclaw/data/circuit-breaker.json
cd ~/nanoclaw
pnpm run start
