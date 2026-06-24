import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Sparkles, ArrowRight, Check, Zap } from 'lucide-react';

export default function BuildCRMCard({ onGetStarted, trialDaysLeft, crmStatus }) {
  if (crmStatus === 'active') {
    return null;
  }

  if (crmStatus === 'trialing') {
    return (
      <Card className="border-2 border-amber-200 bg-gradient-to-r from-amber-50 to-orange-50 overflow-hidden">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                <Zap className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="font-semibold text-amber-900">CRM Trial Active</p>
                <p className="text-sm text-amber-700">
                  {trialDaysLeft > 0
                    ? `${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''} remaining in your free trial`
                    : 'Your trial has expired'}
                </p>
              </div>
            </div>
            {trialDaysLeft <= 0 && (
              <Button className="bg-amber-600 hover:bg-amber-700 text-white">
                Subscribe Now — ₹1,999/mo
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden border-0 shadow-xl">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500" />
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wNSI+PHBhdGggZD0iTTM2IDE4YzMuMzE0IDAgNi0yLjY4NiA2LTZzLTIuNjg2LTYtNi02LTYgMi42ODYtNiA2IDIuNjg2IDYgNiA2em0tMjQgMjRjMy4zMTQgMCA2LTIuNjg2IDYtNnMtMi42ODYtNi02LTYtNiAyLjY4Ni02IDYgMi42ODYgNiA2IDZ6Ii8+PC9nPjwvZz48L3N2Zz4=')] opacity-30" />

      <CardContent className="relative p-8 md:p-10">
        <div className="flex flex-col md:flex-row items-start md:items-center gap-8">
          {/* Left content */}
          <div className="flex-1 space-y-4">
            <div className="flex items-center gap-2">
              <Badge className="bg-white/20 text-white border-0 px-3 py-1 text-xs font-semibold tracking-wide">
                NEW
              </Badge>
              <Badge className="bg-white/20 text-white border-0 px-3 py-1 text-xs font-semibold">
                7-DAY FREE TRIAL
              </Badge>
            </div>

            <div className="space-y-2">
              <h2 className="text-3xl md:text-4xl font-extrabold text-white leading-tight">
                Build your CRM with
                <span className="block bg-clip-text text-transparent bg-gradient-to-r from-yellow-200 to-pink-200">
                  Bolify AI
                </span>
              </h2>
              <p className="text-lg text-indigo-100 max-w-md">
                Industry-specific sales CRM powered by AI voice agents. Setup in 2 minutes.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 max-w-md">
              {[
                'AI Sales Pipeline',
                'Auto Follow-ups',
                'Smart Lead Scoring',
                'Voice AI Calling',
                'Custom Fields',
                'Sales Reports'
              ].map((feature) => (
                <div key={feature} className="flex items-center gap-2">
                  <Check className="w-4 h-4 text-green-300 flex-shrink-0" />
                  <span className="text-sm text-white/90">{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Right CTA */}
          <div className="flex flex-col items-center gap-4 bg-white/10 backdrop-blur-sm rounded-2xl p-6 border border-white/20 min-w-[240px]">
            <div className="flex items-center gap-2">
              <Bot className="w-8 h-8 text-white" />
              <Sparkles className="w-6 h-6 text-yellow-300 animate-pulse" />
            </div>
            <div className="text-center">
              <p className="text-white/70 text-sm">Starting at just</p>
              <div className="flex items-baseline justify-center gap-1">
                <span className="text-4xl font-extrabold text-white">₹1,999</span>
                <span className="text-white/70 text-sm">/month</span>
              </div>
              <p className="text-xs text-white/60 mt-1">After 7-day free trial</p>
            </div>
            <Button
              onClick={onGetStarted}
              size="lg"
              className="w-full bg-white text-indigo-700 hover:bg-indigo-50 font-bold text-base shadow-lg group"
            >
              Get Started Free
              <ArrowRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
            </Button>
            <p className="text-xs text-white/50">No credit card required</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}