import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Globe, Users, UserPlus, Mic, Mail, Phone, Calendar, Tag, Eye, ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import moment from 'moment';

const intentColors = {
  exploring: 'bg-gray-100 text-gray-700',
  comparing: 'bg-blue-100 text-blue-700',
  ready_to_buy: 'bg-green-100 text-green-700',
  curious: 'bg-purple-100 text-purple-700',
};

const sentimentColors = {
  positive: 'bg-green-100 text-green-700',
  neutral: 'bg-gray-100 text-gray-700',
  skeptical: 'bg-yellow-100 text-yellow-700',
  negative: 'bg-red-100 text-red-700',
};

const statusColors = {
  new: 'bg-blue-100 text-blue-700',
  contacted: 'bg-indigo-100 text-indigo-700',
  interested: 'bg-green-100 text-green-700',
  not_interested: 'bg-red-100 text-red-700',
  callback: 'bg-yellow-100 text-yellow-700',
  converted: 'bg-emerald-100 text-emerald-700',
  do_not_call: 'bg-gray-100 text-gray-500',
};

export default function WebsiteLeadsSection() {
  const [leads, setLeads] = useState([]);
  const [trialClients, setTrialClients] = useState([]);
  const [signedUpUsers, setSignedUpUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedLead, setExpandedLead] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('voice_leads');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const [allLeads, clients] = await Promise.all([
      base44.entities.Lead.filter({ source: 'website_voice_agent' }, '-created_date', 50),
      base44.entities.Client.list('-created_date'),
    ]);

    setLeads(allLeads);
    setTrialClients(clients.filter(c => c.account_status === 'trial' || c.account_status === 'onboarding'));
    // Derive signups from Client records instead of User entity (which has restricted access)
    setSignedUpUsers(clients.map(c => ({
      id: c.id,
      full_name: c.company_name,
      email: c.email,
      role: c.account_type || 'business',
      created_date: c.created_date
    })));
    setLoading(false);
  };

  const filteredLeads = leads.filter(l => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (l.name || '').toLowerCase().includes(term) ||
           (l.email || '').toLowerCase().includes(term) ||
           (l.phone || '').toLowerCase().includes(term);
  });

  const filteredTrialClients = trialClients.filter(c => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (c.company_name || '').toLowerCase().includes(term) ||
           (c.email || '').toLowerCase().includes(term);
  });

  const filteredUsers = signedUpUsers.filter(u => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (u.full_name || '').toLowerCase().includes(term) ||
           (u.email || '').toLowerCase().includes(term);
  });

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 flex justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </CardContent>
      </Card>
    );
  }

  // Stats
  const todayStr = moment().format('YYYY-MM-DD');
  const leadsToday = leads.filter(l => l.created_date?.startsWith(todayStr)).length;
  const readyToBuy = leads.filter(l => l.custom_fields?.intent === 'ready_to_buy').length;
  const positiveLeads = leads.filter(l => l.custom_fields?.sentiment === 'positive').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-gradient-to-br from-orange-100 to-amber-100 rounded-lg">
              <Globe className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <CardTitle className="text-base">Website Leads, Trial Clients & Signups</CardTitle>
              <p className="text-xs text-gray-500 mt-0.5">Voice agent leads, trial users, and platform signups</p>
            </div>
          </div>
          <div className="flex gap-3 text-center">
            <div className="px-3 py-1.5 bg-blue-50 rounded-lg">
              <p className="text-lg font-bold text-blue-700">{leads.length}</p>
              <p className="text-[10px] text-blue-500">Voice Leads</p>
            </div>
            <div className="px-3 py-1.5 bg-amber-50 rounded-lg">
              <p className="text-lg font-bold text-amber-700">{trialClients.length}</p>
              <p className="text-[10px] text-amber-500">Trial Clients</p>
            </div>
            <div className="px-3 py-1.5 bg-green-50 rounded-lg">
              <p className="text-lg font-bold text-green-700">{signedUpUsers.length}</p>
              <p className="text-[10px] text-green-500">Signups</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search by name, email, or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 h-9 text-sm"
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="voice_leads" className="gap-1.5">
              <Mic className="w-3.5 h-3.5" /> Voice Leads ({filteredLeads.length})
            </TabsTrigger>
            <TabsTrigger value="trial_clients" className="gap-1.5">
              <UserPlus className="w-3.5 h-3.5" /> Trial Clients ({filteredTrialClients.length})
            </TabsTrigger>
            <TabsTrigger value="signups" className="gap-1.5">
              <Users className="w-3.5 h-3.5" /> Signups ({filteredUsers.length})
            </TabsTrigger>
          </TabsList>

          {/* Voice Agent Leads */}
          <TabsContent value="voice_leads">
            <div className="flex gap-3 mb-3 flex-wrap">
              <Badge variant="outline" className="text-xs">Today: {leadsToday}</Badge>
              <Badge variant="outline" className="text-xs text-green-600 border-green-200">Ready to Buy: {readyToBuy}</Badge>
              <Badge variant="outline" className="text-xs text-blue-600 border-blue-200">Positive: {positiveLeads}</Badge>
            </div>
            {filteredLeads.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">No voice agent leads yet</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Intent</TableHead>
                      <TableHead>Sentiment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Solution</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredLeads.map((lead) => (
                      <React.Fragment key={lead.id}>
                        <TableRow className="cursor-pointer hover:bg-gray-50" onClick={() => setExpandedLead(expandedLead === lead.id ? null : lead.id)}>
                          <TableCell className="font-medium text-sm">{lead.name || 'Anonymous'}</TableCell>
                          <TableCell>
                            <div className="text-xs space-y-0.5">
                              {lead.email && <div className="flex items-center gap-1"><Mail className="w-3 h-3 text-gray-400" />{lead.email}</div>}
                              {lead.phone && <div className="flex items-center gap-1"><Phone className="w-3 h-3 text-gray-400" />{lead.phone}</div>}
                              {!lead.email && !lead.phone && <span className="text-gray-400">—</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${intentColors[lead.custom_fields?.intent] || 'bg-gray-100'}`}>
                              {lead.custom_fields?.intent || 'unknown'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${sentimentColors[lead.custom_fields?.sentiment] || 'bg-gray-100'}`}>
                              {lead.custom_fields?.sentiment || 'unknown'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${statusColors[lead.status] || 'bg-gray-100'}`}>
                              {lead.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-gray-600">
                            {lead.custom_fields?.solution_interest || '—'}
                          </TableCell>
                          <TableCell className="text-xs text-gray-500">
                            {moment(lead.created_date).fromNow()}
                          </TableCell>
                          <TableCell>
                            {expandedLead === lead.id ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                          </TableCell>
                        </TableRow>
                        {expandedLead === lead.id && (
                          <TableRow>
                            <TableCell colSpan={8} className="bg-gray-50 p-4">
                              <div className="space-y-2">
                                <p className="text-xs font-medium text-gray-500 uppercase">Conversation Summary</p>
                                <p className="text-sm text-gray-700 whitespace-pre-wrap">{lead.notes || 'No notes available'}</p>
                                {lead.tags?.length > 0 && (
                                  <div className="flex gap-1.5 flex-wrap mt-2">
                                    {lead.tags.map(tag => (
                                      <Badge key={tag} variant="outline" className="text-[10px]">
                                        <Tag className="w-2.5 h-2.5 mr-1" />{tag}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Trial Clients */}
          <TabsContent value="trial_clients">
            {filteredTrialClients.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">No trial clients</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Industry</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trial Ends</TableHead>
                      <TableHead>Channels</TableHead>
                      <TableHead>Signed Up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTrialClients.map(client => {
                      const trialEnd = client.trial_end_date ? moment(client.trial_end_date) : null;
                      const daysLeft = trialEnd ? trialEnd.diff(moment(), 'days') : null;
                      return (
                        <TableRow key={client.id}>
                          <TableCell className="font-medium text-sm">{client.company_name}</TableCell>
                          <TableCell className="text-sm">{client.email}</TableCell>
                          <TableCell className="text-sm">{client.phone || '—'}</TableCell>
                          <TableCell className="text-sm">{client.industry || '—'}</TableCell>
                          <TableCell>
                            <Badge className={client.account_status === 'trial' ? 'bg-blue-100 text-blue-700' : 'bg-yellow-100 text-yellow-700'}>
                              {client.account_status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {trialEnd ? (
                              <div className="text-xs">
                                <span className={daysLeft <= 2 ? 'text-red-600 font-medium' : 'text-gray-600'}>
                                  {trialEnd.format('MMM D, YYYY')}
                                </span>
                                <br />
                                <span className={daysLeft <= 2 ? 'text-red-500' : 'text-gray-400'}>
                                  {daysLeft > 0 ? `${daysLeft} days left` : daysLeft === 0 ? 'Expires today' : 'Expired'}
                                </span>
                              </div>
                            ) : '—'}
                          </TableCell>
                          <TableCell className="text-sm">{client.total_channels || 1}</TableCell>
                          <TableCell className="text-xs text-gray-500">{moment(client.created_date).fromNow()}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Signups */}
          <TabsContent value="signups">
            {filteredUsers.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">No user signups yet</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Signed Up</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.map(user => (
                      <TableRow key={user.id}>
                        <TableCell className="font-medium text-sm">{user.full_name || '—'}</TableCell>
                        <TableCell className="text-sm">{user.email}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{user.role || 'user'}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-gray-500">{moment(user.created_date).fromNow()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}