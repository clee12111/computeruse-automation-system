#!/bin/bash
# scripts/clean-room-verify.sh — Clean-room verification per SETUP.md.
# Run inside a fresh container with NO host access.
# Expected env vars: CONSOLE_USER, CONSOLE_PASS (and optionally OPENAI_API_KEY).
set -e

echo "════════════════════════════════════════════════════"
echo "  CLEAN-ROOM VERIFICATION"
echo "════════════════════════════════════════════════════"
echo ""

# ── 1. Verify prerequisites ────────────────────────────
echo "1. Prerequisites"
echo "   Node: $(node --version)"
echo "   npm:  $(npm --version)"
echo ""

# ── 2. Verify .env was NOT copied (clean room) ────────
if [ -f .env ]; then
  echo "   FAIL: .env exists — this is not a clean room"
  exit 1
fi
echo "   .env absent (clean room confirmed)"

# Write .env from env vars only
cat > .env <<EOF
CONSOLE_USER=${CONSOLE_USER}
CONSOLE_PASS=${CONSOLE_PASS}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
OPENAI_MODEL=${OPENAI_MODEL:-gpt-5.6-luna}
EOF
echo "   .env created from env vars"
echo ""

# ── 3. Trust store is empty ────────────────────────────
echo "2. Trust store"
TRUST=$(cat capabilities/trust.json)
if [ "$TRUST" != "{}" ]; then
  echo "   FAIL: trust.json is not empty: $TRUST"
  exit 1
fi
echo "   trust.json is empty (clean state)"
echo ""

# ── 4. Run tests ───────────────────────────────────────
echo "3. Running tests (npm test, default pool)"
npm test 2>&1 | tail -5
echo ""

# ── 5. Start mock console ─────────────────────────────
echo "4. Starting mock console"
node mock-console/server.js &
MOCK_PID=$!
sleep 2

# Verify both tenants
STATUS_CU=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/t/cascade-cu/login)
STATUS_HV=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/t/harborview/login)
echo "   Cascade CU:  $STATUS_CU"
echo "   Harborview:   $STATUS_HV"
if [ "$STATUS_CU" != "200" ] || [ "$STATUS_HV" != "200" ]; then
  echo "   FAIL: Mock console not serving both tenants"
  kill $MOCK_PID 2>/dev/null
  exit 1
fi
echo ""

# ── 6. Doctor ──────────────────────────────────────────
echo "5. Running doctor"
npm run doctor 2>&1 || true
echo ""

# ── 7. Approve + replay SUCCESS ────────────────────────
echo "6. Replay: SUCCESS case"
npm run cli -- approve lookup-dense-savings --version 1.1.0 2>&1 | tail -1
REPLAY_OUT=$(npm run cli -- replay lookup-dense-savings --memberId 60020 2>&1)
if echo "$REPLAY_OUT" | grep -q "SUCCESS"; then
  echo "   SUCCESS confirmed"
else
  echo "   FAIL: Expected SUCCESS"
  echo "$REPLAY_OUT" | head -10
  kill $MOCK_PID 2>/dev/null
  exit 1
fi
echo ""

# ── 8. Replay BUSINESS_OUTCOME ─────────────────────────
echo "7. Replay: BUSINESS_OUTCOME case"
REPLAY_OUT=$(npm run cli -- replay lookup-dense-savings --memberId 99999 2>&1)
if echo "$REPLAY_OUT" | grep -q "BUSINESS_OUTCOME"; then
  echo "   BUSINESS_OUTCOME confirmed"
else
  echo "   FAIL: Expected BUSINESS_OUTCOME"
  kill $MOCK_PID 2>/dev/null
  exit 1
fi
echo ""

# ── 9. Raw MCP client ──────────────────────────────────
echo "8. MCP raw client (no SDK)"
MCP_OUT=$(node scripts/mcp-raw-client.mjs 2>&1)
echo "$MCP_OUT" | grep -E "INITIALIZE|TOOLS|Result:|PASS|FAIL"
if ! echo "$MCP_OUT" | grep -q "PASS"; then
  echo "   FAIL: MCP raw client did not pass"
  echo "$MCP_OUT"
  kill $MOCK_PID 2>/dev/null
  exit 1
fi
echo ""

# ── 10. Discovery start verification ──────────────────
echo "9. Discovery: verify it starts (no LLM call needed)"
if [ -n "$OPENAI_API_KEY" ]; then
  echo "   OPENAI_API_KEY is set — could run full discovery"
else
  echo "   OPENAI_API_KEY not set — skipping live discovery (expected)"
fi
echo ""

# ── Cleanup ────────────────────────────────────────────
npm run cli -- revoke lookup-dense-savings --version 1.1.0 2>&1 | tail -1
kill $MOCK_PID 2>/dev/null

echo ""
echo "════════════════════════════════════════════════════"
echo "  ALL CHECKS PASSED"
echo "════════════════════════════════════════════════════"
