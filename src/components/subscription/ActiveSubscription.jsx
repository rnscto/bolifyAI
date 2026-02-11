import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CreditCard, Calendar, TrendingUp, Shield } from 'lucide-react';

export default function ActiveSubscription({ client, subscription }) {
  const statusColors = {
    active: 'bg-green-100 text-green-800',
    trial: 'bg-blue-100 text-blue-800',
    expired: 'bg-red-100 text-red-800',
    onboarding: 'bg-yellow-100 text-yellow-800',
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50">
                <CreditCard className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{client?.total_channels || 1}</p>
                <p className="text-sm text-gray-600">Active Channels</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50">
                <TrendingUp className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  ₹{((client?.total_channels || 1) * 6500).toLocaleString()}
                </p>
                <p className="text-sm text-gray-600">Monthly Rate</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-50">
                <Calendar className="w-6 h-6 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {subscription?.billing_end_date
                    ? new Date(subscription.billing_end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    : '-'}
                </p>
                <p className="text-sm text-gray-600">Next Billing</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Current Plan</CardTitle>
            <Badge className={statusColors[client?.account_status] || 'bg-gray-100'}>
              {client?.account_status || 'unknown'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between py-2 border-b">
            <span className="text-gray-600">Billing Cycle</span>
            <span className="font-medium">Quarterly</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b">
            <span className="text-gray-600">Rate per Channel</span>
            <span className="font-medium">₹6,500/month</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b">
            <span className="text-gray-600">Total Channels</span>
            <span className="font-medium">{client?.total_channels || 1}</span>
          </div>
          {client?.has_custom_crm && (
            <div className="flex items-center justify-between py-2 border-b">
              <span className="text-gray-600">CRM Add-on</span>
              <span className="font-medium">₹1,999/month</span>
            </div>
          )}
          <div className="flex items-center justify-between py-2 border-b">
            <span className="text-gray-600">Quarterly Total</span>
            <span className="font-medium text-lg">
              ₹{(((client?.total_channels || 1) * 6500 + (client?.has_custom_crm ? 1999 : 0)) * 3).toLocaleString()}
            </span>
          </div>
          {subscription?.billing_start_date && (
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-600">Current Period</span>
              <span className="font-medium">
                {new Date(subscription.billing_start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                {' → '}
                {new Date(subscription.billing_end_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}