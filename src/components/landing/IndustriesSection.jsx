import React from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Building2, Car, Home, Heart, ShieldCheck, ShoppingCart,
  Dumbbell, UtensilsCrossed, Plane, Scale, Laptop, Landmark,
  Package, Gem, Truck, Paintbrush, Scissors, Wheat, Sun, Users
} from 'lucide-react';
import { motion } from 'framer-motion';

const industries = [
  { name: 'Real Estate', icon: Home },
  { name: 'Automobile', icon: Car },
  { name: 'Healthcare', icon: Heart },
  { name: 'Insurance', icon: ShieldCheck },
  { name: 'Education', icon: Building2 },
  { name: 'E-Commerce', icon: ShoppingCart },
  { name: 'Gym & Fitness', icon: Dumbbell },
  { name: 'Restaurant', icon: UtensilsCrossed },
  { name: 'Travel', icon: Plane },
  { name: 'Legal', icon: Scale },
  { name: 'IT / SaaS', icon: Laptop },
  { name: 'Banking', icon: Landmark },
  { name: 'Manufacturing', icon: Package },
  { name: 'Jewelry', icon: Gem },
  { name: 'Logistics', icon: Truck },
  { name: 'Interior Design', icon: Paintbrush },
  { name: 'Beauty & Salon', icon: Scissors },
  { name: 'Agriculture', icon: Wheat },
  { name: 'Solar Energy', icon: Sun },
  { name: 'Staffing', icon: Users },
];

export default function IndustriesSection() {
  return (
    <section className="py-24 bg-[#fafbfc]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#138808]/10 text-[#138808] text-sm font-semibold mb-4">
            Industries
          </div>
          <h2 className="text-4xl font-bold text-gray-900 mb-4">AI Voice Agents & CRM for Every Industry</h2>
          <p className="text-lg text-gray-500 max-w-2xl mx-auto">
            Pre-configured AI calling bots and CRM templates with industry-specific deal stages, lead sources, and sales automation for Indian businesses.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-3">
          {industries.map((industry, i) => {
            const Icon = industry.icon;
            return (
              <motion.div
                key={industry.name}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.03 }}
              >
                <Badge
                  variant="outline"
                  className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium bg-white hover:bg-[#1a365d]/5 hover:border-[#1a365d]/30 transition-all cursor-default shadow-sm"
                >
                  <Icon className="w-4 h-4 text-[#e67e22]" />
                  {industry.name}
                </Badge>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}