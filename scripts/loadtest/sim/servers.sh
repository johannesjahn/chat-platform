#!/usr/bin/env bash
# Starts N backend instances (ports 3100..3100+N-1) against a shared
# Postgres + Redis — the Helm chart's topology with N replicas — for the
# simulator. Prints their PIDs (for simulate.ts --server-pids) and the
# --targets list. Stop them with: kill $(cat /tmp/sim-servers.pids)
#
#   DATABASE_URL=... REDIS_URL=... JWT_SECRET=... scripts/loadtest/sim/servers.sh 2
set -euo pipefail
N="${1:-1}"
: "${DATABASE_URL:?}" "${REDIS_URL:?}" "${JWT_SECRET:?}"
cd "$(dirname "$0")/../../.."
: > /tmp/sim-servers.pids
targets=()
for ((i = 0; i < N; i++)); do
  port=$((3100 + i))
  # TRUST_PROXY=loopback: the simulator stands in for an ingress, giving
  # every simulated user its own X-Forwarded-For address.
  PORT=$port TRUST_PROXY=loopback bun src/main.ts > "/tmp/sim-server-$port.log" 2>&1 &
  echo $! >> /tmp/sim-servers.pids
  targets+=("http://127.0.0.1:$port")
done
for t in "${targets[@]}"; do
  until curl -sf "$t/health" > /dev/null; do sleep 0.3; done
done
echo "pids:    $(paste -sd, /tmp/sim-servers.pids)"
echo "targets: $(IFS=,; echo "${targets[*]}")"
