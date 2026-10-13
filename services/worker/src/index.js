import { Worker } from 'bullmq';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import logger from './logger.js';
import { pool, query } from './db.js';
import { redis } from './redis.js';
import { s3, RAW_BUCKET, VIDEOS_BUCKET, ensureBucketsExist } from './s3.js';

const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '1', 10);

// Ladder configuration
const ALL_LADDERS = [
  { name: '240p', height: 240, bitrate: '400k' },
  { name: '360p', height: 360, bitrate: '800k' },
  { name: '480p', height: 480, bitrate: '1400k' },
  { name: '720p', height: 720, bitrate: '2800k' },
  { name: '1080p', height: 1080, bitrate: '5000k' },
];

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    logger.debug({ command, args: args.join(' ') }, 'Executing process');
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command ${command} exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => reject(err));
  });
}

async function probeVideo(filePath) {
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=width,height,codec_type:format=duration',
    '-of', 'json',
    filePath,
  ];

  const { stdout } = await runCommand('ffprobe', args);
  const info = JSON.parse(stdout);

  let width = null;
  let height = null;
  let hasAudio = false;

  if (info.streams) {
    for (const stream of info.streams) {
      if (stream.codec_type === 'video' && !width) {
        width = stream.width;
        height = stream.height;
      }
      if (stream.codec_type === 'audio') {
        hasAudio = true;
      }
    }
  }

  const durationSec = info.format && info.format.duration ? parseFloat(info.format.duration) : 0;
  return { width, height, durationSec, hasAudio };
}

function parseTimeToSeconds(timeStr) {
  // Format: HH:MM:SS.ms
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]);
    const minutes = parseFloat(parts[1]);
    const seconds = parseFloat(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return 0;
}

