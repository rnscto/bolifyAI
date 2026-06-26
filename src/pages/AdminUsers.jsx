import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import {
  Users, Search, ShieldCheck, UserCog, Ban, CheckCircle2,
  Loader2, RefreshCw, AlertTriangle, Crown, Eye
} from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

// ── Master Admin email constant ────────────────────────────────────────────
const MASTER_ADMIN_EMAIL = 'yadav.nandkishor73@gmail.com';

const ROLE_STYLES = {
  master_admin:    'bg-amber-500/20 text-amber-400 border border-amber-500/30',
  admin:           'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  master_reseller: 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30',
  reseller:        'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  client:          'bg-gray-500/20 text-gray-300 border border-gray-500/20',
};

const STATUS_STYLES = {
  active:   'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20',
  inactive: 'bg-gray-500/20 text-gray-400 border border-gray-500/20',
  suspended:'bg-red-500/20 text-red-400 border border-red-500/20',
};

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedUser, setSelectedUser] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editRole, setEditRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState('');

  useEffect(() => {
    init();
  }, []);

  const init = async () => {
    const me = await apiClient.auth.me();
    setCurrentUserEmail(me.email);
    if (me.email !== MASTER_ADMIN_EMAIL) {
      toast.error('Access denied. Master Admin only.');
      return;
    }
    await loadUsers();
  };

  const loadUsers = async () => {
    setLoading(true);
    try {
      // Load all users from the User entity
      const all = await apiClient.User.list('-created_at', 1000);
      setUsers(all);
    } catch (e) {
      console.error('Failed to load users:', e);
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  const openEdit = (u) => {
    setSelectedUser(u);
    setEditRole(u.role || 'client');
    setEditOpen(true);
  };

  const handleSaveRole = async () => {
    if (!selectedUser) return;
    if (selectedUser.email === MASTER_ADMIN_EMAIL) {
      toast.error('Cannot modify the Master Admin account.');
      return;
    }
    setSaving(true);
    try {
      await apiClient.User.update(selectedUser.id, { role: editRole });
      toast.success(`Role updated to "${editRole}" for ${selectedUser.email}`);
      setEditOpen(false);
      await loadUsers();
    } catch (e) {
      toast.error('Failed to update role: ' + (e.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSuspend = async (u) => {
    if (u.email === MASTER_ADMIN_EMAIL) {
      toast.error('Cannot suspend the Master Admin account.');
      return;
    }
    const newStatus = u.status === 'suspended' ? 'active' : 'suspended';
    try {
      await apiClient.User.update(u.id, { status: newStatus });
      toast.success(`User ${newStatus === 'suspended' ? 'suspended' : 'reactivated'}`);
      await loadUsers();
    } catch (e) {
      toast.error('Failed to update status');
    }
  };

  // ── Derived stats ──────────────────────────────────────────────────────────
  const stats = {
    total: users.length,
    admins: users.filter(u => u.role === 'admin' || u.role === 'master_admin').length,
    resellers: users.filter(u => u.role === 'reseller' || u.role === 'master_reseller').length,
    clients: users.filter(u => !u.role || u.role === 'client').length,
    suspended: users.filter(u => u.status === 'suspended').length,
  };

  // ── Filtering ──────────────────────────────────────────────────────────────
  const filtered = users.filter(u => {
    if (filterRole !== 'all' && u.role !== filterRole) return false;
    if (filterStatus !== 'all' && u.status !== filterStatus) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        (u.email || '').toLowerCase().includes(s) ||
        (u.display_name || '').toLowerCase().includes(s) ||
        (u.role || '').toLowerCase().includes(s)
      );
    }
    return true;
  });

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (currentUserEmail && currentUserEmail !== MASTER_ADMIN_EMAIL) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <AlertTriangle className="w-12 h-12 text-red-400" />
        <p className="text-gray-400 font-medium">Access Denied — Master Admin only</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Crown className="w-6 h-6 text-amber-400" />
            Platform Users
          </h1>
          <p className="text-gray-500 text-sm mt-1">All registered users — across every role and status</p>
        </div>
        <Button
          onClick={loadUsers}
          variant="outline"
          size="sm"
          className="border-white/10 text-gray-300 hover:text-white hover:bg-white/5"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total Users', val: stats.total, color: 'text-white' },
          { label: 'Admins', val: stats.admins, color: 'text-amber-400' },
          { label: 'Resellers', val: stats.resellers, color: 'text-cyan-400' },
          { label: 'Clients', val: stats.clients, color: 'text-blue-400' },
          { label: 'Suspended', val: stats.suspended, color: 'text-red-400' },
        ].map(s => (
          <Card key={s.label} className="border border-white/8 bg-white/5">
            <CardContent className="py-3 px-4 text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.val}</p>
              <p className="text-xs text-gray-600 mt-0.5">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-white/5 border-white/10 text-gray-200 placeholder:text-gray-600"
          />
        </div>
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-44 bg-white/5 border-white/10 text-gray-300">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent className="bg-[#1e2130] border-white/10 text-gray-200">
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="master_admin">Master Admin</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="master_reseller">Master Reseller</SelectItem>
            <SelectItem value="reseller">Reseller</SelectItem>
            <SelectItem value="client">Client</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40 bg-white/5 border-white/10 text-gray-300">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent className="bg-[#1e2130] border-white/10 text-gray-200">
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="border border-white/8 bg-white/5">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-white/8 hover:bg-transparent">
                  <TableHead className="text-gray-500">User</TableHead>
                  <TableHead className="text-gray-500">Role</TableHead>
                  <TableHead className="text-gray-500">Status</TableHead>
                  <TableHead className="text-gray-500">Joined</TableHead>
                  <TableHead className="text-gray-500">Last Login</TableHead>
                  <TableHead className="text-gray-500 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12 text-gray-600">
                      No users found
                    </TableCell>
                  </TableRow>
                ) : filtered.map(u => (
                  <TableRow key={u.id} className="border-white/5 hover:bg-white/5 transition-colors">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 border border-purple-500/20 flex items-center justify-center text-purple-300 font-bold text-sm shrink-0">
                          {(u.display_name || u.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-200">
                            {u.display_name || '—'}
                            {u.email === MASTER_ADMIN_EMAIL && (
                              <Crown className="w-3.5 h-3.5 text-amber-400 inline ml-1" />
                            )}
                          </p>
                          <p className="text-xs text-gray-500 font-mono">{u.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${ROLE_STYLES[u.role] || ROLE_STYLES.client}`}>
                        {(u.role || 'client').replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs ${STATUS_STYLES[u.status] || STATUS_STYLES.inactive}`}>
                        {u.status || 'inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-gray-500">
                      {u.created_at ? moment(u.created_at).format('DD MMM YYYY') : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-gray-500">
                      {u.last_login ? moment(u.last_login).fromNow() : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center gap-1 justify-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(u)}
                          disabled={u.email === MASTER_ADMIN_EMAIL}
                          className="text-gray-400 hover:text-white hover:bg-white/10 h-8 w-8 p-0"
                          title="Edit Role"
                        >
                          <UserCog className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleToggleSuspend(u)}
                          disabled={u.email === MASTER_ADMIN_EMAIL}
                          className={`h-8 w-8 p-0 ${u.status === 'suspended'
                            ? 'text-emerald-400 hover:bg-emerald-400/10'
                            : 'text-red-400 hover:bg-red-400/10'
                          }`}
                          title={u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                        >
                          {u.status === 'suspended'
                            ? <CheckCircle2 className="w-4 h-4" />
                            : <Ban className="w-4 h-4" />
                          }
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Role Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="bg-[#161920] border border-white/10 text-gray-100 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <UserCog className="w-5 h-5 text-cyan-400" />
              Edit User Role
            </DialogTitle>
          </DialogHeader>
          {selectedUser && (
            <div className="space-y-4 py-2">
              <div className="p-3 rounded-xl bg-white/5 border border-white/8">
                <p className="text-sm font-medium text-gray-200">{selectedUser.display_name || '—'}</p>
                <p className="text-xs text-gray-500 font-mono">{selectedUser.email}</p>
              </div>
              <div>
                <Label className="text-gray-400 text-sm">Assign Role</Label>
                <Select value={editRole} onValueChange={setEditRole}>
                  <SelectTrigger className="mt-1.5 bg-white/5 border-white/10 text-gray-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#1e2130] border-white/10 text-gray-200">
                    <SelectItem value="client">Client</SelectItem>
                    <SelectItem value="reseller">Reseller</SelectItem>
                    <SelectItem value="master_reseller">Master Reseller</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-xs text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                Changing this user's role will immediately affect their dashboard access and permissions.
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setEditOpen(false)} className="text-gray-400 hover:text-white">
              Cancel
            </Button>
            <Button onClick={handleSaveRole} disabled={saving} className="bg-cyan-600 hover:bg-cyan-500 text-white">
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
              Save Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
