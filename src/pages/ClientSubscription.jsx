import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CreditCard, Calendar, TrendingUp } from 'lucide-react';

export default function ClientSubscription() {
  const [subscription, setSubscription] = useState(null);
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const user = await base44.auth.me();
      const clients = await base44.entities.Client.filter({ user_id: user.id });
      
      if (clients.length > 0) {
        const clientData = clients[0];
        setClient(clientData);

        const subscriptions = await base44.entities.Subscription.filter({
          client_id: clientData.id
        });
        
        if (subscriptions.length > 0) {
          setSubscription(subscriptions[0]);
        }
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Subscription</h1>
        <p className="text-gray-600 mt-1">Manage your billing and subscription</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <CreditCard className="w-8 h-8 text-blue-600" />
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
              <TrendingUp className="w-8 h-8 text-green-600" />
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
              <Calendar className="w-8 h-8 text-orange-600" />
              <div>
                <p className="text-2xl font-bold">
                  {client?.next_billing_date ? 
                    new Date(client.next_billing_date).toLocaleDateString() : '-'}
                </p>
                <p className="text-sm text-gray-600">Next Billing</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current Plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b">
            <span className="text-gray-600">Billing Cycle</span>
            <span className="font-medium">Quarterly</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b">
            <span className="text-gray-600">Rate per Channel</span>
            <span className="font-medium">₹6,500/month</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b">
            <span className="text-gray-600">Total Channels</span>
            <span className="font-medium">{client?.total_channels || 1}</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b">
            <span className="text-gray-600">Quarterly Total</span>
            <span className="font-medium text-lg">
              ₹{((client?.total_channels || 1) * 6500 * 3).toLocaleString()}
            </span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-gray-600">Status</span>
            <Badge className="bg-green-100 text-green-800">
              {client?.status || 'Active'}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-500">No billing history available yet</p>
        </CardContent>
      </Card>
    </div>
  );
}