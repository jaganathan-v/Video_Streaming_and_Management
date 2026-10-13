import React, { useState, useEffect } from 'react';
import { Routes, Route, Link, NavLink } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import Home from './pages/Home.jsx';
import Watch from './pages/Watch.jsx';
import Upload from './pages/Upload.jsx';
import MyVideos from './pages/MyVideos.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';

export default function App() {
  const { user, isAuthenticated, logout } = useAuth();
  const [servedBy, setServedBy] = useState('resolving...');

  useEffect(() => {
    fetch('/api/whoami')
      .then((res) => {
        const headerInstance = res.headers.get('x-served-by');
        return res.json().then((data) => ({ data, headerInstance }));
      })
      .then(({ data, headerInstance }) => {
        setServedBy(headerInstance || data.instance || 'unknown');
      })
      .catch(() => setServedBy('offline'));
  }, []);

  return (
    <div className="app-container">
      <header className="navbar">
        <Link to="/" className="nav-brand">
          <span style={{ fontSize: '1.5rem' }}>⚡</span>
          <span>StreamPulse</span>
        </Link>

        <nav className="nav-links">
          <NavLink to="/" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')} end>
            Home
          </NavLink>
          {isAuthenticated && (
            <>
              <NavLink to="/upload" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                Upload
              </NavLink>
              <NavLink to="/my-videos" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
                My Videos
              </NavLink>
            </>
          )}

          {isAuthenticated ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginLeft: '0.5rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{user?.email}</span>
              <button onClick={logout} className="btn-secondary" style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
                Logout
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '0.75rem', marginLeft: '0.5rem' }}>
              <Link to="/login" className="btn-secondary" style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
                Sign In
              </Link>
              <Link to="/register" className="btn-primary" style={{ padding: '6px 12px', fontSize: '0.85rem' }}>
                Register
              </Link>
            </div>
          )}
        </nav>
      </header>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/watch/:id" element={<Watch />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/my-videos" element={<MyVideos />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>

      <footer className="footer">
        <div>
          <span>Scalable Video Streaming Platform &bull; Adaptive HLS &bull; MinIO Cluster &bull; Edge Caching</span>
        </div>
        <div>
          <span>Backend Instance (Load Balanced): </span>
          <span className="footer-badge">{servedBy}</span>
        </div>
      </footer>
    </div>
  );
}
