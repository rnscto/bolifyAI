import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Download, FileText } from 'lucide-react';
import moment from 'moment';

function downloadCSV(data, filename) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const csv = [
    headers.join(','),
    ...data.map(row => headers.map(h => {
      const val = row[h] ?? '';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    }).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminPartnerExport({ partners, referrals, payouts }) {
  const exportPartners = () => {
    const rows = partners.map(p => ({
      Name: p.name,
      Email: p.email,
      Phone: p.phone,
      Company: p.company_name || '',
      Status: p.status,
      Referral_Code: p.referral_code,
      Commission_Rate: p.commission_rate,
      Total_Referrals: p.total_referrals || 0,
      Total_Earned: p.total_earned || 0,
      Total_Paid: p.total_paid || 0,
      Pending_Payout: p.pending_payout || 0,
      City: p.city || '',
      State: p.state || '',
      Joined: p.created_at ? moment(p.created_at).format('YYYY-MM-DD') : '',
    }));
    downloadCSV(rows, `partners_${moment().format('YYYYMMDD')}.csv`);
  };

  const exportReferrals = () => {
    const partnerMap = {};
    partners.forEach(p => { partnerMap[p.id] = p.name; });
    const rows = referrals.map(r => ({
      Client_Name: r.client_name || '',
      Client_Email: r.client_email || '',
      Partner: partnerMap[r.partner_id] || '',
      Code_Used: r.referral_code_used || '',
      Status: r.status,
      Plan_Amount: r.client_plan_amount || 0,
      Commission_Earned: r.total_commission_earned || 0,
      Signup_Date: r.signup_date ? moment(r.signup_date).format('YYYY-MM-DD') : '',
    }));
    downloadCSV(rows, `referrals_${moment().format('YYYYMMDD')}.csv`);
  };

  const exportPayouts = () => {
    const rows = payouts.map(p => ({
      Invoice: p.invoice_number || '',
      Partner: p.partner_name || '',
      Amount: p.amount || 0,
      TDS: p.tds_amount || 0,
      Net: p.net_amount || 0,
      Status: p.status,
      Method: p.payment_method || '',
      Paid_Date: p.paid_date ? moment(p.paid_date).format('YYYY-MM-DD') : '',
    }));
    downloadCSV(rows, `payouts_${moment().format('YYYYMMDD')}.csv`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-1" /> Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={exportPartners}>
          <FileText className="w-4 h-4 mr-2" /> Partners CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportReferrals}>
          <FileText className="w-4 h-4 mr-2" /> Referrals CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportPayouts}>
          <FileText className="w-4 h-4 mr-2" /> Payouts CSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}