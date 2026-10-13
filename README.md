# Scalable Video Streaming Platform

A production-grade, distributed video streaming and transcoding architecture featuring adaptive-bitrate (ABR) HLS packaging, distributed object storage with erasure coding, multi-tier caching (CDN edge proxies + Redis cache-aside), asynchronous worker queues, and resilient load balancing.

---

## 1. System Architecture

```
                                      [ Clients / Browsers ]
                                                │
                                                ▼ HTTP :8080
                                ┌────────────────────────────────┐
                                │       Nginx Load Balancer      │
                                │              (lb)              │
                                └───────┬───────────────┬────────┘
                                        │               │
                     /api/*             │               │ /hls/* (Consistent Hash)
                        ┌───────────────┘               └───────────────┐
                        ▼                                               ▼
         ┌─────────────────────────────┐                 ┌─────────────────────────────┐
         │     API Tier (Stateless)    │                 │       CDN Edge Tier         │
         │  api: replica 1, 2, 3...    │                 │   edge1            edge2    │
         │   (Round-robin, Node.js)    │                 │ (Proxy Cache: 5GB, 7d/.ts)  │
         └───────┬──────────────┬──────┘                 └──────────────┬──────────────┘
                 │              │                                       │
                 ▼              ▼                                       ▼
        ┌────────────────┐ ┌───────────────┐            ┌─────────────────────────────┐
        │  PostgreSQL 16 │ │    Redis 7    │            │         Origin Tier         │
        │  (Metadata DB) │ │ (Cache/Queue) │            │     origin (Nginx :80/:9000)│
        └────────────────┘ └───────┬───────┘            └──────────────┬──────────────┘
                                   │ BullMQ                            │
                                   ▼ Jobs                              │ Least-conn load balance
                        ┌─────────────────────┐                        │ AWS SigV4 pass-through
                        │     Worker Tier     │                        │
                        │ worker: replica 1, 2│                        ▼
                        │ (FFmpeg Transcoder) │─────────▶ ┌─────────────────────────────┐
                        └─────────────────────┘  Upload   │    4-Node MinIO Cluster     │
                                                 HLS Segs │  minio1   minio2   minio3  4│
                                                          │  (Distributed Erasure Code) │
                                                          └─────────────────────────────┘
```

---

## 2. Request & Media Flows

### A. Upload Flow (Asynchronous Transcoding)
1. **Upload Request**: The authenticated client issues a multipart `POST /api/videos` with video metadata and file payload.
2. **Buffering & Storage**: The API receives the stream, saves it to local `/tmp` via Multer, and uploads the original video directly into MinIO's private `raw` bucket (`{videoId}/original.<ext>`) via AWS S3 SDK multipart uploader.
3. **Queue Enqueue**: API inserts a record into PostgreSQL with `status: 'queued'` and pushes a `transcode` job to BullMQ in Redis with 3 retry attempts and exponential backoff.
4. **Immediate Response**: API responds with `HTTP 202 Accepted` and `{ id, status: "queued" }`. The temporary file is unlinked immediately.
5. **Worker Execution**:
   - A worker replica picks up the job and transitions DB state to `status: 'processing'`.
   - Downloads the raw video from MinIO and inspects streams with `ffprobe` (dimensions, duration, audio channels).
   - Generates HLS ladders for all resolutions `<= source height` (down to 240p): `240p`, `360p`, `480p`, `720p`, `1080p`.
   - Executes `ffmpeg` with aligned keyframes (`-g 48 -keyint_min 48 -sc_threshold 0`) to produce seamless multi-bitrate HLS streams (`.m3u8` and `seg_%05d.ts`). Parses stderr `time=` markers to update DB `progress`.
   - Generates thumbnail `thumb.jpg` at 10% duration.
   - Generates unified multi-variant `master.m3u8`.
   - Uploads all segments in parallel (8 concurrent) to the `videos` bucket, followed by playlists, with HTTP caching headers (`Cache-Control: public, max-age=31536000, immutable` for `.ts`; `max-age=60` for `.m3u8`).
   - Updates video status to `status: 'ready'`, invalidates Redis cache keys (`video:<id>` and `videos:list:*`), and cleans up local temporary files.

### B. Playback Flow (Edge Caching & Low Latency)
1. **Web App Request**: Browser requests `/hls/<videoId>/master.m3u8`.
2. **Consistent Hash Edge Routing**: The top-level `lb` hashes `$request_uri` to deterministically choose either `edge1` or `edge2`.
3. **Edge Proxy Cache**:
   - On the first request (**MISS**), the Edge requests the master playlist from the `origin` upstream, stores it in its 5GB local cache zone, and sets `X-Cache-Status: MISS`.
   - On subsequent requests (**HIT**), the Edge serves directly from memory/disk cache with `X-Cache-Status: HIT` and `X-Edge: <hostname>`.
4. **Origin Tier**: Translates `/videos/...` requests to the healthy MinIO nodes using `least_conn`.
5. **Adaptive Bitrate Streaming**: `hls.js` dynamically switches between rendition playlists (`240p` through `1080p`) according to client bandwidth and player dimensions.
6. **Write-Behind View Counters**: Watching 5s emits `POST /api/videos/:id/view`. The API increments Redis counter `views:<id>`. A background interval batches and flushes counters to PostgreSQL every 10 seconds.

