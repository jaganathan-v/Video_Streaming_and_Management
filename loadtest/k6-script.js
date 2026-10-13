import http from 'k6/http';
import { check, sleep } from 'k6';

// k6 load test script
// Scenario: Ramp 0 -> 200 virtual users over 2 minutes
// Each VU fetches video list, master playlist, and up to 10 segments.
// Thresholds: http_req_failed < 1%, p(95) < 500ms.

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], // less than 1% failure
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:8080';

export default function () {
  // 1. Fetch video list
  const listRes = http.get(`${BASE_URL}/api/videos?limit=12`);
  check(listRes, {
    'videos list status is 200': (r) => r.status === 200,
  });

  let videoId = null;
  try {
    const data = JSON.parse(listRes.body);
    if (data.items && data.items.length > 0) {
      videoId = data.items[0].id;
    }
  } catch (e) {
    // ignore
  }

  if (videoId) {
    // 2. Fetch master playlist
    const masterRes = http.get(`${BASE_URL}/hls/${videoId}/master.m3u8`);
    check(masterRes, {
      'master playlist status is 200': (r) => r.status === 200,
    });

    // 3. Fetch rendition playlist (e.g. 240p)
    const renditionRes = http.get(`${BASE_URL}/hls/${videoId}/240p/index.m3u8`);
    check(renditionRes, {
      'rendition playlist status is 200': (r) => r.status === 200,
    });

    // 4. Fetch up to 10 segments from the rendition playlist
    const lines = renditionRes.body ? renditionRes.body.split('\n') : [];
    const segments = lines.filter((l) => l.trim().endsWith('.ts')).slice(0, 10);

    for (const seg of segments) {
      const segRes = http.get(`${BASE_URL}/hls/${videoId}/240p/${seg.trim()}`);
      check(segRes, {
        'segment status is 200': (r) => r.status === 200,
      });
    }
  }

  sleep(1);
}
