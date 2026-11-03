#!/bin/bash
set -euo pipefail
cd /
exec 9>/run/lock/nav-content-publish.lock
flock -n 9 || exit 0
BUILDER=li@www.xzhtai.cn
BUILDDIR=/home/li/nav-growth-20261103
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR=/opt/nav-monitor/content-releases/$RUN_ID
mkdir -p "$RUN_DIR"
# Only public unauthenticated JSON goes into the builder's separate publication snapshot.
ssh -p 2077 -o BatchMode=yes -o ConnectTimeout=5 "$BUILDER" "set -e
cd $BUILDDIR
mkdir -p publications/$RUN_ID
node source/content/collect-public.mjs publications/$RUN_ID/snapshot.json
node source/ops/build.mjs publications/$RUN_ID/snapshot.json publications/$RUN_ID/dist
cp publications/$RUN_ID/manifest.json publications/$RUN_ID/manifest.accepted.json
tar -czf publications/$RUN_ID/site.tar.gz -C publications/$RUN_ID/dist .
sha256sum publications/$RUN_ID/site.tar.gz > publications/$RUN_ID/site.sha256"
rsync -a --partial --append-verify --timeout=30 -e 'ssh -p 2077 -o BatchMode=yes -o ConnectTimeout=5' "$BUILDER:$BUILDDIR/publications/$RUN_ID/site.tar.gz" "$BUILDER:$BUILDDIR/publications/$RUN_ID/manifest.accepted.json" "$BUILDER:$BUILDDIR/publications/$RUN_ID/site.sha256" "$RUN_DIR/"
read -r ARTIFACT_SHA _ < "$RUN_DIR/site.sha256"
python3 /home/claudeuser/nav-monitor/ops/deploy-static.py "$RUN_DIR/site.tar.gz" "$RUN_DIR/manifest.accepted.json" "$ARTIFACT_SHA" "$RUN_DIR"
