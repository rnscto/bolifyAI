import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle } from 'lucide-react';

const codes = [
  { code: 200, name: 'OK', color: 'bg-green-100 text-green-800', meaning: 'Request succeeded. Check response body for data.' },
  { code: 400, name: 'Bad Request', color: 'bg-yellow-100 text-yellow-800', meaning: 'Missing or invalid fields. Check error.message in response.' },
  { code: 401, name: 'Unauthorized', color: 'bg-red-100 text-red-800', meaning: 'Missing x-auth-key / x-api-key header.' },
  { code: 403, name: 'Forbidden', color: 'bg-red-100 text-red-800', meaning: 'Invalid key, or key does not belong to your client account.' },
  { code: 404, name: 'Not Found', color: 'bg-gray-100 text-gray-800', meaning: 'Referenced lead_id / agent_id / call_log_id does not exist.' },
  { code: 429, name: 'Rate Limited', color: 'bg-orange-100 text-orange-800', meaning: 'Too many requests. Retry after 60s with exponential backoff.' },
  { code: 500, name: 'Server Error', color: 'bg-red-100 text-red-800', meaning: 'Internal error. Safe to retry after 30 seconds.' }
];

export default function ErrorCodesCard() {
  return (
    <Card id="errors">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-orange-600" />
          Errors & Status Codes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-600">
                <th className="py-2 pr-4">Code</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(c => (
                <tr key={c.code} className="border-b last:border-0">
                  <td className="py-2 pr-4 font-mono font-bold">{c.code}</td>
                  <td className="py-2 pr-4"><Badge className={c.color}>{c.name}</Badge></td>
                  <td className="py-2 text-gray-700">{c.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h4 className="font-semibold text-sm mb-2">Error Response Format</h4>
          <pre className="bg-gray-100 p-3 rounded text-sm overflow-x-auto">
{`{
  "error": "Missing client_id or event_type",
  "code": 400
}`}
          </pre>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-900">
          <strong>💡 Retry guidance:</strong> Retry only on <code>429</code> and <code>5xx</code> errors. Use exponential backoff (1s → 5s → 30s → 2min). Never retry on <code>4xx</code> client errors — fix the request first.
        </div>
      </CardContent>
    </Card>
  );
}