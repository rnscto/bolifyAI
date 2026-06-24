import React from 'react';
import { motion } from 'framer-motion';
import { Shield, Clock, Headphones, IndianRupee } from 'lucide-react';

const items = [
  { icon: Shield, text: '7-Day Free Trial' },
  { icon: Clock, text: '24/7 AI Calling' },
  { icon: IndianRupee, text: 'No Per-Minute Charges' },
  { icon: Headphones, text: 'Hindi + English Support' },
];

export default function TrustStrip() {
  return (
    <section className="py-6 bg-[#fafbfc] border-y border-cyan-100">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex flex-wrap justify-center gap-6 lg:gap-12">
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <motion.div
                key={item.text}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05, duration: 0.25 }}
                className="flex items-center gap-2 text-sm font-medium text-gray-600"
              >
                <div className="w-8 h-8 rounded-full bg-[#00bcd4]/10 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-[#00bcd4]" />
                </div>
                {item.text}
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}