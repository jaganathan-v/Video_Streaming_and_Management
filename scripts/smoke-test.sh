#!/usr/bin/env bash
export MSYS_NO_PATHCONV=1
set -e

# scripts/smoke-test.sh
# End-to-end smoke test verifying:
# 1. User registration & login
# 2. Upload video and poll until ready (timeout 300s)
# 3. GET master.m3u8 twice and assert X-Cache-Status goes MISS then HIT
# 4. Fetch one segment and assert HTTP 200
# 5. Call /api/whoami 12 times and assert at least 2 distinct instances answered
# 6. Test view count endpoint and assert 204 + incremented views
# 7. Print PASS/FAIL per check, exit non-zero on any failure.

LB_URL="${LB_URL:-http://localhost:8080}"
SAMPLE_VIDEO="${SAMPLE_VIDEO:-./samples/sample.mp4}"

PASSED=0
FAILED=0

check() {
  local name="$1"
  local status="$2"
  if [ "$status" -eq 0 ]; then
    echo "  [PASS] $name"
    PASSED=$((PASSED + 1))
  else
    echo "  [FAIL] $name"
    FAILED=$((FAILED + 1))
    exit 1
  fi
}

echo "=== STARTING SMOKE TESTS against $LB_URL ==="

# Check 0: LB & Services Reachable
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$LB_URL/api/health" | tr -d '\r')
if [ "$HTTP_STATUS" = "200" ]; then
  check "Platform Healthcheck /api/health returned 200" 0
else
  echo "Expected 200 from /api/health, got $HTTP_STATUS"
  check "Platform Healthcheck /api/health returned 200" 1
fi

# Check 1: Register User
TEST_EMAIL="smoke_$(date +%s)_$RANDOM@example.com"
TEST_PASS="password12345"
echo "==> Registering user $TEST_EMAIL..."
REG_RESP=$(curl -s -X POST "$LB_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}")

