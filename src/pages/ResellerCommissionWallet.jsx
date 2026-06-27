import React, { useState, useEffect } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { apiClient } from '@/api/apiClient';
import { Wallet, TrendingUp, IndianRupee, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export default function ResellerCommissionWallet() {
  const { user } = useAuth();
  const [clientRecord, setClientRecord] = useState(null);
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    try {
      setLoading(true);
      if (!user) return;

      // Fetch the reseller's client record to get wallet and commission balance
      const clientRes = await apiClient.Client.filter({ user_id: user.id });
      if (clientRes.length > 0) {
        setClientRecord(clientRes[0]);
      } else {
        const byEmail = await apiClient.Client.filter({ email: user.email });
        if (byEmail.length > 0) setClientRecord(byEmail[0]);
      }

      // Fetch the commission ledger entries
      const entries = await apiClient.CommissionLedger.filter(
        { to_reseller_id: user.id }, 
        '-created_at', 
        100
      );
      setLedgerEntries(entries);
    } catch (error) {
      console.error('Error fetching commission data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const walletBalance = clientRecord?.wallet_balance || 0;
  const commissionBalance = clientRecord?.commission_balance || 0;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Commission Wallet</h1>
          <p className="text-gray-500 mt-1">Manage your wholesale balance and retail commissions.</p>
        </div>
        <Button className="bg-blue-600 hover:bg-blue-700">Request Payout</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Wholesale Wallet Balance */}
        <Card className="border-blue-100 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center text-sm font-medium text-gray-500">
              <Wallet className="w-4 h-4 mr-2" />
              Wholesale Wallet Balance
            </CardDescription>
            <CardTitle className="text-3xl">₹{walletBalance.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-gray-500 mt-2">
              Used to purchase minutes and services at wholesale rates.
            </p>
          </CardContent>
        </Card>

        {/* Earned Commission */}
        <Card className="border-green-100 shadow-sm bg-green-50/30">
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center text-sm font-medium text-green-700">
              <TrendingUp className="w-4 h-4 mr-2" />
              Available Commission
            </CardDescription>
            <CardTitle className="text-3xl text-green-700">₹{commissionBalance.toLocaleString()}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-green-600/70 mt-2">
              Earnings from retail markups on sub-client usage.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Ledger Table */}
      <Card>
        <CardHeader>
          <CardTitle>Commission History</CardTitle>
          <CardDescription>Recent transactions and earned margins from your sub-clients.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledgerEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-gray-500">
                      No commission history found.
                    </TableCell>
                  </TableRow>
                ) : (
                  ledgerEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">
                        {new Date(entry.created_at).toLocaleDateString(undefined, { 
                          year: 'numeric', month: 'short', day: 'numeric', 
                          hour: '2-digit', minute: '2-digit'
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center">
                          {entry.type === 'payout' ? (
                            <ArrowDownCircle className="w-4 h-4 mr-2 text-red-500" />
                          ) : (
                            <ArrowUpCircle className="w-4 h-4 mr-2 text-green-500" />
                          )}
                          <span className="capitalize">{entry.type || 'Commission'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-gray-500">{entry.from_client_id || '—'}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          entry.status === 'completed' ? 'bg-green-100 text-green-800' :
                          entry.status === 'pending' ? 'bg-amber-100 text-amber-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {entry.status || 'completed'}
                        </span>
                      </TableCell>
                      <TableCell className={`text-right font-semibold ${entry.type === 'payout' ? 'text-red-600' : 'text-green-600'}`}>
                        {entry.type === 'payout' ? '-' : '+'}₹{(entry.amount || 0).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
