import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { motion } from 'framer-motion';

export default function TrustedBySection() {
  const { data: clients = [] } = useQuery({
    queryKey: ['trusted-clients-public'],
    queryFn: () => base44.entities.TrustedClient.filter({ is_active: true }, 'order', 100),
  });

  if (clients.length === 0) return null;

  // Repeat enough times to guarantee full-width coverage (minimum 10 items per row)
  const repeatCount = Math.max(Math.ceil(12 / clients.length), 3);
  const row = [];
  for (let r = 0; r < repeatCount; r++) {
    clients.forEach((c, i) => row.push({ ...c, _key: `${r}-${i}` }));
  }

  const duration = Math.max(clients.length * 5, 15);

  return (
    <section className="py-10 bg-white overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 mb-6">
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.3 }}
          className="text-center text-sm font-semibold text-gray-400 uppercase tracking-widest"
        >
          Trusted by Leading Businesses
        </motion.p>
      </div>

      <div className="relative">
        {/* Left fade */}
        <div className="absolute left-0 top-0 bottom-0 w-20 sm:w-32 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none" />
        {/* Right fade */}
        <div className="absolute right-0 top-0 bottom-0 w-20 sm:w-32 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none" />

        <div className="marquee-wrapper">
          <div className="marquee-track" style={{ '--duration': `${duration}s` }}>
            {/* First set */}
            <div className="marquee-content">
              {row.map((client) => (
                <div
                  key={`a-${client._key}`}
                  className="flex-shrink-0 mx-10 flex items-center justify-center h-16 grayscale hover:grayscale-0 opacity-50 hover:opacity-100 transition-all duration-300"
                >
                  <img
                    src={client.logo_url}
                    alt={client.name}
                    className="h-10 max-w-[150px] object-contain"
                    title={client.name}
                  />
                </div>
              ))}
            </div>
            {/* Duplicate set for seamless loop */}
            <div className="marquee-content" aria-hidden="true">
              {row.map((client) => (
                <div
                  key={`b-${client._key}`}
                  className="flex-shrink-0 mx-10 flex items-center justify-center h-16 grayscale hover:grayscale-0 opacity-50 hover:opacity-100 transition-all duration-300"
                >
                  <img
                    src={client.logo_url}
                    alt={client.name}
                    className="h-10 max-w-[150px] object-contain"
                    title={client.name}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .marquee-wrapper {
          overflow: hidden;
          width: 100%;
        }
        .marquee-track {
          display: flex;
          width: max-content;
          animation: scroll var(--duration) linear infinite;
        }
        .marquee-track:hover {
          animation-play-state: paused;
        }
        .marquee-content {
          display: flex;
          flex-shrink: 0;
        }
        @keyframes scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </section>
  );
}