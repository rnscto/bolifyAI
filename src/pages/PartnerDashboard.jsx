import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Loader2, AlertCircle } from 'lucide-react';
import PartnerStats from '../components/partner/PartnerStats';
import ReferralCodeCard from '../components/partner/ReferralCodeCard';
import ReferralsList from '../components/partner/ReferralsList';
import PayoutHistory from '../components/partner/PayoutHistory';
import PartnerProfileEditor from '../components/partner/PartnerProfileEditor';
import PartnerClientsList from '../components/partner/PartnerClientsList';
import PartnerComplianceTab from '../components/compliance/PartnerComplianceTab';

export default function PartnerDashboard() {
  const [partner, setPartner] = useState(null);
  const [referrals, setReferrals] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const currentUser = await base44.auth.me();
    setUser(currentUser);

    const partners = await base44.entities.Partner.filter({ email: currentUser.email });
    if (partners.length > 0) {
      const p = partners[0];
      setPartner(p);

      const [refs, pays] = await Promise.all([
        base44.entities.Referral.filter({ partner_id: p.id }, '-created_date'),
        base44.entities.PartnerPayout.filter({ partner_id: p.id }, '-created_date'),
      ]);
      setReferrals(refs);
      setPayouts(pays);
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!partner) {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <Card>
          <CardContent className="pt-8 pb-8">
            <AlertCircle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">No Partner Account Found</h2>
            <p className="text-gray-600 mb-4">Your email ({user?.email}) is not linked to a partner account. Please apply via the Partner Signup page.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (partner.status === 'pending') {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <Card>
          <CardContent className="pt-8 pb-8">
            <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Loader2 className="w-8 h-8 text-yellow-600" />
            </div>
            <h2 className="text-xl font-bold mb-2">Application Under Review</h2>
            <p className="text-gray-600 mb-3">Your partner application is being reviewed by our team. You'll be notified once approved.</p>
            <Badge className="bg-yellow-100 text-yellow-800">Pending Approval</Badge>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (partner.status === 'suspended' || partner.status === 'rejected') {
    return (
      <div className="max-w-lg mx-auto mt-16 text-center">
        <Card>
          <CardContent className="pt-8 pb-8">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold mb-2">Account {partner.status === 'rejected' ? 'Rejected' : 'Suspended'}</h2>
            <p className="text-gray-600">Please contact support for more information.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Partner Dashboard</h1>
          <p className="text-gray-500 text-sm">Welcome back, {partner.name}</p>
        </div>
        <Badge className="bg-green-100 text-green-800 w-fit">Active Partner</Badge>
      </div>

      <PartnerStats partner={partner} />

      <Tabs defaultValue="overview">
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="clients">My Clients ({referrals.filter(r => r.client_id).length})</TabsTrigger>
          <TabsTrigger value="referrals">Referrals ({referrals.length})</TabsTrigger>
          <TabsTrigger value="payouts">Payouts ({payouts.length})</TabsTrigger>
          <TabsTrigger value="compliance">Compliance</TabsTrigger>
          <TabsTrigger value="profile">Profile & Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              <ReferralCodeCard partner={partner} />
            </div>
            <div className="lg:col-span-2">
              <ReferralsList referrals={referrals} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="clients">
          <PartnerClientsList referrals={referrals} />
        </TabsContent>

        <TabsContent value="referrals">
          <ReferralsList referrals={referrals} />
        </TabsContent>

        <TabsContent value="payouts">
          <PayoutHistory payouts={payouts} />
        </TabsContent>

        <TabsContent value="compliance">
          <PartnerComplianceTab partner={partner} referrals={referrals} />
        </TabsContent>

        <TabsContent value="profile">
          <PartnerProfileEditor partner={partner} onSaved={loadData} />
        </TabsContent>
      </Tabs>
    </div>
  );
}