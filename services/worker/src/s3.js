import { S3Client, CreateBucketCommand, PutBucketPolicyCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import logger from './logger.js';

export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || 'http://origin:9000',
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.S3_SECRET_KEY || 'miniopassword123',
  },
  forcePathStyle: true,
});

export const RAW_BUCKET = process.env.S3_RAW_BUCKET || 'raw';
export const VIDEOS_BUCKET = process.env.S3_VIDEOS_BUCKET || 'videos';

export async function ensureBucketsExist() {
  const buckets = [RAW_BUCKET, VIDEOS_BUCKET];
  for (const bucket of buckets) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        logger.info({ bucket }, 'Worker created bucket');
      } catch (e) {
        logger.warn({ bucket, err: e.message }, 'CreateBucket returned notice/error in worker');
      }
    }
  }

  try {
    const publicReadPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${VIDEOS_BUCKET}/*`],
        },
      ],
    };
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: VIDEOS_BUCKET,
        Policy: JSON.stringify(publicReadPolicy),
      })
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to set bucket policy in worker');
  }
}
