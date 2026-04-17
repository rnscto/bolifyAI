import React from 'react';
import { Button } from '@/components/ui/button';
import { Building2, User, ArrowRight, Briefcase, Shield, Phone, Calendar, Brain, MessageSquare } from 'lucide-react';
import { motion } from 'framer-motion';

const accountTypes = [
  {
    type: 'business',
    icon: Building2,
    title: 'Business',
    subtitle: 'AI Sales & Support Agent',
    description: 'Automate outbound sales calls, qualify leads, manage CRM, and close deals 24/7.',
    features: ['AI outbound calling campaigns', 'Lead scoring & CRM', 'Sales pipeline automation', 'Team analytics'],
    color: 'from-[#1a365d] to-[#2a4a7f]',
    borderColor: 'border-blue-500',
    bgColor: 'bg-blue-50',
    iconColor: 'text-blue-600',
  },
  {
    type: 'personal',
    icon: User,
    title: 'Personal',
    subtitle: 'AI Personal Call Assistant',
    description: 'Your AI handles all incoming calls — screens spam, takes messages, and transfers important calls to you.',
    features: ['AI answers your calls', 'Real-time call notifications', 'Smart call classification', 'Meeting scheduling'],
    color: 'from-[#7c3aed] to-[#a855f7]',
    borderColor: 'border-purple-500',
    bgColor: 'bg-purple-50',
    iconColor: 'text-purple-600',
  },
];

export default function AccountTypeStep({ selected, onSelect, onNext }) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-gradient-to-br from-orange-100 to-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Brain className="w-8 h-8 text-[#e67e22]" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">How will you use Bolify AI?</h2>
        <p className="text-gray-500 mt-2">Choose your account type to get a personalized experience</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        {accountTypes.map((acc, i) => {
          const Icon = acc.icon;
          const isSelected = selected === acc.type;
          return (
            <motion.button
              key={acc.type}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              onClick={() => onSelect(acc.type)}
              className={`relative text-left p-5 rounded-2xl border-2 transition-all ${
                isSelected
                  ? `${acc.borderColor} ${acc.bgColor} shadow-lg`
                  : 'border-gray-200 hover:border-gray-300 bg-white hover:shadow-md'
              }`}
            >
              {isSelected && (
                <div className={`absolute top-3 right-3 w-6 h-6 rounded-full bg-gradient-to-r ${acc.color} flex items-center justify-center`}>
                  <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
              
              <div className={`w-12 h-12 rounded-xl ${acc.bgColor} flex items-center justify-center mb-3`}>
                <Icon className={`w-6 h-6 ${acc.iconColor}`} />
              </div>
              
              <h3 className="text-lg font-bold text-gray-900">{acc.title}</h3>
              <p className={`text-sm font-semibold mb-2 ${isSelected ? acc.iconColor : 'text-gray-500'}`}>{acc.subtitle}</p>
              <p className="text-sm text-gray-500 mb-3">{acc.description}</p>
              
              <ul className="space-y-1.5">
                {acc.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-xs text-gray-600">
                    <div className={`w-1.5 h-1.5 rounded-full ${isSelected ? `bg-gradient-to-r ${acc.color}` : 'bg-gray-300'}`} />
                    {f}
                  </li>
                ))}
              </ul>
            </motion.button>
          );
        })}
      </div>

      <Button
        onClick={onNext}
        disabled={!selected}
        className="w-full bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white h-12 text-base font-semibold rounded-xl"
      >
        Continue <ArrowRight className="w-4 h-4 ml-2" />
      </Button>
    </div>
  );
}