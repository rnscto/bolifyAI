import React, { useState, useEffect } from 'react';
import { 
  Box, Typography, Grid, Card, CardContent, CardActions, 
  Button, Dialog, DialogTitle, DialogContent, DialogActions, 
  FormControl, InputLabel, Select, MenuItem, Alert, Chip, Divider
} from '@mui/material';
import { apiClient } from '../api/apiClient';

export default function ClientMarketplace() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  
  const [open, setOpen] = useState(false);
  const [selectedService, setSelectedService] = useState(null);
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [requestLoading, setRequestLoading] = useState(false);

  useEffect(() => {
    const fetchServices = async () => {
      try {
        const res = await apiClient.MarketplaceService.filter({ is_active: true });
        setServices(res.data || []);
      } catch (err) {
        setError("Failed to load marketplace services");
      } finally {
        setLoading(false);
      }
    };
    fetchServices();
  }, []);

  const handleOpen = (service) => {
    setSelectedService(service);
    setBillingCycle('monthly'); // default
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setSelectedService(null);
  };

  const handleRequest = async () => {
    try {
      setRequestLoading(true);
      setError(null);
      await apiClient.marketplace.request(selectedService.id, billingCycle);
      setSuccess(`Request for ${selectedService.name} submitted successfully! Waiting for admin approval.`);
      handleClose();
    } catch (err) {
      setError(err.message || "Failed to submit request");
    } finally {
      setRequestLoading(false);
    }
  };

  const getPrice = (service, cycle) => {
    return service[`pricing_${cycle}`] || 0;
  };

  if (loading) return <Box p={3}><Typography>Loading Marketplace...</Typography></Box>;

  return (
    <Box p={3}>
      <Typography variant="h4" mb={1}>Add-on Marketplace</Typography>
      <Typography variant="body1" color="textSecondary" mb={4}>
        Enhance your AI calling experience with modular add-ons and industry suites.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 3 }} onClose={() => setSuccess(null)}>{success}</Alert>}

      <Grid container spacing={3}>
        {services.map(service => (
          <Grid item xs={12} sm={6} md={4} key={service.id}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flexGrow: 1 }}>
                <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
                  <Typography variant="h6">{service.name}</Typography>
                  <Chip 
                    label={service.category.replace('_', ' ').toUpperCase()} 
                    size="small" 
                    color={service.category === 'industry_suite' ? 'secondary' : 'primary'} 
                    variant="outlined" 
                  />
                </Box>
                <Typography variant="body2" color="textSecondary" mb={2}>
                  {service.description}
                </Typography>
                
                <Divider sx={{ my: 2 }} />
                
                <Typography variant="subtitle2" color="textSecondary">Starting from</Typography>
                <Typography variant="h5" color="primary">
                  ₹{service.pricing_monthly.toLocaleString()} <Typography component="span" variant="caption">/mo</Typography>
                </Typography>
              </CardContent>
              <CardActions>
                <Button size="large" fullWidth variant="contained" onClick={() => handleOpen(service)}>
                  Request Add-on
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        {selectedService && (
          <>
            <DialogTitle>Request {selectedService.name}</DialogTitle>
            <DialogContent>
              <Typography variant="body2" mb={3}>{selectedService.description}</Typography>
              
              <FormControl fullWidth margin="normal">
                <InputLabel>Billing Cycle</InputLabel>
                <Select
                  value={billingCycle}
                  label="Billing Cycle"
                  onChange={(e) => setBillingCycle(e.target.value)}
                >
                  {selectedService.pricing_monthly > 0 && <MenuItem value="monthly">Monthly - ₹{selectedService.pricing_monthly}</MenuItem>}
                  {selectedService.pricing_quarterly > 0 && <MenuItem value="quarterly">Quarterly - ₹{selectedService.pricing_quarterly}</MenuItem>}
                  {selectedService.pricing_semi_annual > 0 && <MenuItem value="semi_annual">Semi-Annual - ₹{selectedService.pricing_semi_annual}</MenuItem>}
                  {selectedService.pricing_yearly > 0 && <MenuItem value="yearly">Yearly - ₹{selectedService.pricing_yearly}</MenuItem>}
                  {selectedService.pricing_one_time > 0 && <MenuItem value="one_time">One-Time - ₹{selectedService.pricing_one_time}</MenuItem>}
                </Select>
              </FormControl>

              <Box mt={2} p={2} bgcolor="#f5f5f5" borderRadius={1}>
                <Typography variant="subtitle2">Summary:</Typography>
                <Typography variant="body1">
                  You are requesting <strong>{selectedService.name}</strong> on a <strong>{billingCycle.replace('_', ' ')}</strong> cycle for <strong>₹{getPrice(selectedService, billingCycle)}</strong>.
                </Typography>
                <Typography variant="caption" color="textSecondary" display="block" mt={1}>
                  Note: Upon approval by your administrator, the amount will be automatically deducted from your prepaid wallet balance.
                </Typography>
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={handleClose}>Cancel</Button>
              <Button 
                onClick={handleRequest} 
                variant="contained" 
                color="primary"
                disabled={requestLoading || getPrice(selectedService, billingCycle) <= 0}
              >
                Submit Request
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>
    </Box>
  );
}
