import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

export default function Home() {
  const [videos, setVideos] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const fetchVideos = async (cursor = '') => {
    try {
      const url = cursor ? `/api/videos?limit=12&cursor=${encodeURIComponent(cursor)}` : '/api/videos?limit=12';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to fetch videos');
      const data = await res.json();
      return data;
    } catch (err) {
      setError(err.message);
      return { items: [], nextCursor: null };
    }
  };

  useEffect(() => {
    fetchVideos().then((data) => {
      setVideos(data.items || []);
      setNextCursor(data.nextCursor);
      setLoading(false);
    });
  }, []);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const data = await fetchVideos(nextCursor);
    setVideos((prev) => [...prev, ...(data.items || [])]);
    setNextCursor(data.nextCursor);
    setLoadingMore(false);
  };

  const formatDuration = (sec) => {
    if (!sec) return '0:00';
    const s = Math.round(sec);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${rem < 10 ? '0' : ''}${rem}`;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700 }}>Featured Videos</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Adaptive Bitrate HLS streams powered by MinIO cluster & CDN Edge Caching
          </p>
        </div>
        <Link to="/upload" className="btn-primary" style={{ padding: '8px 16px', borderRadius: 'var(--radius)' }}>
          + Upload Video
        </Link>
      </div>

      {error && <div className="error-banner" style={{ marginTop: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
          Loading video feed...
        </div>
      ) : videos.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-secondary)' }}>
          <h3>No videos yet</h3>
          <p style={{ marginTop: '0.5rem' }}>Upload your first video to start streaming with adaptive bitrate!</p>
          <Link to="/upload" className="btn-primary" style={{ display: 'inline-block', marginTop: '1rem' }}>
            Upload Now
          </Link>
        </div>
      ) : (
        <>
          <div className="video-grid">
            {videos.map((vid) => (
              <Link to={`/watch/${vid.id}`} key={vid.id} className="video-card">
                <div className="video-thumbnail-wrap">
                  <img
                    src={vid.thumbUrl}
                    alt={vid.title}
                    className="video-thumbnail"
                    onError={(e) => {
                      e.target.style.display = 'none';
                    }}
                  />
                  <span className="video-duration">{formatDuration(vid.duration_sec)}</span>
                </div>
                <div className="video-info">
                  <h3 className="video-title">{vid.title}</h3>
                  <div className="video-meta">
                    <span>{vid.views || 0} views</span>
                    <span>{new Date(vid.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {nextCursor && (
            <div style={{ textAlign: 'center', marginTop: '2.5rem' }}>
              <button onClick={handleLoadMore} className="btn-secondary" disabled={loadingMore}>
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
