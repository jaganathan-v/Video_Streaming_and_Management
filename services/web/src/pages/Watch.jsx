import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import Hls from 'hls.js';

export default function Watch() {
  const { id } = useParams();
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  const [videoData, setVideoData] = useState(null);
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = Auto
  const [stats, setStats] = useState({
    resolution: 'N/A',
    bitrate: 'N/A',
    bufferSec: 0,
    droppedFrames: 0,
  });
  const [error, setError] = useState('');
  const viewCountedRef = useRef(false);

  // Fetch video details
  useEffect(() => {
    viewCountedRef.current = false;
    fetch(`/api/videos/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error('Video not found');
        return res.json();
      })
      .then((data) => setVideoData(data))
      .catch((err) => setError(err.message));
  }, [id]);

  // Setup HLS player
  useEffect(() => {
    if (!videoData) return;
    const video = videoRef.current;
    if (!video) return;

    const streamUrl = `/hls/${id}/master.m3u8`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        capLevelToPlayerSize: true,
        autoStartLoad: true,
      });
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        const lvls = data.levels.map((lvl, index) => ({
          index,
          height: lvl.height,
          bitrate: Math.round(lvl.bitrate / 1000) + ' kbps',
        }));
        setLevels(lvls);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const levelObj = hls.levels[data.level];
        if (levelObj) {
          setStats((prev) => ({
            ...prev,
            resolution: `${levelObj.width}x${levelObj.height} (${levelObj.height}p)`,
            bitrate: `${Math.round(levelObj.bitrate / 1000)} kbps`,
          }));
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              setError('Fatal stream error');
              break;
          }
        }
      });

      return () => {
        hls.destroy();
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS for Safari
      video.src = streamUrl;
    }
  }, [videoData, id]);

  // Live stats & 5-second view registration
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const interval = setInterval(() => {
      // Calculate buffer
      let bufferSec = 0;
      if (video.buffered.length > 0) {
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
            bufferSec = Math.round((video.buffered.end(i) - video.currentTime) * 10) / 10;
            break;
          }
        }
      }

      // Dropped frames
      let dropped = 0;
      if (video.getVideoPlaybackQuality) {
        dropped = video.getVideoPlaybackQuality().droppedVideoFrames;
      } else if (video.webkitDroppedFrameCount) {
        dropped = video.webkitDroppedFrameCount;
      }

      setStats((prev) => ({
        ...prev,
        bufferSec,
        droppedFrames: dropped,
        resolution: prev.resolution === 'N/A' && video.videoHeight ? `${video.videoWidth}x${video.videoHeight} (${video.videoHeight}p)` : prev.resolution,
      }));

      // Register view after 2s playback (or 1s for short clips)
      const threshold = video.duration && video.duration < 5 ? 1 : 2;
      if (video.currentTime >= threshold && !video.paused && !viewCountedRef.current) {
        viewCountedRef.current = true;
        fetch(`/api/videos/${id}/view`, { method: 'POST' })
          .then(() => {
            setVideoData((prev) => (prev ? { ...prev, views: String(Number(prev.views || 0) + 1) } : prev));
          })
          .catch((err) => console.error('View count error:', err));
      }
    }, 1000);

    const onTimeUpdate = () => {
      const threshold = video.duration && video.duration < 5 ? 1 : 2;
      if (video.currentTime >= threshold && !video.paused && !viewCountedRef.current) {
        viewCountedRef.current = true;
        fetch(`/api/videos/${id}/view`, { method: 'POST' })
          .then(() => {
            setVideoData((prev) => (prev ? { ...prev, views: String(Number(prev.views || 0) + 1) } : prev));
          })
          .catch((err) => console.error('View count error:', err));
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      clearInterval(interval);
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [id]);

  const handleQualityChange = (e) => {
    const val = parseInt(e.target.value, 10);
    setCurrentLevel(val);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = val; // -1 for Auto
    }
  };

  if (error) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem' }}>
        <div className="error-banner">{error}</div>
        <Link to="/" className="btn-secondary" style={{ display: 'inline-block', marginTop: '1rem' }}>
          Back to Home
        </Link>
      </div>
    );
  }

  if (!videoData) {
    return <div style={{ textAlign: 'center', padding: '3rem' }}>Loading player...</div>;
  }

  return (
    <div className="player-container">
      <div>
        <Link to="/" style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          &larr; Back to Videos
        </Link>
      </div>

      <div className="video-player-wrapper">
        <video
          ref={videoRef}
          controls
          playsInline
          autoPlay
          poster={videoData.thumbUrl}
          className="video-player"
        />
      </div>

      <div className="player-controls-bar">
        <div>
          <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Quality Control:</span>
        </div>
        <div className="quality-selector">
          <label htmlFor="qualitySelect">Stream Quality:</label>
          <select id="qualitySelect" value={currentLevel} onChange={handleQualityChange}>
            <option value={-1}>Auto (ABR Enabled)</option>
            {levels.map((lvl) => (
              <option key={lvl.index} value={lvl.index}>
                {lvl.height}p ({lvl.bitrate})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Live Stats Panel */}
      <div className="stats-panel">
        <div className="stat-item">
          <span className="stat-label">Active Resolution</span>
          <span className="stat-value">{stats.resolution}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Video Bitrate</span>
          <span className="stat-value">{stats.bitrate}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Buffer Ahead</span>
          <span className="stat-value">{stats.bufferSec} s</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">Dropped Frames</span>
          <span className="stat-value">{stats.droppedFrames}</span>
        </div>
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>{videoData.title}</h1>
        <div style={{ display: 'flex', gap: '1rem', color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '0.5rem 0' }}>
          <span>{videoData.views} views</span>
          <span>Uploaded on {new Date(videoData.created_at).toLocaleDateString()}</span>
        </div>
        {videoData.description && (
          <p style={{ marginTop: '1rem', whiteSpace: 'pre-line', color: 'var(--text-secondary)' }}>
            {videoData.description}
          </p>
        )}
      </div>
    </div>
  );
}
