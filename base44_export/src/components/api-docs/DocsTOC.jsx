import React from 'react';

const sections = [
  { id: 'quickstart', label: '🚀 Quick Start' },
  { id: 'websocket', label: '⚙️ WebSocket URL' },
  { id: 'auth-keys', label: '🔑 Auth Keys' },
  { id: 'rest-core', label: '📞 Voice/Call APIs' },
  { id: 'crm-inbound', label: '📥 Push to Bolify' },
  { id: 'crm-fetch', label: '📤 Pull from Bolify' },
  { id: 'crm-outbound', label: '🔔 Outbound Webhooks' },
  { id: 'errors', label: '⚠️ Errors & Codes' },
  { id: 'examples', label: '💡 Code Examples' }
];

export default function DocsTOC() {
  return (
    <nav className="hidden lg:block sticky top-20 self-start w-56 shrink-0">
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-3">On this page</p>
        <ul className="space-y-1.5">
          {sections.map(s => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="block text-sm text-gray-700 hover:text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded transition-colors"
              >
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}