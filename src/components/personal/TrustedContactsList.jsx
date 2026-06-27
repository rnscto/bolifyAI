import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { apiClient } from '@/api/apiClient';
import { UserPlus, Trash2, Users, Phone } from 'lucide-react';
import { toast } from 'sonner';
import ContactImporter from './ContactImporter';

const relationshipColors = {
  family: 'bg-green-100 text-green-800',
  friend: 'bg-blue-100 text-blue-800',
  colleague: 'bg-indigo-100 text-indigo-800',
  business: 'bg-orange-100 text-orange-800',
  other: 'bg-gray-100 text-gray-700'
};

export default function TrustedContactsList({ contacts, clientId, onRefresh }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', phone: '', relationship: 'other' });
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newContact.phone) return;
    setSaving(true);
    await apiClient.TrustedContact.create({
      client_id: clientId,
      name: newContact.name,
      phone: newContact.phone,
      relationship: newContact.relationship,
      always_connect: true
    });
    setSaving(false);
    setShowAdd(false);
    setNewContact({ name: '', phone: '', relationship: 'other' });
    toast.success('Contact added');
    onRefresh?.();
  };

  const handleDelete = async (id) => {
    await apiClient.TrustedContact.delete(id);
    toast.success('Contact removed');
    onRefresh?.();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg flex items-center gap-2">
          <Users className="w-5 h-5" />
          Trusted Contacts
        </CardTitle>
        <div className="flex gap-2">
          <ContactImporter clientId={clientId} onImported={onRefresh} />
          <Dialog open={showAdd} onOpenChange={setShowAdd}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1">
                <UserPlus className="w-4 h-4" /> Add
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Trusted Contact</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div>
                <Label>Name</Label>
                <Input
                  value={newContact.name}
                  onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                  placeholder="Contact name"
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Phone Number *</Label>
                <Input
                  value={newContact.phone}
                  onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                  placeholder="+91 9876543210"
                  className="mt-1"
                  required
                />
              </div>
              <div>
                <Label>Relationship</Label>
                <Select value={newContact.relationship} onValueChange={(v) => setNewContact({ ...newContact, relationship: v })}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="family">Family</SelectItem>
                    <SelectItem value="friend">Friend</SelectItem>
                    <SelectItem value="colleague">Colleague</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleAdd} disabled={saving || !newContact.phone} className="w-full">
                {saving ? 'Adding...' : 'Add Contact'}
              </Button>
            </div>
          </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {contacts.length === 0 ? (
          <div className="text-center py-6 text-gray-500">
            <Phone className="w-8 h-8 mx-auto mb-2 text-gray-600" />
            <p className="text-sm">No trusted contacts yet.</p>
            <p className="text-xs mt-1">Add contacts to auto-connect them without screening.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <div key={contact.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center text-sm font-medium text-gray-600">
                    {(contact.name || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{contact.name || contact.phone}</span>
                      <Badge className={relationshipColors[contact.relationship] || relationshipColors.other}>
                        {contact.relationship}
                      </Badge>
                    </div>
                    <span className="text-xs text-gray-500">{contact.phone}</span>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(contact.id)}>
                  <Trash2 className="w-4 h-4 text-gray-500 hover:text-red-500" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}