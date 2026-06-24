import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import {
  GraduationCap, Car, Building2, Heart, Shield, ShoppingCart,
  Dumbbell, UtensilsCrossed, Plane, Scale, Monitor, Landmark,
  ShoppingBag, PartyPopper, Factory, Truck, Paintbrush, Sparkles,
  Users, Sun, Leaf, Gem
} from 'lucide-react';

const ICON_MAP = {
  GraduationCap, Car, Building2, Heart, Shield, ShoppingCart,
  Dumbbell, UtensilsCrossed, Plane, Scale, Monitor, Landmark,
  ShoppingBag, PartyPopper, Factory, Truck, Paintbrush, Sparkles,
  Users, Sun, Leaf, Gem
};

const COLORS = [
  'from-blue-500 to-indigo-600',
  'from-red-500 to-orange-600',
  'from-emerald-500 to-teal-600',
  'from-pink-500 to-rose-600',
  'from-cyan-500 to-blue-600',
  'from-amber-500 to-yellow-600',
  'from-purple-500 to-violet-600',
  'from-green-500 to-emerald-600',
  'from-indigo-500 to-blue-600',
  'from-rose-500 to-pink-600',
  'from-teal-500 to-cyan-600',
  'from-orange-500 to-red-600'
];

export default function IndustrySelector({ templates, selectedId, onSelect }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
      {templates.map((template, idx) => {
        const IconComp = ICON_MAP[template.icon] || Monitor;
        const isSelected = selectedId === template.id;
        const color = COLORS[idx % COLORS.length];

        return (
          <Card
            key={template.id}
            onClick={() => onSelect(template)}
            className={`cursor-pointer transition-all duration-200 hover:shadow-lg hover:-translate-y-1 ${
              isSelected
                ? 'ring-2 ring-indigo-500 shadow-lg border-indigo-300'
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <CardContent className="p-4 flex flex-col items-center text-center gap-3">
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center shadow-md`}>
                <IconComp className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="font-semibold text-sm text-gray-900">{template.name}</p>
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{template.description}</p>
              </div>
              {isSelected && (
                <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}