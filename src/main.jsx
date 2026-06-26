import React from 'react'
import ReactDOM from 'react-dom/client'
import App from '@/App.jsx'
import '@/index.css'
import { apiClient } from '@/api/apiClient'

const initBranding = async () => {
  try {
    const domain = window.location.hostname;
    const res = await fetch(`${apiClient.baseUrl}/branding?domain=${domain}`);
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
