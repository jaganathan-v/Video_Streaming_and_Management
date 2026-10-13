import { Queue } from 'bullmq';
import { redis } from './redis.js';
import logger from './logger.js';

export const transcodeQueue = new Queue('transcode', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

transcodeQueue.on('error', (err) => {
  logger.error({ err }, 'Transcode queue error');
});
