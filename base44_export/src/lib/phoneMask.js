// Phone masking helper — used to hide the last 5 digits of phone numbers
// during demos / screen sharing. Display-only: NEVER use the masked value
// for searches, lookups, or API calls.
//
// Storage: per-device (localStorage) so toggling on one machine never affects
// another user / device. Default: OFF.

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'bolify_phone_mask_enabled';
const EVENT_NAME = 'bolify-phone-mask-change';

export function isPhoneMaskEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function setPhoneMaskEnabled(enabled) {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
    // Notify all <PhoneMaskToggle /> and usePhoneMask() consumers in this tab.
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: !!enabled }));
  } catch (_) {}
}

// Mask last N digits. Default 5 (per requirement: "last 5 digit hide ka option de do").
// Examples:
//   +919876543210  → +9198765XXXXX
//   9876543210     → 98765XXXXX
//   98765-43210    → 98765-XXXXX
export function maskPhone(phone, masked = true, hideCount = 5) {
  if (!masked) return phone || '';
  if (!phone) return '';
  const str = String(phone);
  // Walk backwards, replacing digits with X until hideCount digits have been masked.
  // Non-digit characters (+, -, space) are preserved as-is.
  let remaining = hideCount;
  const chars = str.split('');
  for (let i = chars.length - 1; i >= 0 && remaining > 0; i--) {
    if (/\d/.test(chars[i])) {
      chars[i] = 'X';
      remaining--;
    }
  }
  return chars.join('');
}

// React hook — re-renders the component whenever the user toggles masking
// (in the same tab or another tab on the same device).
export function usePhoneMask() {
  const [enabled, setEnabled] = useState(() => isPhoneMaskEnabled());

  useEffect(() => {
    const onCustom = (e) => setEnabled(!!e.detail);
    const onStorage = (e) => {
      if (e.key === STORAGE_KEY) setEnabled(e.newValue === '1');
    };
    window.addEventListener(EVENT_NAME, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggle = useCallback(() => setPhoneMaskEnabled(!isPhoneMaskEnabled()), []);
  const mask = useCallback((phone) => maskPhone(phone, enabled), [enabled]);

  return { enabled, toggle, mask };
}