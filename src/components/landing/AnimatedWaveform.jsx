import React from 'react';
import { motion } from 'framer-motion';

export default function AnimatedWaveform({ className = "", barCount = 20, color = "rgba(255,153,51,0.6)", height = 60 }) {
  return (
    <div className={`flex items-center gap-[3px] ${className}`} style={{ height }}>
      {Array.from({ length: barCount }).map((_, i) => (
        <motion.div
          key={i}
          className="rounded-full"
          style={{
            width: 3,
            backgroundColor: color,
            originY: 0.5,
          }}
          animate={{
            height: [
              Math.random() * height * 0.3 + 4,
              Math.random() * height * 0.9 + 8,
              Math.random() * height * 0.3 + 4,
            ],
          }}
          transition={{
            duration: 1.2 + Math.random() * 0.8,
            repeat: Infinity,
            ease: "easeInOut",
            delay: i * 0.05,
          }}
        />
      ))}
    </div>
  );
}