import React, { useState, useEffect } from 'react';
import { 
  Box, Typography, Button, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, Alert, Chip 
} from '@mui/material';
import { apiClient } from '../api/apiClient';

export default function AdminMarketplaceApprovals() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const fetchRequests = async () => {
    try {
      setLoading(true);
      const res = await apiClient.ClientAddonSubscription.filter({ status: 'pending_approval' });
      const data = res.data || [];
      
      // We should ideally populate the service and client details.
      // Doing a quick manual populate for MVP:
      const populated = await Promise.all(data.map(async (req) => {
        try {
          const client = await apiClient.Client.get(req.client_id);
          const service = await apiClient.MarketplaceService.get(req.service_id);
          return { ...req, client_name: client?.data?.company_name || 'Unknown', service_name: service?.data?.name || 'Unknown' };
        } catch(e) {
          return req;
        }
      }));

      setRequests(populated);
    } catch (err) {
      setError("Failed to fetch requests");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  const handleApprove = async (id) => {
    try {
      setLoading(true);
      setError(null);
      await apiClient.marketplace.approve(id);
      setSuccess("Subscription approved and wallet deducted successfully!");
      fetchRequests();
    } catch (err) {
      setError(err.message || "Failed to approve");
      setLoading(false);
    }
  };

  return (
    <Box p={3}>
      <Typography variant="h4" mb={3}>Marketplace Approvals</Typography>
      
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess(null)}>{success}</Alert>}

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Client</TableCell>
              <TableCell>Service</TableCell>
              <TableCell>Billing Cycle</TableCell>
              <TableCell>Amount (₹)</TableCell>
              <TableCell>Date Requested</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {requests.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center">No pending requests</TableCell>
              </TableRow>
            ) : (
              requests.map(req => (
                <TableRow key={req.id}>
                  <TableCell>{req.client_name || req.client_id}</TableCell>
                  <TableCell>{req.service_name || req.service_id}</TableCell>
                  <TableCell><Chip label={req.billing_cycle} size="small" /></TableCell>
                  <TableCell>{req.amount}</TableCell>
                  <TableCell>{new Date(req.created_at || req.start_date).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button 
                      variant="contained" 
                      color="primary" 
                      size="small"
                      disabled={loading}
                      onClick={() => handleApprove(req.id)}
                    >
                      Approve & Deduct
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
