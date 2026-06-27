import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/api/apiClient';
import { useAuth } from '@/lib/AuthContext';
import { createPageUrl } from '@/utils';

export default function Signup() {
  const { appPublicSettings } = useAuth();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSignup = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const uplineId = appPublicSettings?.brand?.reseller_id || null;
      // Assuming apiClient.auth.signup returns a user with a token automatically
      const user = await apiClient.auth.signup(email, password, fullName, uplineId);
      // Role-based routing: all admin and reseller roles go to AdminDashboard
      const adminRoles = ['admin', 'master_admin', 'reseller', 'master_reseller'];
      window.location.href = createPageUrl(adminRoles.includes(user.role) ? 'AdminDashboard' : 'ClientDashboard');
    } catch (err) {
      if (err.message.includes('Failed to fetch') || err.message.includes('ConnectionRefused')) {
        setError('Cannot connect to the server. The database or backend might be down.');
      } else {
        setError(err.message || 'Signup failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md shadow-lg border-t-4 border-t-cyan-500">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Create an account</CardTitle>
          <CardDescription className="text-center">
            Enter your details below to create your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-500 bg-red-50 border border-red-200 rounded-md">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="fullName">Full Name</Label>
              <Input 
                id="fullName" 
                type="text" 
                placeholder="John Doe" 
                required 
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input 
                id="email" 
                type="email" 
                placeholder="m@example.com" 
                required 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input 
                id="password" 
                type="password" 
                required 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button 
              type="submit" 
              className="w-full bg-gradient-to-r from-[#00bcd4] to-[#0097a7] hover:from-[#0097a7] hover:to-[#00838f] text-white"
              disabled={loading}
            >
              {loading ? "Creating account..." : "Sign Up"}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col items-center justify-center space-y-2">
          <div className="text-sm text-gray-500">
            Already have an account?{' '}
            <Link to={createPageUrl('Login')} className="text-cyan-600 hover:text-cyan-500 font-medium">
              Log in
            </Link>
          </div>
          <div className="text-sm text-gray-500">
            <Link to={createPageUrl('Home')} className="text-gray-400 hover:text-gray-600">
              Return to Home
            </Link>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
