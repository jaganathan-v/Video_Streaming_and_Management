#!/usr/bin/env bash
set -euo pipefail

# scripts/make-sample.sh
# Creates a 30s 1080p test video using "docker compose exec worker ffmpeg" with lavfi testsrc2 + sine audio,
# and copies it to ./samples/sample.mp4 (host needs no ffmpeg).

mkdir -p ./samples

echo "==> Finding a running worker container..."
WORKER_CONTAINER=$(docker compose ps -q worker | head -n 1)

if [ -z "$WORKER_CONTAINER" ]; then
  echo "ERROR: No running worker container found. Please run 'docker compose up -d' first."
  exit 1
fi

echo "==> Generating 30s 1080p test video inside worker container ($WORKER_CONTAINER)..."
docker compose exec -T worker ffmpeg -y \
  -f lavfi -i testsrc2=size=1920x1080:rate=24 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 30 \
  -c:v libx264 -pix_fmt yuv420p -b:v 4000k \
  -c:a aac -b:a 128k \
  /tmp/sample.mp4

echo "==> Copying /tmp/sample.mp4 from worker to ./samples/sample.mp4..."
docker cp "$WORKER_CONTAINER:/tmp/sample.mp4" ./samples/sample.mp4

# Clean up file in container
docker compose exec -T worker rm -f /tmp/sample.mp4

echo "==> Sample video generated successfully at ./samples/sample.mp4"
ls -lh ./samples/sample.mp4
