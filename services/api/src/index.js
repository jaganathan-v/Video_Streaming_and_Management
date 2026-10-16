import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Upload } from '@aws-sdk/lib-storage';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

import logger from './logger.js';
import { pool, query } from './db.js';
import { redis } from './redis.js';
import { s3, RAW_BUCKET, VIDEOS_BUCKET, ensureBucketsExist } from './s3.js';
import { transcodeQueue } from './queue.js';
import { signToken, authMiddleware } from './auth.js';
import { startViewCountFlusher, stopViewCountFlusher, flushViewCounts } from './viewsFlusher.js';

const app = express();
const PORT = process.env.PORT || 4000;
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10);

// Basic middleware
app.set('trust proxy', true);
app.use(helmet());
app.use(cors());
app.use(express.json());

// Custom header X-Served-By: <os.hostname()> on every response
app.use((req, res, next) => {
  res.setHeader('X-Served-By', os.hostname());
  next();
});

// General rate limiter: 300 req/min/IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later.' } },
});
app.use(generalLimiter);

// Auth rate limiter: 20 req/min/IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'AUTH_RATE_LIMIT_EXCEEDED', message: 'Too many authentication attempts, please try again later.' } },
});

// Multer storage to /tmp
const upload = multer({
  dest: '/tmp',
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_MIME_TYPE: Only video files are allowed'));
    }
  },
});

// --- Validation Schemas ---
const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// --- Routes ---

// Healthcheck & instance introspection
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  let redisOk = false;
  let s3Ok = false;

  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    logger.error({ err }, 'Healthcheck DB failed');
  }

  try {
    const pong = await redis.ping();
    if (pong === 'PONG') redisOk = true;
  } catch (err) {
    logger.error({ err }, 'Healthcheck Redis failed');
  }

  try {
    await s3.send(new ListObjectsV2Command({ Bucket: RAW_BUCKET, MaxKeys: 1 }));
    s3Ok = true;
  } catch (err) {
    logger.error({ err }, 'Healthcheck S3 failed');
  }

  if (dbOk && redisOk && s3Ok) {
    return res.status(200).json({ status: 'ok', db: 'ok', redis: 'ok', s3: 'ok' });
  } else {
    return res.status(503).json({
      status: 'unhealthy',
      db: dbOk ? 'ok' : 'fail',
      redis: redisOk ? 'ok' : 'fail',
      s3: s3Ok ? 'ok' : 'fail',
    });
  }
});

app.get('/api/whoami', (req, res) => {
  res.json({ instance: os.hostname() });
});

// Authentication
app.post('/api/auth/register', authLimiter, async (req, res, next) => {
  try {
    const parsed = RegisterSchema.parse(req.body);
    const existing = await query('SELECT id FROM users WHERE email = $1', [parsed.email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { code: 'USER_EXISTS', message: 'Email is already registered' } });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(parsed.password, salt);

    const result = await query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [parsed.email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    const token = signToken(user);
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const parsed = LoginSchema.parse(req.body);
    const result = await query('SELECT id, email, password_hash FROM users WHERE email = $1', [parsed.email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(parsed.password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

// Video Upload
app.post('/api/videos', authMiddleware, upload.single('video'), async (req, res, next) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'Video file is required' } });
  }

  const title = (req.body.title || 'Untitled Video').trim();
  const description = (req.body.description || '').trim();

  let tempFilePath = file.path;
  try {
    // 1. Create DB record
    const insertRes = await query(
      `INSERT INTO videos (owner_id, title, description, status, size_bytes)
       VALUES ($1, $2, $3, 'queued', $4) RETURNING id, status`,
      [req.user.id, title, description, file.size]
    );
    const videoId = insertRes.rows[0].id;

    // 2. Upload to S3 "raw" bucket: {videoId}/original.<ext>
    const ext = path.extname(file.originalname) || '.mp4';
    const s3Key = `${videoId}/original${ext}`;

    const fileStream = fs.createReadStream(tempFilePath);
    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: RAW_BUCKET,
        Key: s3Key,
        Body: fileStream,
        ContentType: file.mimetype,
      },
    });

    await uploader.done();

    // 3. Enqueue BullMQ job
    await transcodeQueue.add('transcode', {
      videoId,
      key: s3Key,
    });

    res.status(202).json({ id: videoId, status: 'queued' });
  } catch (err) {
    next(err);
  } finally {
    // Always delete the temp file
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (e) {
        logger.warn({ path: tempFilePath, err: e.message }, 'Failed to delete temporary upload file');
      }
    }
  }
});

