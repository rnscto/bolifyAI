import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { TrendingUp, Target, Users, Activity } from 'lucide-react';

const COLORS = ['#6366F1', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#14B8A6'];

export default function SalesReports({ deals, leads, activities, stages, dateRange, onDateRangeChange }) {
  const [reportTab, setReportTab] = useState('forecast');

  // Sales Forecast
  const forecastData = useMemo(() => {
    return (stages || []).map(stage => {
      const stageDeals = deals.filter(d => d.stage === stage.name && d.status === 'open');
      const total = stageDeals.reduce((s, d) => s + (d.value || 0), 0);
      const weighted = stageDeals.reduce((s, d) => s + ((d.value || 0) * (d.probability || 0) / 100), 0);
      return { name: stage.name, total, weighted, count: stageDeals.length };
    });
  }, [deals, stages]);

  // Lead Source Analysis
  const sourceData = useMemo(() => {
    const sourceMap = {};
    leads.forEach(l => {
      const src = l.source || 'Unknown';
      if (!sourceMap[src]) sourceMap[src] = { name: src, count: 0, converted: 0 };
      sourceMap[src].count++;
      if (l.status === 'converted') sourceMap[src].converted++;
    });
    return Object.values(sourceMap).sort((a, b) => b.count - a.count).slice(0, 10);
  }, [leads]);

  // Sales Rep Performance
  const repData = useMemo(() => {
    const repMap = {};
    deals.forEach(d => {
      const rep = d.assigned_to || 'Unassigned';
      if (!repMap[rep]) repMap[rep] = { name: rep, deals: 0, value: 0, won: 0, wonValue: 0 };
      repMap[rep].deals++;
      repMap[rep].value += d.value || 0;
      if (d.status === 'won') { repMap[rep].won++; repMap[rep].wonValue += d.value || 0; }
    });
    return Object.values(repMap).sort((a, b) => b.wonValue - a.wonValue);
  }, [deals]);

  // Activity Productivity
  const activityData = useMemo(() => {
    const typeMap = {};
    activities.forEach(a => {
      const t = a.type || 'other';
      if (!typeMap[t]) typeMap[t] = { name: t, total: 0, completed: 0 };
      typeMap[t].total++;
      if (a.status === 'completed') typeMap[t].completed++;
    });
    return Object.values(typeMap);
  }, [activities]);

  // Summary Stats
  const totalPipeline = deals.filter(d => d.status === 'open').reduce((s, d) => s + (d.value || 0), 0);
  const totalWon = deals.filter(d => d.status === 'won').reduce((s, d) => s + (d.value || 0), 0);
  const winRate = deals.length > 0 ? Math.round(deals.filter(d => d.status === 'won').length / deals.length * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-50"><TrendingUp className="w-5 h-5 text-indigo-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Pipeline Value</p>
                <p className="text-xl font-bold">₹{totalPipeline.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-50"><Target className="w-5 h-5 text-green-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Total Won</p>
                <p className="text-xl font-bold">₹{totalWon.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-50"><Users className="w-5 h-5 text-purple-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Win Rate</p>
                <p className="text-xl font-bold">{winRate}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-50"><Activity className="w-5 h-5 text-orange-600" /></div>
              <div>
                <p className="text-xs text-gray-500">Activities</p>
                <p className="text-xl font-bold">{activities.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Report Tabs */}
      <div className="flex gap-2 flex-wrap">
        {[
          { key: 'forecast', label: 'Sales Forecast' },
          { key: 'sources', label: 'Lead Sources' },
          { key: 'reps', label: 'Rep Performance' },
          { key: 'activities', label: 'Activity Report' }
        ].map(t => (
          <Badge
            key={t.key}
            className={`cursor-pointer px-4 py-2 text-sm ${
              reportTab === t.key ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
            onClick={() => setReportTab(t.key)}
          >
            {t.label}
          </Badge>
        ))}
      </div>

      {/* Forecast */}
      {reportTab === 'forecast' && (
        <Card>
          <CardHeader><CardTitle>Sales Forecast by Stage</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={forecastData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => `₹${v.toLocaleString()}`} />
                <Legend />
                <Bar dataKey="total" name="Pipeline Value" fill="#6366F1" radius={[4,4,0,0]} />
                <Bar dataKey="weighted" name="Weighted Value" fill="#10B981" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Lead Sources */}
      {reportTab === 'sources' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader><CardTitle>Lead Sources Distribution</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={sourceData} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                    {sourceData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Conversion by Source</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={sourceData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" />
                  <YAxis dataKey="name" type="category" width={100} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" name="Total" fill="#6366F1" radius={[0,4,4,0]} />
                  <Bar dataKey="converted" name="Converted" fill="#10B981" radius={[0,4,4,0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Rep Performance */}
      {reportTab === 'reps' && (
        <Card>
          <CardHeader><CardTitle>Sales Rep Performance</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2">Sales Rep</th>
                    <th className="text-right py-3 px-2">Total Deals</th>
                    <th className="text-right py-3 px-2">Pipeline</th>
                    <th className="text-right py-3 px-2">Won</th>
                    <th className="text-right py-3 px-2">Won Value</th>
                    <th className="text-right py-3 px-2">Win Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {repData.map((rep, i) => (
                    <tr key={i} className="border-b hover:bg-gray-50">
                      <td className="py-3 px-2 font-medium">{rep.name}</td>
                      <td className="text-right py-3 px-2">{rep.deals}</td>
                      <td className="text-right py-3 px-2">₹{rep.value.toLocaleString()}</td>
                      <td className="text-right py-3 px-2">{rep.won}</td>
                      <td className="text-right py-3 px-2 text-green-600 font-semibold">₹{rep.wonValue.toLocaleString()}</td>
                      <td className="text-right py-3 px-2">
                        <Badge variant="secondary">{rep.deals > 0 ? Math.round(rep.won / rep.deals * 100) : 0}%</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activity Report */}
      {reportTab === 'activities' && (
        <Card>
          <CardHeader><CardTitle>Activity Productivity</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={activityData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="total" name="Total" fill="#6366F1" radius={[4,4,0,0]} />
                <Bar dataKey="completed" name="Completed" fill="#10B981" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}