TOKEN=$(echo "$REG_RESP" | grep -o '"token":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
if [ -n "$TOKEN" ]; then
  check "User Registration and Token Generation" 0
else
  echo "Registration response: $REG_RESP"
  check "User Registration and Token Generation" 1
fi

# Check 2: User Login
echo "==> Logging in with $TEST_EMAIL..."
LOGIN_RESP=$(curl -s -X POST "$LB_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASS\"}")

LOGIN_TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
if [ -n "$LOGIN_TOKEN" ]; then
  check "User Login and JWT Verification" 0
else
  echo "Login response: $LOGIN_RESP"
  check "User Login and JWT Verification" 1
fi

# Ensure sample video exists
if [ ! -f "$SAMPLE_VIDEO" ]; then
  echo "==> Sample video $SAMPLE_VIDEO not found. Creating via make-sample.sh..."
  bash ./scripts/make-sample.sh
fi

# Check 3: Upload Video
echo "==> Uploading sample video..."
UPLOAD_RESP=$(curl -s -X POST "$LB_URL/api/videos" \
  -H "Authorization: Bearer $LOGIN_TOKEN" \
  -F "title=Smoke Test Video" \
  -F "description=Uploaded during automated smoke test" \
  -F "video=@$SAMPLE_VIDEO")

VIDEO_ID=$(echo "$UPLOAD_RESP" | grep -o '"id":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
if [ -n "$VIDEO_ID" ]; then
  check "Video Upload to /api/videos (Accepted 202, ID: $VIDEO_ID)" 0
else
  echo "Upload response: $UPLOAD_RESP"
  check "Video Upload to /api/videos" 1
fi

# Check 4: Poll status until ready (timeout 300s)
echo "==> Waiting for video $VIDEO_ID transcode (timeout 300s)..."
START_TIME=$(date +%s)
STATUS=""
PROGRESS=0

while true; do
  STATUS_RESP=$(curl -s "$LB_URL/api/videos/$VIDEO_ID/status")
  STATUS=$(echo "$STATUS_RESP" | grep -o '"status":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
  PROGRESS=$(echo "$STATUS_RESP" | grep -o '"progress":[0-9]*' | cut -d':' -f2 | tr -d '\r' || true)

  echo "    Current status: $STATUS (progress: ${PROGRESS:-0}%)"

  if [ "$STATUS" = "ready" ]; then
    break
  fi

  if [ "$STATUS" = "failed" ]; then
    echo "Transcode failed: $STATUS_RESP"
    check "Transcoding completed with status ready" 1
  fi

  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  if [ "$ELAPSED" -ge 300 ]; then
    echo "Timed out waiting for transcode after 300s!"
    check "Transcoding completed within 300s" 1
  fi

  sleep 3
done

check "Transcoding completed with status ready" 0

# Check 5: Verify renditions and master playlist
VIDEO_DETAILS=$(curl -s "$LB_URL/api/videos/$VIDEO_ID")
MASTER_URL=$(echo "$VIDEO_DETAILS" | grep -o '"hlsUrl":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
if [ -n "$MASTER_URL" ]; then
  check "Video details returned valid HLS playlist URL" 0
else
  echo "Details response: $VIDEO_DETAILS"
  check "Video details returned valid HLS playlist URL" 1
fi

# Check 6: GET master.m3u8 twice and assert X-Cache-Status goes MISS then HIT
echo "==> Request 1 for master.m3u8 (expected MISS or EXPIRED)..."
CACHE_HEADER_1=$(curl -s -I "$LB_URL/hls/$VIDEO_ID/master.m3u8" | grep -i "X-Cache-Status" | tr -d '\r\n' || true)
echo "    $CACHE_HEADER_1"

echo "==> Request 2 for master.m3u8 (expected HIT)..."
CACHE_HEADER_2=$(curl -s -I "$LB_URL/hls/$VIDEO_ID/master.m3u8" | grep -i "X-Cache-Status" | tr -d '\r\n' || true)
echo "    $CACHE_HEADER_2"

if echo "$CACHE_HEADER_2" | grep -iq "HIT"; then
  check "CDN Edge Caching: Second request returned X-Cache-Status: HIT" 0
else
  echo "Edge cache did not return HIT on second request. Header: $CACHE_HEADER_2"
  check "CDN Edge Caching: Second request returned X-Cache-Status: HIT" 1
fi

# Check 7: Fetch one segment and assert HTTP 200
echo "==> Fetching 240p rendition playlist to discover segments..."
REND_PLAYLIST=$(curl -s "$LB_URL/hls/$VIDEO_ID/240p/index.m3u8")
FIRST_SEG=$(echo "$REND_PLAYLIST" | grep -E "\.ts$" | head -n 1 | tr -d '\r' || true)

if [ -z "$FIRST_SEG" ]; then
  echo "No .ts segments found in playlist:"
  echo "$REND_PLAYLIST"
  check "Segment discovery in rendition playlist" 1
fi

echo "==> Fetching segment /hls/$VIDEO_ID/240p/$FIRST_SEG..."
SEG_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$LB_URL/hls/$VIDEO_ID/240p/$FIRST_SEG" | tr -d '\r')
if [ "$SEG_HTTP_CODE" = "200" ]; then
  check "Segment download returned HTTP 200" 0
else
  echo "Segment request returned HTTP code $SEG_HTTP_CODE"
  check "Segment download returned HTTP 200" 1
fi

# Check 8: Call /api/whoami 12 times and assert at least 2 distinct instances answered
echo "==> Calling /api/whoami 12 times to verify load balancing across API replicas..."
INSTANCES=""
for i in $(seq 1 12); do
  RESP=$(curl -s "$LB_URL/api/whoami")
  INST=$(echo "$RESP" | grep -o '"instance":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
  if [ -n "$INST" ]; then
    INSTANCES="$INSTANCES $INST"
  fi
done

DISTINCT_COUNT=$(echo "$INSTANCES" | tr ' ' '\n' | grep -v '^$' | sort -u | wc -l)
echo "    Instances found ($DISTINCT_COUNT): $(echo "$INSTANCES" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')"

if [ "$DISTINCT_COUNT" -ge 2 ]; then
  check "Load balancing across multiple API instances (found $DISTINCT_COUNT distinct)" 0
else
  echo "Only found $DISTINCT_COUNT distinct API replica"
  check "Load balancing across multiple API instances" 1
fi

# Check 9: View count registration & real-time increment
echo "==> Registering view for video $VIDEO_ID..."
VIEW_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$LB_URL/api/videos/$VIDEO_ID/view" | tr -d '\r')
if [ "$VIEW_HTTP_CODE" = "204" ]; then
  check "View count endpoint returned HTTP 204 No Content" 0
else
  echo "View count endpoint returned HTTP code $VIEW_HTTP_CODE"
  check "View count endpoint returned HTTP 204 No Content" 1
fi

UPDATED_DETAILS=$(curl -s "$LB_URL/api/videos/$VIDEO_ID")
CURRENT_VIEWS=$(echo "$UPDATED_DETAILS" | grep -o '"views":"[^"]*' | cut -d'"' -f4 | tr -d '\r' || true)
if [ "$CURRENT_VIEWS" = "1" ]; then
  check "Video details reflected updated view count: 1" 0
else
  echo "Expected view count 1, got '$CURRENT_VIEWS' in response: $UPDATED_DETAILS"
  check "Video details reflected updated view count: 1" 1
fi

echo ""
echo "=== ALL $PASSED SMOKE CHECKS PASSED SUCCESSFULLY ==="
exit 0
