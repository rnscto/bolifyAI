import React from 'react';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Rocket, Phone, Bot, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../../utils';

export default function OnboardingComplete({ agentName, didNumber }) {
  return (
    <div className="max-w-lg mx-auto text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', duration: 0.6 }}
        className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6"
      >
        <CheckCircle2 className="w-10 h-10 text-green-600" />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <h2 className="text-3xl font-bold text-gray-900 mb-2">You're All Set! 🎉</h2>
        <p className="text-gray-500 text-lg mb-8">
          Your 7-day free trial has started. Explore everything VaaniAI has to offer.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="bg-gray-50 rounded-2xl p-6 mb-8 text-left"
      >
        <h3 className="font-semibold text-gray-900 mb-4">What's been set up:</h3>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Bot className="w-5 h-5 text-blue-600" />
            <span className="text-sm text-gray-700">AI Agent "<strong>{agentName}</strong>" is ready</span>
          </div>
          {didNumber && (
            <div className="flex items-center gap-3">
              <Phone className="w-5 h-5 text-green-600" />
              <span className="text-sm text-gray-700">Phone number <strong>{didNumber}</strong> assigned</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Calendar className="w-5 h-5 text-orange-600" />
            <span className="text-sm text-gray-700">7-day free trial activated</span>
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.7 }}
        className="space-y-3"
      >
        <Link to={createPageUrl('ClientDashboard')}>
          <Button className="w-full bg-blue-600 hover:bg-blue-700 h-12 text-base">
            <Rocket className="w-4 h-4 mr-2" /> Go to Dashboard
          </Button>
        </Link>
        <Link to={createPageUrl('ClientKnowledgeBase')}>
          <Button variant="outline" className="w-full h-12">
            Upload Training Documents
          </Button>
        </Link>
      </motion.div>
    </div>
  );
}