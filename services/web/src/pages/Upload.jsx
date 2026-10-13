import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';

export default function Upload() {
  const { token, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [file, setFile] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [videoId, setVideoId] = useState(null);
  const [transcodeStatus, setTranscodeStatus] = useState(null); // { status, progress, error }
  const [error, setError] = useState('');

  const fileInputRef = useRef(null);

  // Poll transcode status every 2s
  useEffect(() => {
    if (!videoId || (transcodeStatus && (transcodeStatus.status === 'ready' || transcodeStatus.status === 'failed'))) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/videos/${videoId}/status`);
        if (res.ok) {
          const data = await res.json();
          setTranscodeStatus(data);
        }
      } catch (e) {
        // Ignore polling errors
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [videoId, transcodeStatus]);

  if (!isAuthenticated) {
    return (
      <div className="auth-box" style={{ textAlign: 'center' }}>
        <h2>Sign in required</h2>
        <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
          Please log in or register an account to upload videos to the platform.
        </p>
        <Link to="/login" className="btn-primary" style={{ display: 'inline-block' }}>
          Go to Sign In
        </Link>
      </div>
    );
  }

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const selected = e.dataTransfer.files[0];
      if (selected.type.startsWith('video/')) {
        setFile(selected);
        if (!title) setTitle(selected.name.replace(/\.[^/.]+$/, ''));
      } else {
        setError('Please drop a valid video file');
      }
    }
  };

  const handleFileSelect = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const selected = e.target.files[0];
      setFile(selected);
      if (!title) setTitle(selected.name.replace(/\.[^/.]+$/, ''));
    }
  };

  const handleUpload = () => {
    if (!file) {
      setError('Please select a video file');
      return;
    }
    setError('');
    setUploading(true);
    setUploadPercent(0);

    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', title || 'Untitled Video');
    formData.append('description', description);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos', true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        setUploadPercent(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 202) {
        const resp = JSON.parse(xhr.responseText);
        setVideoId(resp.id);
        setTranscodeStatus({ status: 'queued', progress: 0 });
      } else {
        try {
          const resp = JSON.parse(xhr.responseText);
          setError(resp.error?.message || 'Upload failed');
        } catch {
          setError('Upload failed with status ' + xhr.status);
        }
        setUploading(false);
      }
    };

    xhr.onerror = () => {
      setError('Network error during upload');
      setUploading(false);
    };

    xhr.send(formData);
  };

  return (
    <div style={{ maxWidth: 700, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '1.5rem' }}>Upload Video</h1>

      {error && <div className="error-banner">{error}</div>}

      {!videoId ? (
        <div>
          <div
            className={`upload-dropzone ${dragOver ? 'active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: 'none' }}
              accept="video/*"
              onChange={handleFileSelect}
            />
            <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📁</div>
            <h3>{file ? file.name : 'Click to upload or drag & drop'}</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '0.4rem' }}>
              MP4, MOV, MKV, WebM up to 1024MB
            </p>
          </div>

          <div style={{ marginTop: '1.5rem' }}>
            <div className="form-group">
              <label>Video Title</label>
              <input
                type="text"
                placeholder="Give your video a descriptive title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea
                rows={4}
                placeholder="Optional description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {uploading && (
              <div style={{ margin: '1.5rem 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                  <span>Uploading to raw storage...</span>
                  <span>{uploadPercent}%</span>
                </div>
                <div className="progress-bar-container">
                  <div className="progress-bar" style={{ width: `${uploadPercent}%` }}></div>
                </div>
              </div>
            )}

            <button
              onClick={handleUpload}
              className="btn-primary"
              style={{ width: '100%', padding: '12px', marginTop: '0.5rem' }}
              disabled={uploading}
            >
              {uploading ? 'Uploading...' : 'Submit & Start Transcoding'}
            </button>
          </div>
        </div>
      ) : (
        <div className="auth-box" style={{ maxWidth: '100%' }}>
          <h2>Transcoding Video</h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0 1.5rem 0' }}>
            Video ID: <code>{videoId}</code>
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
            <span>Status:</span>
            <span className={`badge badge-${transcodeStatus?.status || 'queued'}`}>
              {transcodeStatus?.status}
            </span>
          </div>

          {transcodeStatus?.status === 'processing' && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem' }}>
                <span>Multi-resolution HLS Encoding (240p - 1080p)...</span>
                <span>{transcodeStatus.progress}%</span>
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar" style={{ width: `${transcodeStatus.progress}%` }}></div>
              </div>
            </div>
          )}

          {transcodeStatus?.status === 'ready' && (
            <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
              <p style={{ color: 'var(--accent)', fontWeight: 600, marginBottom: '1rem' }}>
                🎉 Video successfully processed and ready to stream!
              </p>
              <Link to={`/watch/${videoId}`} className="btn-primary" style={{ display: 'inline-block', padding: '10px 20px' }}>
                Watch Now
              </Link>
            </div>
          )}

          {transcodeStatus?.status === 'failed' && (
            <div className="error-banner" style={{ marginTop: '1rem' }}>
              Transcode failed: {transcodeStatus.error || 'Unknown error'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