// GET /videos?limit=12&cursor=<iso timestamp> -> cache-aside in Redis TTL 30s
app.get('/api/videos', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '12', 10), 50);
    const cursor = req.query.cursor ? req.query.cursor.trim() : '';

    const cacheKey = `videos:list:${limit}:${cursor}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.json(JSON.parse(cached));
    }

    let sql = `SELECT id, owner_id, title, description, status, duration_sec, width, height, renditions, views, created_at
               FROM videos
               WHERE status = 'ready'`;
    const params = [];

    if (cursor) {
      params.push(cursor);
      sql += ` AND created_at < $${params.length}`;
    }

    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

    const result = await query(sql, params);
    const items = await Promise.all(
      result.rows.map(async (row) => {
        const b1 = parseInt(await redis.get(`video:${row.id}:views`), 10) || 0;
        const b2 = parseInt(await redis.get(`views:${row.id}`), 10) || 0;
        const liveViews = String(Number(row.views || 0) + b1 + b2);
        return {
          ...row,
          views: liveViews,
          thumbUrl: `/hls/${row.id}/thumb.jpg`,
          hlsUrl: `/hls/${row.id}/master.m3u8`,
        };
      })
    );

    let nextCursor = null;
    if (items.length === limit) {
      nextCursor = items[items.length - 1].created_at;
    }

    const payload = { items, nextCursor };
    await redis.set(cacheKey, JSON.stringify(payload), 'EX', 30);

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /me/videos (auth) -> all my videos
app.get('/api/me/videos', authMiddleware, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, owner_id, title, description, status, progress, duration_sec, width, height, renditions, views, error, created_at, updated_at
       FROM videos
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    const items = await Promise.all(
      result.rows.map(async (row) => {
        const b1 = parseInt(await redis.get(`video:${row.id}:views`), 10) || 0;
        const b2 = parseInt(await redis.get(`views:${row.id}`), 10) || 0;
        const liveViews = String(Number(row.views || 0) + b1 + b2);
        return {
          ...row,
          views: liveViews,
          thumbUrl: `/hls/${row.id}/thumb.jpg`,
          hlsUrl: `/hls/${row.id}/master.m3u8`,
        };
      })
    );

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /videos/:id/status -> {status,progress,error} (never cached)
app.get('/api/videos/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      'SELECT status, progress, error FROM videos WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video not found' } });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /videos/:id -> details with hlsUrl, thumbUrl, renditions. Redis cache key video:<id> TTL 60s
app.get('/api/videos/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const cacheKey = `video:${id}`;

    const getLiveViews = async (baseViews) => {
      const b1 = parseInt(await redis.get(`video:${id}:views`), 10) || 0;
      const b2 = parseInt(await redis.get(`views:${id}`), 10) || 0;
      return String(Number(baseViews || 0) + b1 + b2);
    };

    const cached = await redis.get(cacheKey);
    if (cached) {
      const cachedVideo = JSON.parse(cached);
      cachedVideo.views = await getLiveViews(cachedVideo.baseViews !== undefined ? cachedVideo.baseViews : cachedVideo.views);
      return res.json(cachedVideo);
    }

    const result = await query(
      `SELECT id, owner_id, title, description, status, progress, duration_sec, width, height, renditions, views, error, created_at, updated_at
       FROM videos WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video not found' } });
    }

    const video = result.rows[0];
    const liveViews = await getLiveViews(video.views);
    const payload = {
      ...video,
      baseViews: video.views,
      views: liveViews,
      hlsUrl: `/hls/${video.id}/master.m3u8`,
      thumbUrl: `/hls/${video.id}/thumb.jpg`,
    };

    // Cache ready videos
    if (video.status === 'ready') {
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', 60);
    }

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /videos/:id/view -> 204. Count incremented via Redis INCR video:{id}:views buffered, flushed to DB every 10s by setInterval worker.
app.post('/api/videos/:id/view', async (req, res, next) => {
  try {
    const { id } = req.params;
    await redis.incr(`video:${id}:views`);
    await redis.del(`video:${id}`);
    const listKeys = await redis.keys('videos:list:*');
    if (listKeys.length > 0) {
      await redis.del(...listKeys);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Helper to delete all objects with prefix in a bucket
async function deleteS3Prefix(bucket, prefix) {
  try {
    let continuationToken = undefined;
    do {
      const listRes = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );

      if (listRes.Contents && listRes.Contents.length > 0) {
        const objectsToDelete = listRes.Contents.map((item) => ({ Key: item.Key }));
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objectsToDelete },
          })
        );
      }
      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);
  } catch (err) {
    logger.warn({ bucket, prefix, err: err.message }, 'Failed or partial deletion of S3 prefix');
  }
}

// DELETE /videos/:id (owner only)
app.delete('/api/videos/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;

    const check = await query('SELECT owner_id FROM videos WHERE id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Video not found' } });
    }

    if (check.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not own this video' } });
    }

    // 1. Delete row from DB
    await query('DELETE FROM videos WHERE id = $1', [id]);

    // 2. Invalidate caches
    await redis.del(`video:${id}`);
    await redis.del(`views:${id}`);
    await redis.del(`video:${id}:views`);
    const listKeys = await redis.keys('videos:list:*');
    if (listKeys.length > 0) {
      await redis.del(...listKeys);
    }

    // 3. Delete objects in both raw and videos buckets
    await deleteS3Prefix(RAW_BUCKET, `${id}/`);
    await deleteS3Prefix(VIDEOS_BUCKET, `${id}/`);

    res.json({ success: true, message: 'Video deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// Central error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled request error');

  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      },
    });
  }

  if (err.message && err.message.startsWith('INVALID_MIME_TYPE')) {
    return res.status(400).json({
      error: { code: 'INVALID_FILE_TYPE', message: err.message },
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred',
    },
  });
});

// Start Server
async function start() {
  try {
    await ensureBucketsExist();
    startViewCountFlusher(10000);

    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT, instance: os.hostname() }, 'API server started');
    });

    // Graceful shutdown on SIGTERM
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutting down API server gracefully...');
      stopViewCountFlusher();
      await flushViewCounts();

      server.close(() => {
        logger.info('HTTP server closed');
        pool.end();
        redis.quit();
        process.exit(0);
      });

      // Force shutdown after 10s
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.fatal({ err }, 'Failed to start API');
    process.exit(1);
  }
}

start();
