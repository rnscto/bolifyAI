import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Building2, Heart, GraduationCap, Home, Car, Dumbbell,
  ShoppingBag, Scale, Plane, Utensils, Briefcase, ArrowRight, ArrowLeft, Laptop
} from 'lucide-react';
import { motion } from 'framer-motion';

const industries = [
  { name: 'Real Estate', icon: Home },
  { name: 'Healthcare', icon: Heart },
  { name: 'Education', icon: GraduationCap },
  { name: 'Automotive', icon: Car },
  { name: 'Fitness & Gym', icon: Dumbbell },
  { name: 'E-Commerce', icon: ShoppingBag },
  { name: 'Legal', icon: Scale },
  { name: 'Travel & Tourism', icon: Plane },
  { name: 'Restaurant & Food', icon: Utensils },
  { name: 'SaaS & Tech', icon: Laptop },
  { name: 'Financial Services', icon: Briefcase },
  { name: 'Other', icon: Building2 },
];

export default function IndustryStep({ selected, onSelect, onNext, onBack }) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-green-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Building2 className="w-8 h-8 text-green-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Select Your Industry</h2>
        <p className="text-gray-500 mt-2">We'll pre-configure your AI agent with industry-specific knowledge</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {industries.map((ind, i) => {
          const Icon = ind.icon;
          const isSelected = selected === ind.name;
          return (
            <motion.button
              key={ind.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              onClick={() => onSelect(ind.name)}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all text-sm font-medium ${
                isSelected
                  ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-md'
                  : 'border-gray-200 hover:border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Icon className={`w-6 h-6 ${isSelected ? 'text-blue-600' : 'text-gray-400'}`} />
              {ind.name}
            </motion.button>
          );
        })}
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack} className="flex-1 h-12">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <Button
          onClick={onNext}
          disabled={!selected}
          className="flex-1 bg-blue-600 hover:bg-blue-700 h-12 text-base"
        >
          Continue <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}