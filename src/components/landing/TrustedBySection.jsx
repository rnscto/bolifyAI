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

  // Double the list for seamless infinite scroll
  const doubled = [...clients, ...clients];

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
        <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-white to-transparent z-10 pointer-events-none" />
        {/* Right fade */}
        <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-white to-transparent z-10 pointer-events-none" />

        <div className="flex animate-marquee whitespace-nowrap">
          {doubled.map((client, i) => (
            <div
              key={`${client.id}-${i}`}
              className="flex-shrink-0 mx-8 flex items-center justify-center h-14 grayscale hover:grayscale-0 opacity-60 hover:opacity-100 transition-all duration-300"
            >
              <img
                src={client.logo_url}
                alt={client.name}
                className="h-10 max-w-[140px] object-contain"
                title={client.name}
              />
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-marquee {
          animation: marquee ${Math.max(clients.length * 4, 20)}s linear infinite;
        }
        .animate-marquee:hover {
          animation-play-state: paused;
        }
      `}</style>
    </section>
  );
}