---

## 3. Services Summary

| Service | Technology | Port (Internal / Host) | Responsibility |
|---|---|---|---|
| **lb** | Nginx 1.27 Alpine | 80 / **8080** | Host ingress; routing `/`, `/api/`, `/hls/` with consistent hashing, client max body 2G, timeouts. |
| **web** | React 18 + Vite + Nginx | 80 / - | Static SPA serving with HTML5 history fallback. |
| **api** | Node.js 20 Express (x3) | 4000 / - | Stateless REST API, rate limiting, auth, metadata, and upload coordinator. |
| **worker**| Node.js 20 + FFmpeg (x2)| - / - | Asynchronous BullMQ background worker executing ABR transcoding ladders. |
| **edge1, edge2** | Nginx 1.27 Alpine | 80 / - | CDN Edge tier with 5GB proxy cache, 7d segment TTL, 60s playlist TTL, stale caching. |
| **origin**| Nginx 1.27 Alpine | 80 & 9000 / - | Origin load balancer with `least_conn` and AWS SigV4 pass-through across MinIO nodes. |
| **minio1..4** | MinIO Distributed | 9000 / - | 4-node distributed object storage with Erasure Coding. Survives single-node loss. |
| **postgres** | PostgreSQL 16 Alpine | 5432 / - | Relational database storing users and video metadata. |
| **redis** | Redis 7 Alpine | 6379 / - | Queue broker (BullMQ), cache-aside store, and view counter buffer. |

---

## 4. How to Run

### Prerequisites
- Docker Engine & Docker Compose v2 (or Docker Desktop / WSL2)
- Make (optional) or Bash

### 1. Launch Platform
```bash
# Copy default environment
cp .env.example .env

# Launch all services in background
docker compose up --build -d
```

### 2. Verify Health
```bash
docker compose ps
```
All services should indicate `(healthy)`.

### 3. Open UI
Navigate to [http://localhost:8080](http://localhost:8080) in your web browser.

**Demo Credentials**:
- Register a new account on the UI or use:
  - **Email**: `demo@streampulse.io`
  - **Password**: `password123`

---

## 5. Scaling Services

The stateless design allows independent on-the-fly horizontal scaling:

```bash
# Scale API to 5 replicas and worker to 4 replicas
docker compose up -d --scale worker=4 --scale api=5

# Reload load balancer to refresh upstream DNS
docker compose restart lb
```

---

## 6. Testing & Verification

### Generate Test Video
```bash
bash scripts/make-sample.sh
```
*Creates a 30-second 1080p 24fps test pattern video in `./samples/sample.mp4` using FFmpeg inside the worker container without needing FFmpeg installed on the host.*

### Automated Smoke Test
```bash
bash scripts/smoke-test.sh
```
Validates:
- Health check `200 OK`.
- User registration and login token generation.
- Video upload, queue ingestion, and transcode completion.
- Edge cache **MISS** followed by **HIT** (`X-Cache-Status`).
- Segment playback retrieval.
- Load distribution across multiple API replicas via `/api/whoami`.

### High-Availability & Failover Test
```bash
bash scripts/failover-test.sh
```
Validates:
- **Edge Tier Failover**: Shuts down `edge1`; verifies stream playback gracefully falls back to `edge2`.
- **Storage Tier Tolerance**: Shuts down `minio2`; verifies existing video playback and a brand-new transcode & upload succeed across the remaining 3 MinIO nodes via Erasure Coding.

### Load Test (k6)
```bash
# Run with Docker-contained k6
docker run --rm -i --network host grafana/k6 run - < loadtest/k6-script.js
```
Ramps from 0 to 200 concurrent virtual users over 2 minutes testing playlist and segment throughput with thresholds:
- `http_req_failed < 1%`
- `p(95) < 500ms`

---

## 7. Mapping to Production Cloud Infrastructure

| Local Component | Production AWS/GCP Equivalent | Migration Strategy |
|---|---|---|
| **lb & edge1/2** | AWS CloudFront / Cloudflare CDN | Replace Nginx edge proxies with CDN distributions. Point origins to S3 bucket or ALB. |
| **origin** | AWS Application Load Balancer | Front internal APIs with ALB, utilizing target groups with autoscaling policies. |
| **minio1..4** | Amazon S3 / Google Cloud Storage | Switch `S3_ENDPOINT` to standard AWS endpoint (`s3.amazonaws.com`) and attach IAM roles. |
| **api** | AWS ECS Fargate / EKS | Deploy Node.js Express containers with Horizontal Pod Autoscaler (HPA) based on CPU/traffic. |
| **worker** | AWS MediaConvert or ECS on Spot | Replace manual FFmpeg jobs with AWS Elemental MediaConvert or auto-scaling worker pods on Spot EC2. |
| **redis** | AWS ElastiCache for Redis | Use multi-AZ Redis replication group with automatic failover. |
| **postgres** | Amazon RDS PostgreSQL | Multi-AZ managed PostgreSQL instance with automated backups and read-replicas. |

---

## 8. Troubleshooting

- **Check logs**:
  ```bash
  docker compose logs -f <service_name>
  ```
- **Inspect cache status**:
  ```bash
  curl -I http://localhost:8080/hls/<videoId>/master.m3u8
  ```
- **Reset environment**:
  ```bash
  docker compose down -v
  ```
