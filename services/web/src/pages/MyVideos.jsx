import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';

export default function MyVideos() {
  const { token, isAuthenticated } = useAuth();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchMyVideos = async () => {
    try {
      const res = await fetch('/api/me/videos', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to fetch user videos');
      const data = await res.json();
      setVideos(data.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchMyVideos();
    }
  }, [isAuthenticated]);

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this video? All S3 segments and records will be deleted.')) {
      return;
    }

    try {
      const res = await fetch(`/api/videos/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Delete failed');
      }
      setVideos((prev) => prev.filter((v) => v.id !== id));
    } catch (err) {
      alert(`Error deleting video: ${err.message}`);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="auth-box" style={{ textAlign: 'center' }}>
        <h2>Sign in required</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
          Please log in to manage your uploaded videos.
        </p>
        <Link to="/login" className="btn-primary" style={{ display: 'inline-block' }}>
          Sign In
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 700 }}>My Uploads</h1>
        <Link to="/upload" className="btn-primary">
          + Upload New Video
        </Link>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>Loading videos...</div>
      ) : videos.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          <p>You haven't uploaded any videos yet.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {videos.map((vid) => (
            <div
              key={vid.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--bg-card)',
                padding: '1rem 1.25rem',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <div style={{ width: 100, height: 60, background: '#020617', borderRadius: 4, overflow: 'hidden' }}>
                  {vid.status === 'ready' && (
                    <img
                      src={vid.thumbUrl}
                      alt={vid.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        e.target.style.display = 'none';
                      }}
                    />
                  )}
                </div>
                <div>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{vid.title}</h3>
                  <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                    <span className={`badge badge-${vid.status}`}>{vid.status}</span>
                    <span>{vid.views || 0} views</span>
                    <span>{new Date(vid.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {vid.status === 'ready' && (
                  <Link to={`/watch/${vid.id}`} className="btn-secondary" style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
                    Watch
                  </Link>
                )}
                <button onClick={() => handleDelete(vid.id)} className="btn-danger">
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
