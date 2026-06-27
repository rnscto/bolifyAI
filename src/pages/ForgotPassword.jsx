import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | sent | error
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus('loading');
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('sent');
        setMessage(data.message || 'Check your email for a reset link.');
      } else {
        setStatus('error');
        setMessage(data.error || 'Something went wrong.');
      }
    } catch {
      setStatus('error');
      setMessage('Could not connect to server. Please try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-cyan-500">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Forgot Password</CardTitle>
          <CardDescription className="text-center">
            Enter your email address and we'll send you a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'sent' ? (
            <div className="text-center space-y-4">
              <div className="p-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md">
                ✅ {message}
              </div>
              <Link to="/login" className="text-sm text-cyan-600 hover:underline">Back to Login</Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {status === 'error' && (
                <div className="p-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md">{message}</div>
              )}
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email" type="email" required
                  placeholder="you@company.com"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00bcd4] to-[#0097a7] hover:from-[#0097a7] hover:to-[#00838f] text-white"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Sending...' : 'Send Reset Link'}
              </Button>
              <div className="text-center">
                <Link to="/login" className="text-sm text-gray-500 hover:underline">Back to Login</Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
