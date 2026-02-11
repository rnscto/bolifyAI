import React from 'react';
import { motion } from 'framer-motion';

export default function PulseRings({ className = "", color = "#FF9933", size = 200, rings = 3 }) {
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {Array.from({ length: rings }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute inset-0 rounded-full border"
          style={{ borderColor: color }}
          animate={{
            scale: [1, 1.8 + i * 0.3],
            opacity: [0.4, 0],
          }}
          transition={{
            duration: 2.5 + i * 0.5,
            repeat: Infinity,
            ease: "easeOut",
            delay: i * 0.6,
          }}
        />
      ))}
      <div
        className="absolute inset-0 m-auto rounded-full"
        style={{
          width: size * 0.3,
          height: size * 0.3,
          backgroundColor: color,
          opacity: 0.15,
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
}