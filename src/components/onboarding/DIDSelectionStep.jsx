import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Button } from '@/components/ui/button';
import { Phone, ArrowLeft, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

export default function DIDSelectionStep({ selected, onSelect, onNext, onBack }) {
  const [dids, setDids] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDIDs();
  }, []);

  const loadDIDs = async () => {
    // Show demo pool DIDs for trial onboarding (shared, round-robin)
    const demoDIDs = await apiClient.DID.filter({ is_demo: true });
    if (demoDIDs.length > 0) {
      setDids(demoDIDs);
    } else {
      // Fallback to available DIDs if no demo pool set up
      const available = await apiClient.DID.filter({ status: 'available' });
      setDids(available);
    }
    setLoading(false);
  };

  return (
    <div className="max-w-lg mx-auto">
      <div className="text-center mb-8">
        <div className="w-16 h-16 bg-orange-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Phone className="w-8 h-8 text-orange-600" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900">Choose a Phone Number</h2>
        <p className="text-gray-500 mt-2">Select a DID (phone number) for your AI agent to make and receive calls</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : dids.length === 0 ? (
        <div className="text-center py-8 bg-yellow-50 border border-yellow-200 rounded-xl">
          <Phone className="w-10 h-10 text-yellow-500 mx-auto mb-3" />
          <p className="text-yellow-800 font-medium">No phone numbers available right now</p>
          <p className="text-yellow-600 text-sm mt-1">You can skip this step and a number will be assigned later</p>
        </div>
      ) : (
        <div className="space-y-3 mb-8">
          {dids.map((did, i) => (
            <motion.button
              key={did.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              onClick={() => onSelect(did)}
              className={`w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all ${
                selected?.id === did.id
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <Phone className={`w-5 h-5 ${selected?.id === did.id ? 'text-blue-600' : 'text-gray-400'}`} />
                <div className="text-left">
                  <p className="font-semibold text-gray-900">{did.country_code || '+91'} {did.number}</p>
                  <p className="text-xs text-gray-500">{did.is_demo ? 'Shared Demo DID • Free during trial' : 'Trial DID • Free for 7 days'}</p>
                </div>
              </div>
              {selected?.id === did.id && (
                <CheckCircle2 className="w-5 h-5 text-blue-600" />
              )}
            </motion.button>
          ))}
        </div>
      )}

      <div className="flex gap-3 mt-6">
        <Button variant="outline" onClick={onBack} className="flex-1 h-12">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
        <Button
          onClick={onNext}
          className="flex-1 bg-blue-600 hover:bg-blue-700 h-12 text-base"
        >
          {selected ? 'Continue' : 'Skip for Now'} <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}