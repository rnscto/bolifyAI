import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check, Minus, Plus } from 'lucide-react';

export default function PlanSelector({ channels, setChannels, includeCRM, setIncludeCRM, onSubscribe, loading }) {
  const ratePerChannel = 6500;
  const crmRate = 1999;
  const months = 3;

  const channelTotal = channels * ratePerChannel * months;
  const crmTotal = includeCRM ? crmRate * months : 0;
  const grandTotal = channelTotal + crmTotal;

  return (
    <div className="space-y-6">
      {/* Voice AI Channel Plan */}
      <Card className="border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-white">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-xl">Voice AI Agent</CardTitle>
              <p className="text-sm text-gray-600 mt-1">AI-powered voice calling with DID number</p>
            </div>
            <Badge className="bg-blue-100 text-blue-800">Quarterly Billing</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-3xl font-bold text-gray-900">₹{ratePerChannel.toLocaleString()}</p>
              <p className="text-sm text-gray-500">per channel / month</p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => setChannels(Math.max(1, channels - 1))}
                disabled={channels <= 1}
              >
                <Minus className="w-4 h-4" />
              </Button>
              <span className="text-2xl font-bold w-8 text-center">{channels}</span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setChannels(channels + 1)}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              'AI Voice Agent',
              'Dedicated DID Number',
              'Lead Management',
              'Call Transcripts',
              'Knowledge Base',
              'Call Analytics',
            ].map((feature) => (
              <div key={feature} className="flex items-center gap-2 text-sm text-gray-700">
                <Check className="w-4 h-4 text-green-600 shrink-0" />
                {feature}
              </div>
            ))}
          </div>

          <div className="bg-blue-100/50 rounded-lg p-3 flex justify-between items-center">
            <span className="text-sm font-medium text-gray-700">
              {channels} channel(s) × ₹{ratePerChannel.toLocaleString()} × {months} months
            </span>
            <span className="text-lg font-bold text-gray-900">₹{channelTotal.toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      {/* CRM Add-on */}
      <Card className={`border-2 transition-colors cursor-pointer ${includeCRM ? 'border-indigo-300 bg-indigo-50/30' : 'border-gray-200'}`}
        onClick={() => setIncludeCRM(!includeCRM)}
      >
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                includeCRM ? 'bg-indigo-600 border-indigo-600' : 'border-gray-300'
              }`}>
                {includeCRM && <Check className="w-3 h-3 text-white" />}
              </div>
              <div>
                <p className="font-semibold text-gray-900">Custom Sales CRM</p>
                <p className="text-sm text-gray-500">Industry-specific pipeline, deals & contacts</p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold text-gray-900">₹{crmRate.toLocaleString()}</p>
              <p className="text-xs text-gray-500">/month</p>
            </div>
          </div>
          {includeCRM && (
            <div className="mt-3 ml-9 bg-indigo-100/50 rounded-lg p-3 flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700">CRM × {months} months</span>
              <span className="text-lg font-bold text-gray-900">₹{crmTotal.toLocaleString()}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Total & Pay */}
      <Card className="bg-gray-900 text-white">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm text-gray-400">Total (Quarterly)</p>
              <p className="text-3xl font-bold">₹{grandTotal.toLocaleString()}</p>
            </div>
            <div className="text-right text-sm text-gray-400">
              <p>≈ ₹{Math.round(grandTotal / months).toLocaleString()}/month</p>
            </div>
          </div>
          <Button
            className="w-full bg-gradient-to-r from-[#e67e22] to-[#f39c12] hover:from-[#d35400] hover:to-[#e67e22] text-white font-semibold h-12 text-base"
            onClick={onSubscribe}
            disabled={loading}
          >
            {loading ? 'Processing...' : `Pay ₹${grandTotal.toLocaleString()} & Subscribe`}
          </Button>
          <p className="text-xs text-gray-500 text-center mt-2">
            Secure payment powered by Cashfree
          </p>
        </CardContent>
      </Card>
    </div>
  );
}