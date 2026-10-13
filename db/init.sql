-- Database initialization schema for Scalable Video Streaming Platform

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT CHECK (status IN ('queued', 'processing', 'ready', 'failed')) DEFAULT 'queued',
    progress INT DEFAULT 0,
    duration_sec NUMERIC,
    width INT,
    height INT,
    renditions JSONB DEFAULT '[]'::jsonb,
    size_bytes BIGINT,
    views BIGINT DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_videos_status_created_at ON videos(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_owner_id_created_at ON videos(owner_id, created_at DESC);
