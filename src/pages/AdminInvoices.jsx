import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Plus, Send, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

const PREDEFINED_PRODUCTS = [
  { name: 'AI Voice Calling Bot - Starter Subscription', price: 4999 },
  { name: 'AI Voice Calling Bot - Pro Subscription', price: 9999 },
  { name: 'AI Voice Calling Bot - Enterprise Subscription', price: 19999 },
  { name: 'Custom Voice Clone Setup (One-time)', price: 14999 },
  { name: 'Additional Voice Minutes Top-up', price: 999 },
  { name: 'Software Services (SAC: 998314)', price: 0 },
  { name: 'Addition DID', price: 300 },
  { name: 'AI Agent to Human Agent Transfer Service (monthly)', price: 2000 },
  { name: 'Mobile DID (monthly)', price: 1500 },
  { name: 'Addition Agent Persona with Same Agent (monthly)', price: 1500 },
  { name: 'WhatsApp AI Chat bot Integrated with Voice Calling Agent (monthly)', price: 5000 },
  { name: 'Custom CRM Integrations API Expose Charges (One time)', price: 2000 }
];

export default function AdminInvoices() {
  const { user } = useAuth();
  const [invoices, setInvoices] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  
  // New invoice state
  const [selectedClientId, setSelectedClientId] = useState('');
  const [items, setItems] = useState([{ description: 'Software Services (SAC: 998314)', qty: 1, unit_price: 0 }]);
  const [sendEmail, setSendEmail] = useState(true);
  const [myClientInfo, setMyClientInfo] = useState(null);
  
  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    setLoading(true);
    try {
      let invQuery = {};
      let cliQuery = {};
      
      // If not master admin, restrict invoices and clients to downline
      if (user?.role !== 'master_admin') {
        invQuery = { biller_client_id: user?.client_id };
        cliQuery = { upline_id: user?.client_id };
      }
      
      const [invs, cls, me] = await Promise.all([
        apiClient.Invoice.filter(invQuery),
        apiClient.Client.filter(cliQuery),
        apiClient.Client.get(user?.client_id)
      ]);
      
      setInvoices(invs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      setClients(cls);
      setMyClientInfo(me);
    } catch (error) {
      console.error(error);
      toast.error('Failed to load invoices');
    }
    setLoading(false);
  };

  const handleCreateInvoice = async () => {
    if (!selectedClientId) return toast.error('Please select a client');
    
    // Calculate totals
    const clientInfo = clients.find(c => c.id === selectedClientId);
    
    let subtotal = 0;
    const finalItems = items.map(it => {
      const total = it.qty * it.unit_price;
      subtotal += total;
      return { ...it, total };
    });
    
    // Check if IGST or CGST/SGST (18% flat for software)
    const gstRate = 0.18;
    const gstAmount = subtotal * gstRate;
    const totalAmount = subtotal + gstAmount;

    setCreating(true);
    try {
      const res = await apiClient.functions.invoke('createCustomInvoice', {
        client_id: selectedClientId,
        subtotal,
        gst_amount: gstAmount,
        total_amount: totalAmount,
        items: finalItems,
        send_email: sendEmail
      });
      
      if (res.error) throw new Error(res.error);
      
      toast.success('Invoice generated successfully');
      setIsCreateOpen(false);
      
      // Reset form
      setItems([{ description: 'Software Services (SAC: 998314)', qty: 1, unit_price: 0 }]);
      setSelectedClientId('');
      loadData();
      
      // Trigger download if not sent via email (or even if it is)
      if (res.invoice_number) {
        toast.success(`Generated ${res.invoice_number}`);
      }
    } catch (error) {
      toast.error(error.message || 'Failed to generate invoice');
    }
    setCreating(false);
  };

  const addItem = () => {
    setItems([...items, { description: '', qty: 1, unit_price: 0 }]);
  };
  
  const updateItem = (index, field, value) => {
    const newItems = [...items];
    newItems[index][field] = field === 'description' ? value : Number(value);
    
    // Auto-fill price if a predefined product is selected
    if (field === 'description') {
      const preset = PREDEFINED_PRODUCTS.find(p => p.name === value);
      if (preset) {
        newItems[index].unit_price = preset.price;
      }
    }
    
    setItems(newItems);
  };
  
  const removeItem = (index) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const downloadPDF = async (invoiceId) => {
    try {
      toast.info('Downloading PDF...');
      const token = localStorage.getItem('bolifyai_token');
      const response = await fetch(`/api/functions/execute/downloadInvoice?id=${invoiceId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) throw new Error('Failed to download PDF');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Get filename from header if possible, or fallback
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `invoice-${invoiceId}.pdf`;
      if (contentDisposition && contentDisposition.includes('filename=')) {
        filename = contentDisposition.split('filename=')[1].replace(/"/g, '');
      }
      
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      toast.success('Download complete');
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download invoice PDF');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Invoices</h1>
          <p className="text-gray-500">Manage and generate billing invoices</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="bg-blue-600 hover:bg-blue-700">
          <Plus className="w-4 h-4 mr-2" /> New Invoice
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-blue-600" />
                  </TableCell>
                </TableRow>
              ) : invoices.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10 text-gray-500">
                    No invoices generated yet.
                  </TableCell>
                </TableRow>
              ) : (
                invoices.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.invoice_number}</TableCell>
                    <TableCell>{new Date(inv.issue_date).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {clients.find(c => c.id === inv.client_id)?.company_name || 'Unknown Client'}
                    </TableCell>
                    <TableCell>₹{Number(inv.total_amount).toLocaleString('en-IN')}</TableCell>
                    <TableCell>
                      <Badge className={
                        inv.status === 'paid' ? 'bg-green-100 text-green-800' :
                        inv.status === 'sent' ? 'bg-blue-100 text-blue-800' :
                        'bg-gray-100 text-gray-800'
                      }>
                        {inv.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => downloadPDF(inv.id)}>
                        <Download className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Generate Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            
            {(!myClientInfo?.billing_name || !myClientInfo?.gstin) && (
              <div className="bg-yellow-50 text-yellow-800 p-3 rounded-md text-sm">
                Warning: You have not fully configured your Billing & GST information in Settings.
              </div>
            )}
            
            <div className="space-y-2">
              <Label>Select Client</Label>
              <select 
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(e.target.value)}
              >
                <option value="">-- Select Client --</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.company_name} ({c.email})</option>
                ))}
              </select>
            </div>

            <div>
              <Label>Line Items</Label>
              <div className="space-y-3 mt-2">
                {items.map((item, index) => (
                  <div key={index} className="flex gap-2 items-center">
                    <Input 
                      placeholder="Description" 
                      list="product-presets"
                      value={item.description}
                      onChange={(e) => updateItem(index, 'description', e.target.value)}
                      className="flex-1"
                    />
                    <Input 
                      type="number" 
                      placeholder="Qty" 
                      value={item.qty}
                      onChange={(e) => updateItem(index, 'qty', e.target.value)}
                      className="w-24"
                    />
                    <Input 
                      type="number" 
                      placeholder="Unit Price" 
                      value={item.unit_price}
                      onChange={(e) => updateItem(index, 'unit_price', e.target.value)}
                      className="w-32"
                    />
                    <div className="w-24 font-medium text-right">
                      ₹{Number(item.qty * item.unit_price).toLocaleString()}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => removeItem(index)} className="text-red-500">X</Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addItem}><Plus className="w-4 h-4 mr-2" /> Add Item</Button>
                
                <datalist id="product-presets">
                  {PREDEFINED_PRODUCTS.map((prod, i) => (
                    <option key={i} value={prod.name} />
                  ))}
                </datalist>
              </div>
            </div>
            
            <div className="border-t pt-4">
              <div className="flex justify-between items-center mb-4">
                <span className="text-sm font-medium">Send Email Automatically</span>
                <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} className="h-4 w-4 rounded border-gray-300" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateInvoice} disabled={creating || !selectedClientId} className="bg-blue-600 hover:bg-blue-700">
              {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              Generate & Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