function transcodeRendition(rawFilePath, outDir, rendition, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    // -vf scale=-2:<h> -b:v <br> -maxrate 1.1x -bufsize 2x -g 48 -keyint_min 48 -sc_threshold 0
    // -c:a aac -b:a 128k -ac 2 -map 0:v:0 -map 0:a:0? -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_filename seg_%05d.ts index.m3u8
    const numBitrate = parseInt(rendition.bitrate.replace('k', ''), 10);
    const maxrate = `${Math.round(numBitrate * 1.1)}k`;
    const bufsize = `${numBitrate * 2}k`;

    const args = [
      '-y',
      '-i', rawFilePath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-vf', `scale=-2:${rendition.height}`,
      '-b:v', rendition.bitrate,
      '-maxrate', maxrate,
      '-bufsize', bufsize,
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-f', 'hls',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outDir, 'seg_%05d.ts'),
      path.join(outDir, 'index.m3u8'),
    ];

    const child = spawn('ffmpeg', args);
    let stderr = '';

    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;

      // Extract time=HH:MM:SS.ms
      const match = chunk.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (match && match[1] && totalDuration > 0) {
        const currentTime = parseTimeToSeconds(match[1]);
        const fraction = Math.min(currentTime / totalDuration, 1.0);
        onProgress(fraction);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed for rendition ${rendition.name} (code ${code}): ${stderr}`));
      }
    });

    child.on('error', (err) => reject(err));
  });
}

async function generateThumbnail(rawFilePath, outThumbPath, durationSec) {
  const seekSec = Math.max(1, durationSec * 0.1);
  const args = [
    '-y',
    '-ss', seekSec.toFixed(2),
    '-i', rawFilePath,
    '-vframes', '1',
    '-vf', 'scale=640:-2',
    outThumbPath,
  ];
  await runCommand('ffmpeg', args);
}

// Parallel worker pool helper
async function mapParallel(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(items.length, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function processJob(job) {
  const { videoId, key } = job.data;
  logger.info({ videoId, key, attempt: job.attemptsMade }, 'Starting transcode job');

  // 1. Set status=processing
  await query('UPDATE videos SET status = $1, progress = 0, updated_at = now() WHERE id = $2', ['processing', videoId]);

  // Invalidate Redis caches on status change
  await redis.del(`video:${videoId}`);
  const listKeys = await redis.keys('videos:list:*');
  if (listKeys.length > 0) {
    await redis.del(...listKeys);
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `transcode-${videoId}-`));
  const rawFilePath = path.join(workDir, path.basename(key));

  try {
    // Download raw file
    logger.info({ videoId, key }, 'Downloading raw object from S3');
    const s3Resp = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: key }));
    const writeStream = fs.createWriteStream(rawFilePath);
    await pipeline(s3Resp.Body, writeStream);

    // 2. ffprobe
    logger.info({ videoId }, 'Probing raw video file');
    const probe = await probeVideo(rawFilePath);
    const { width, height, durationSec } = probe;
    logger.info({ videoId, width, height, durationSec }, 'Probe completed');

    // 3. Ladder
    // Ladder (only renditions with height <= source height; ALWAYS include at least 240p)
    let selectedLadders = ALL_LADDERS.filter((l) => l.height <= (height || 1080));
    if (!selectedLadders.some((l) => l.name === '240p')) {
      selectedLadders.unshift(ALL_LADDERS[0]);
    }
    // Sort ascending height
    selectedLadders.sort((a, b) => a.height - b.height);

    logger.info({ videoId, renditions: selectedLadders.map((l) => l.name) }, 'Selected renditions');

    // 4. For each rendition run ffmpeg
    const numRenditions = selectedLadders.length;
    let lastProgressUpdate = 0;
    let globalProgress = 0;

    const throttleUpdateDbProgress = async (calcProgress) => {
      const now = Date.now();
      if (now - lastProgressUpdate >= 2000 && calcProgress > globalProgress) {
        lastProgressUpdate = now;
        globalProgress = calcProgress;
        await query('UPDATE videos SET progress = $1, updated_at = now() WHERE id = $2', [globalProgress, videoId]);
        logger.info({ videoId, progress: globalProgress }, 'Transcode progress updated');
      }
    };

    const renditionMetadata = [];

    for (let i = 0; i < numRenditions; i++) {
      const rendition = selectedLadders[i];
      const renditionDir = path.join(workDir, `${rendition.height}p`);
      fs.mkdirSync(renditionDir, { recursive: true });

      logger.info({ videoId, rendition: rendition.name }, 'Transcoding rendition');

      await transcodeRendition(rawFilePath, renditionDir, rendition, durationSec, async (fraction) => {
        // Overall progress: each rendition occupies a slice of 90% total progress
        const renditionSlice = 90 / numRenditions;
        const currentProgress = Math.round(i * renditionSlice + fraction * renditionSlice);
        await throttleUpdateDbProgress(currentProgress);
      });

      renditionMetadata.push({
        name: rendition.name,
        height: rendition.height,
        bitrate: rendition.bitrate,
      });
    }

    // 5. Create thumb.jpg
    logger.info({ videoId }, 'Generating thumbnail');
    const thumbPath = path.join(workDir, 'thumb.jpg');
    await generateThumbnail(rawFilePath, thumbPath, durationSec);

    // 6. Write master.m3u8
    logger.info({ videoId }, 'Generating master playlist');
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    for (const rendition of selectedLadders) {
      // Calculate bandwidth from bitrate (e.g., 400k -> 400000 + audio 128000)
      const numBps = parseInt(rendition.bitrate.replace('k', ''), 10) * 1000 + 128000;
      // Estimate width maintaining aspect ratio or 16:9
      const approxWidth = Math.round((rendition.height * 16) / 9 / 2) * 2;
      masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${numBps},RESOLUTION=${approxWidth}x${rendition.height},CODECS="avc1.4d401f,mp4a.40.2"\n${rendition.height}p/index.m3u8\n`;
    }
    const masterPath = path.join(workDir, 'master.m3u8');
    fs.writeFileSync(masterPath, masterContent, 'utf-8');

    // 7. Upload everything to bucket videos
    // Rules:
    // segments: "public, max-age=31536000, immutable", video/mp2t (.ts)
    // playlists: "public, max-age=60", application/vnd.apple.mpegurl (.m3u8)
    // thumbnails: "public, max-age=86400", image/jpeg (.jpg)
    // segments in parallel (8 at a time), playlists LAST so a playlist never points to missing segments.

    logger.info({ videoId }, 'Uploading segments and thumbnail to S3');

    // Collect segments
    const segmentUploadTasks = [];
    for (const rendition of selectedLadders) {
      const renditionDir = path.join(workDir, `${rendition.height}p`);
      const files = fs.readdirSync(renditionDir);
      for (const file of files) {
        if (file.endsWith('.ts')) {
          segmentUploadTasks.push({
            filePath: path.join(renditionDir, file),
            s3Key: `${videoId}/${rendition.height}p/${file}`,
            contentType: 'video/mp2t',
            cacheControl: 'public, max-age=31536000, immutable',
          });
        }
      }
    }

    // Upload segments in parallel (8 at a time)
    await mapParallel(segmentUploadTasks, 8, async (task) => {
      const body = fs.readFileSync(task.filePath);
      await s3.send(
        new PutObjectCommand({
          Bucket: VIDEOS_BUCKET,
          Key: task.s3Key,
          Body: body,
          ContentType: task.contentType,
          CacheControl: task.cacheControl,
        })
      );
    });

    // Upload thumbnail
    if (fs.existsSync(thumbPath)) {
      const thumbBody = fs.readFileSync(thumbPath);
      await s3.send(
        new PutObjectCommand({
          Bucket: VIDEOS_BUCKET,
          Key: `${videoId}/thumb.jpg`,
          Body: thumbBody,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=86400',
        })
      );
    }

    // Upload playlists LAST: rendition playlists first, then master.m3u8
    logger.info({ videoId }, 'Uploading rendition playlists and master playlist');
    for (const rendition of selectedLadders) {
      const renditionPlPath = path.join(workDir, `${rendition.height}p`, 'index.m3u8');
      if (fs.existsSync(renditionPlPath)) {
        const plBody = fs.readFileSync(renditionPlPath);
        await s3.send(
          new PutObjectCommand({
            Bucket: VIDEOS_BUCKET,
            Key: `${videoId}/${rendition.height}p/index.m3u8`,
            Body: plBody,
            ContentType: 'application/vnd.apple.mpegurl',
            CacheControl: 'public, max-age=60',
          })
        );
      }
    }

    const masterBody = fs.readFileSync(masterPath);
    await s3.send(
      new PutObjectCommand({
        Bucket: VIDEOS_BUCKET,
        Key: `${videoId}/master.m3u8`,
        Body: masterBody,
        ContentType: 'application/vnd.apple.mpegurl',
        CacheControl: 'public, max-age=60',
      })
    );

    // 8. Set status=ready, progress=100
    await query(
      `UPDATE videos
       SET status = 'ready', progress = 100, duration_sec = $1, width = $2, height = $3, renditions = $4, error = NULL, updated_at = now()
       WHERE id = $5`,
      [durationSec, width, height, JSON.stringify(renditionMetadata), videoId]
    );

    // Invalidate Redis caches
    await redis.del(`video:${videoId}`);
    const listKeysReady = await redis.keys('videos:list:*');
    if (listKeysReady.length > 0) {
      await redis.del(...listKeysReady);
    }

    logger.info({ videoId }, 'Transcode job completed successfully');
  } catch (err) {
    logger.error({ videoId, err: err.message, stack: err.stack }, 'Transcode job error');

    // If this is the last attempt or job failed permanently
    if (job.attemptsMade + 1 >= (job.opts.attempts || 3)) {
      await query(
        `UPDATE videos
         SET status = 'failed', error = $1, updated_at = now()
         WHERE id = $2`,
        [err.message, videoId]
      );

      await redis.del(`video:${videoId}`);
      const listKeysFail = await redis.keys('videos:list:*');
      if (listKeysFail.length > 0) {
        await redis.del(...listKeysFail);
      }
    }

    throw err;
  } finally {
    // ALWAYS remove the temp dir (finally)
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
        logger.debug({ workDir }, 'Cleaned up work directory');
      }
    } catch (cleanupErr) {
      logger.warn({ workDir, err: cleanupErr.message }, 'Failed to remove work directory');
    }
  }
}

async function start() {
  try {
    await ensureBucketsExist();

    const worker = new Worker('transcode', processJob, {
      connection: redis,
      concurrency: WORKER_CONCURRENCY,
    });

    worker.on('active', (job) => {
      logger.info({ jobId: job.id, videoId: job.data.videoId }, 'Worker picked up job');
    });

    worker.on('completed', (job) => {
      logger.info({ jobId: job.id, videoId: job.data.videoId }, 'Worker completed job');
    });

    worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, videoId: job?.data?.videoId, err: err.message }, 'Worker job failed');
    });

    logger.info({ concurrency: WORKER_CONCURRENCY }, 'Transcode worker started and listening');

    // Graceful shutdown on SIGTERM
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down worker gracefully...');
      await worker.close();
      await pool.end();
      await redis.quit();
      logger.info('Worker shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Worker startup failed');
    process.exit(1);
  }
}

start();
