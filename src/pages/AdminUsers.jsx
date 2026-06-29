import React, { useState, useEffect } from 'react';
import { apiClient } from '@/api/apiClient';
import { Card, CardContent } from '@/components/ui/card';
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
  Search, ShieldCheck, UserCog, Ban, CheckCircle2,
  Loader2, RefreshCw, AlertTriangle, Crown, VenetianMask
} from 'lucide-react';
import { toast } from 'sonner';
import moment from 'moment';

// ── Master Admin email constant ────────────────────────────────────────────
const MASTER_ADMIN_EMAIL = 'yadav.nandkishor73@gmail.com';

const ROLE_STYLES = {
  master_admin:    'bg-amber-100 text-amber-700 border border-amber-500/30',
  admin:           'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  master_reseller: 'bg-blue-100 text-blue-700 border border-cyan-500/30',
  reseller:        'bg-blue-100 text-blue-700 border border-blue-500/30',
  client:          'bg-slate-100 text-gray-600 border border-slate-200',
};

const STATUS_STYLES = {
  active:   'bg-green-100 text-green-700 border border-green-100',
  inactive: 'bg-slate-100 text-gray-500 border border-slate-200',
  suspended:'bg-red-100 text-red-700 border border-red-200',
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
  const [currentUserRole, setCurrentUserRole] = useState('');

  useEffect(() => {
    init();
  }, []);

  const init = async () => {
    const me = await apiClient.auth.me();
    setCurrentUserEmail(me.email);
    setCurrentUserRole(me.role);
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

  const handleImpersonate = async (u) => {
    if (u.id === (await apiClient.auth.me()).id) {
      toast.error('Cannot impersonate yourself');
      return;
    }
    if (u.role === 'master_admin') {
      toast.error('Cannot impersonate another Master Admin');
      return;
    }
    try {
      toast.loading('Starting impersonation session...');
      await apiClient.auth.impersonate(u.id);
      // Hard refresh will happen via apiClient.auth.impersonate
    } catch (e) {
      toast.dismiss();
      toast.error('Impersonation failed: ' + (e.message || e));
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
  const isMasterAdmin = currentUserEmail === MASTER_ADMIN_EMAIL;
  
  const canEditRole = (u) => {
    if (u.email === MASTER_ADMIN_EMAIL) return false;
    if (isMasterAdmin) return true;
    // Resellers cannot edit admin/master_admin roles
    if (['admin', 'master_admin'].includes(u.role)) return false;
    // Cannot edit themselves to avoid locking out
    if (u.email === currentUserEmail) return false;
    return true;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Crown className="w-6 h-6 text-amber-700" />
            Platform Users
          </h1>
          <p className="text-gray-500 text-sm mt-1">All registered users — across every role and status</p>
        </div>
        <Button
          onClick={loadUsers}
          variant="outline"
          size="sm"
          className="border-slate-200 text-gray-600 hover:text-gray-900 hover:bg-white"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total Users', val: stats.total, color: 'text-gray-900' },
          { label: 'Admins', val: stats.admins, color: 'text-amber-700' },
          { label: 'Resellers', val: stats.resellers, color: 'text-blue-700' },
          { label: 'Clients', val: stats.clients, color: 'text-blue-700' },
          { label: 'Suspended', val: stats.suspended, color: 'text-red-700' },
        ].map(s => (
          <Card key={s.label} className="border border-slate-200 bg-white">
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
            className="pl-9 bg-white border-slate-200 text-gray-900 placeholder:text-gray-600"
          />
        </div>
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="w-44 bg-white border-slate-200 text-gray-600">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent className="bg-white border-slate-200 text-gray-900">
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="master_admin">Master Admin</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="master_reseller">Master Reseller</SelectItem>
            <SelectItem value="reseller">Reseller</SelectItem>
            <SelectItem value="client">Client</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-40 bg-white border-slate-200 text-gray-600">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent className="bg-white border-slate-200 text-gray-900">
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="border border-slate-200 bg-white shadow-sm">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-blue-700" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-slate-200 hover:bg-transparent">
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
                  <TableRow key={u.id} className="border-slate-100 hover:bg-white transition-colors">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 border border-purple-500/20 flex items-center justify-center text-purple-300 font-bold text-sm shrink-0">
                          {(u.display_name || u.email || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">
                            {u.display_name || '—'}
                            {u.email === MASTER_ADMIN_EMAIL && (
                              <Crown className="w-3.5 h-3.5 text-amber-700 inline ml-1" />
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
                      <Badge className={`text-xs ${STATUS_STYLES[u.status] || STATUS_STYLES.active}`}>
                        {u.status || 'active'}
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
                          disabled={!canEditRole(u)}
                          className="text-gray-500 hover:text-gray-900 hover:bg-slate-50 h-8 w-8 p-0"
                          title="Edit Role"
                        >
                          <UserCog className="w-4 h-4" />
                        </Button>
                        {currentUserRole === 'master_admin' && u.email !== currentUserEmail && u.role !== 'master_admin' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleImpersonate(u)}
                            className="text-amber-600 hover:text-amber-800 hover:bg-amber-100 h-8 w-8 p-0"
                            title="Impersonate User"
                          >
                            <VenetianMask className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleToggleSuspend(u)}
                          disabled={!canEditRole(u)}
                          className={`h-8 w-8 p-0 ${u.status === 'suspended'
                            ? 'text-green-700 hover:bg-emerald-400/10'
                            : 'text-red-700 hover:bg-red-400/10'
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
        <DialogContent className="bg-white border border-slate-200 text-gray-800 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-gray-900 flex items-center gap-2">
              <UserCog className="w-5 h-5 text-blue-700" />
              Edit User Role
            </DialogTitle>
          </DialogHeader>
          {selectedUser && (
            <div className="space-y-4 py-2">
              <div className="p-3 rounded-xl bg-white border border-slate-200">
                <p className="text-sm font-medium text-gray-900">{selectedUser.display_name || '—'}</p>
                <p className="text-xs text-gray-500 font-mono">{selectedUser.email}</p>
              </div>
              <div>
                <Label className="text-gray-500 text-sm">Assign Role</Label>
                <Select value={editRole} onValueChange={setEditRole}>
                  <SelectTrigger className="mt-1.5 bg-white border-slate-200 text-gray-900">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-slate-200 text-gray-900">
                    <SelectItem value="client">Client</SelectItem>
                    <SelectItem value="reseller">Reseller</SelectItem>
                    {isMasterAdmin && <SelectItem value="master_reseller">Master Reseller</SelectItem>}
                    {isMasterAdmin && <SelectItem value="admin">Admin</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-xs text-amber-600 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                Changing this user's role will immediately affect their dashboard access and permissions.
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setEditOpen(false)} className="text-gray-500 hover:text-gray-900">
              Cancel
            </Button>
            <Button onClick={handleSaveRole} disabled={saving} className="bg-cyan-600 hover:bg-cyan-500 text-gray-900">
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
              Save Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
