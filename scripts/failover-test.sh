#!/usr/bin/env bash
set -euo pipefail

# scripts/failover-test.sh
# Tests system resilience:
# 1. Stop edge1, verify playlist still downloads via edge2
# 2. Start edge1
# 3. Stop minio2, verify playlist and a new upload still work (Erasure Coding resilience)
# 4. Start minio2

LB_URL="${LB_URL:-http://localhost:8080}"
SAMPLE_VIDEO="${SAMPLE_VIDEO:-./samples/sample.mp4}"

echo "=== STARTING RESILIENCE & FAILOVER TESTS ==="

# First ensure sample video exists
if [ ! -f "$SAMPLE_VIDEO" ]; then
  bash ./scripts/make-sample.sh
fi

# Ensure user and a ready video exist
echo "==> Setting up test user and baseline video..."
USER_EMAIL="failover_$(date +%s)@example.com"
REG_RESP=$(curl -s -X POST "$LB_URL/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"$USER_EMAIL\",\"password\":\"password123\"}")
TOKEN=$(echo "$REG_RESP" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

UPLOAD_RESP=$(curl -s -X POST "$LB_URL/api/videos" \
  -H "Authorization: Bearer $TOKEN" \
  -F "title=Baseline Video" \
  -F "video=@$SAMPLE_VIDEO")
VIDEO_ID=$(echo "$UPLOAD_RESP" | grep -o '"id":"[^"]*' | cut -d'"' -f4)

echo "==> Waiting for baseline video $VIDEO_ID to be ready..."
while true; do
  STATUS=$(curl -s "$LB_URL/api/videos/$VIDEO_ID/status" | grep -o '"status":"[^"]*' | cut -d'"' -f4 || true)
  if [ "$STATUS" = "ready" ]; then break; fi
  if [ "$STATUS" = "failed" ]; then echo "Baseline upload failed"; exit 1; fi
  sleep 2
done
echo "==> Baseline video ready!"

# --- TEST 1: Stop edge1 and verify playback continues via edge2 ---
echo ""
echo "--- TEST 1: Edge tier failover (stopping edge1) ---"
docker compose stop edge1
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$LB_URL/hls/$VIDEO_ID/master.m3u8")
if [ "$HTTP_CODE" -eq 200 ]; then
  echo "  [PASS] Playlist fetched successfully with edge1 stopped (HTTP 200)"
else
  echo "  [FAIL] Failed to fetch playlist when edge1 was stopped (HTTP $HTTP_CODE)"
  docker compose start edge1
  exit 1
fi

echo "==> Restarting edge1..."
docker compose start edge1
sleep 2

# --- TEST 2: Stop minio2 and verify read & write survive (4-node erasure coding) ---
echo ""
echo "--- TEST 2: Storage tier fault tolerance (stopping minio2) ---"
docker compose stop minio2
sleep 3

# Test Read
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$LB_URL/hls/$VIDEO_ID/master.m3u8")
if [ "$HTTP_CODE" -eq 200 ]; then
  echo "  [PASS] Read survives node loss: Master playlist served with minio2 offline (HTTP 200)"
else
  echo "  [FAIL] Master playlist failed with minio2 offline (HTTP $HTTP_CODE)"
  docker compose start minio2
  exit 1
fi

# Test Write (Upload while node is down)
echo "==> Uploading new video while minio2 is stopped..."
UPLOAD_2_RESP=$(curl -s -X POST "$LB_URL/api/videos" \
  -H "Authorization: Bearer $TOKEN" \
  -F "title=Survives MinIO Node Failure" \
  -F "video=@$SAMPLE_VIDEO")
VIDEO_2_ID=$(echo "$UPLOAD_2_RESP" | grep -o '"id":"[^"]*' | cut -d'"' -f4 || true)

if [ -n "$VIDEO_2_ID" ]; then
  echo "  [PASS] Write survives node loss: Upload accepted while minio2 is down (ID: $VIDEO_2_ID)"
else
  echo "  [FAIL] Upload failed while minio2 down: $UPLOAD_2_RESP"
  docker compose start minio2
  exit 1
fi

echo "==> Waiting for degraded transcode to complete..."
while true; do
  STATUS=$(curl -s "$LB_URL/api/videos/$VIDEO_2_ID/status" | grep -o '"status":"[^"]*' | cut -d'"' -f4 || true)
  if [ "$STATUS" = "ready" ]; then
    echo "  [PASS] Degraded transcode and write to 3-of-4 MinIO nodes completed successfully!"
    break
  fi
  if [ "$STATUS" = "failed" ]; then
    echo "  [FAIL] Degraded transcode failed"
    docker compose start minio2
    exit 1
  fi
  sleep 3
done

echo "==> Restarting minio2 to restore full 4-node cluster health..."
docker compose start minio2
sleep 3

echo ""
echo "=== ALL RESILIENCE AND FAILOVER TESTS PASSED ==="
