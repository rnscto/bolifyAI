import React from 'react';

export default function VoiceWaveBg({ className = "", color = "rgba(255,153,51,0.08)", position = "bottom" }) {
  const d = position === "bottom"
    ? "M0,160 C120,100 240,200 360,140 C480,80 600,180 720,120 C840,60 960,160 1080,100 C1200,40 1320,140 1440,80 L1440,320 L0,320 Z"
    : "M0,160 C120,220 240,120 360,180 C480,240 600,140 720,200 C840,260 960,160 1080,220 C1200,280 1320,180 1440,240 L1440,0 L0,0 Z";

  return (
    <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}>
      <svg
        viewBox="0 0 1440 320"
        className="absolute w-full"
        style={{ [position]: 0 }}
        preserveAspectRatio="none"
      >
        <path fill={color} d={d}>
          <animate
            attributeName="d"
            dur="8s"
            repeatCount="indefinite"
            values={`${d};${position === "bottom"
              ? "M0,140 C120,200 240,100 360,160 C480,220 600,80 720,140 C840,200 960,60 1080,120 C1200,180 1320,40 1440,100 L1440,320 L0,320 Z"
              : "M0,180 C120,120 240,220 360,160 C480,100 600,200 720,140 C840,80 960,220 1080,160 C1200,100 1320,240 1440,180 L1440,0 L0,0 Z"
            };${d}`}
          />
        </path>
      </svg>
      <svg
        viewBox="0 0 1440 320"
        className="absolute w-full"
        style={{ [position]: 0 }}
        preserveAspectRatio="none"
      >
        <path fill={color} d="M0,200 C160,130 320,260 480,180 C640,100 800,230 960,160 C1120,90 1280,220 1440,140 L1440,320 L0,320 Z">
          <animate
            attributeName="d"
            dur="10s"
            repeatCount="indefinite"
            values="M0,200 C160,130 320,260 480,180 C640,100 800,230 960,160 C1120,90 1280,220 1440,140 L1440,320 L0,320 Z;M0,180 C160,250 320,120 480,200 C640,280 800,130 960,210 C1120,290 1280,120 1440,190 L1440,320 L0,320 Z;M0,200 C160,130 320,260 480,180 C640,100 800,230 960,160 C1120,90 1280,220 1440,140 L1440,320 L0,320 Z"
          />
        </path>
      </svg>
    </div>
  );
}