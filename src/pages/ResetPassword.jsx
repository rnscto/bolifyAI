import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setStatus('error');
      setMessage('Passwords do not match.');
      return;
    }
    if (newPassword.length < 8) {
      setStatus('error');
      setMessage('Password must be at least 8 characters.');
      return;
    }

    setStatus('loading');
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, new_password: newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('success');
        setMessage(data.message || 'Password reset successfully!');
        setTimeout(() => navigate('/login'), 2500);
      } else {
        setStatus('error');
        setMessage(data.error || 'Reset failed. The link may have expired.');
      }
    } catch {
      setStatus('error');
      setMessage('Could not connect to server. Please try again.');
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <Card className="w-full max-w-md shadow-lg border-t-4 border-t-red-500">
          <CardContent className="pt-6 text-center space-y-4">
            <p className="text-red-600">Invalid or missing reset token.</p>
            <Link to="/forgot-password" className="text-sm text-cyan-600 hover:underline">Request a new reset link</Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-cyan-500">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Set New Password</CardTitle>
          <CardDescription className="text-center">
            Choose a strong password for your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status === 'success' ? (
            <div className="text-center space-y-4">
              <div className="p-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md">
                ✅ {message} Redirecting to login...
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {status === 'error' && (
                <div className="p-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md">{message}</div>
              )}
              <div className="space-y-2">
                <Label htmlFor="new_password">New Password</Label>
                <Input id="new_password" type="password" required minLength={8}
                  value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm_password">Confirm Password</Label>
                <Input id="confirm_password" type="password" required minLength={8}
                  value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat your new password" />
              </div>
              <Button
                type="submit"
                className="w-full bg-gradient-to-r from-[#00bcd4] to-[#0097a7] hover:from-[#0097a7] hover:to-[#00838f] text-white"
                disabled={status === 'loading'}
              >
                {status === 'loading' ? 'Updating...' : 'Reset Password'}
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
