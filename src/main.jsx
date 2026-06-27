import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'

const initBranding = async () => {
  try {
    const domain = window.location.hostname;
    // Use window.location.origin so the URL is always absolute and correct
    // regardless of whether the frontend is in dev (localhost:5173) or prod.
    // In prod, /api is proxied to the backend. In dev, Vite proxy handles it.
    const brandingUrl = `${window.location.origin}/api/v1/branding?domain=${encodeURIComponent(domain)}`;
    const res = await fetch(brandingUrl);
    if (!res.ok) return; // Silently ignore — default branding is fine
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return; // Guard against HTML 404 pages
    const data = await res.json();

    if (data.success && data.branding) {
      const b = data.branding;
      if (b.theme_colors) {
        const root = document.documentElement;
        if (b.theme_colors.primary) root.style.setProperty('--primary', b.theme_colors.primary);
        // Add more CSS variables as needed
      }
      if (b.brand_name) document.title = b.brand_name;
      // Store in window for global access
      window.__BRANDING__ = b;
    }
  } catch (e) {
    console.error("Failed to load branding", e);
  }
};

initBranding().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
  )
});
