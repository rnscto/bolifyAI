import React, { useState, useEffect } from 'react';
import { 
  Box, Typography, Button, TextField, Select, MenuItem, 
  FormControl, InputLabel, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, Dialog, 
  DialogActions, DialogContent, DialogTitle, Switch, 
  FormControlLabel, Alert 
} from '@mui/material';
import { apiClient } from '../api/apiClient';

export default function AdminMarketplaceConfig() {
  const [services, setServices] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editId, setEditId] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    module_identifier: '',
    category: 'add_on',
    pricing_monthly: 0,
    pricing_quarterly: 0,
    pricing_semi_annual: 0,
    pricing_yearly: 0,
    pricing_one_time: 0,
    is_active: true
  });

  const fetchServices = async () => {
    try {
      const res = await apiClient.MarketplaceService.list();
      setServices(res.data || []);
    } catch (err) {
      console.error(err);
      setError("Failed to fetch services");
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  const handleOpen = (service = null) => {
    if (service) {
      setEditId(service.id);
      setFormData(service);
    } else {
      setEditId(null);
      setFormData({
        name: '', description: '', module_identifier: '', category: 'add_on',
        pricing_monthly: 0, pricing_quarterly: 0, pricing_semi_annual: 0,
        pricing_yearly: 0, pricing_one_time: 0, is_active: true
      });
    }
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      if (editId) {
        await apiClient.MarketplaceService.update(editId, formData);
      } else {
        await apiClient.MarketplaceService.create(formData);
      }
      fetchServices();
      handleClose();
    } catch (err) {
      setError(err.message || "Failed to save");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box p={3}>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4">Marketplace Config</Typography>
        <Button variant="contained" color="primary" onClick={() => handleOpen()}>
          Add New Service
        </Button>
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <TableContainer component={Paper}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Module Identifier</TableCell>
              <TableCell>Category</TableCell>
              <TableCell>Monthly ₹</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {services.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.name}</TableCell>
                <TableCell>{s.module_identifier}</TableCell>
                <TableCell>{s.category}</TableCell>
                <TableCell>{s.pricing_monthly}</TableCell>
                <TableCell>{s.is_active ? 'Active' : 'Inactive'}</TableCell>
                <TableCell>
                  <Button size="small" onClick={() => handleOpen(s)}>Edit</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>{editId ? 'Edit Service' : 'Add Service'}</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} mt={1}>
            <TextField label="Service Name" fullWidth 
              value={formData.name} onChange={(e) => setFormData({...formData, name: e.target.value})} 
            />
            <TextField label="Description" fullWidth multiline rows={2}
              value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} 
            />
            <TextField label="Module Identifier (e.g. whatsapp_bot)" fullWidth 
              value={formData.module_identifier} onChange={(e) => setFormData({...formData, module_identifier: e.target.value})} 
            />
            
            <FormControl fullWidth>
              <InputLabel>Category</InputLabel>
              <Select
                value={formData.category}
                label="Category"
                onChange={(e) => setFormData({...formData, category: e.target.value})}
              >
                <MenuItem value="add_on">Add-on Service</MenuItem>
                <MenuItem value="integration">Integration</MenuItem>
                <MenuItem value="industry_suite">Industry Suite</MenuItem>
              </Select>
            </FormControl>

            <Typography variant="subtitle2" mt={1}>Pricing (INR)</Typography>
            <Box display="flex" gap={2}>
              <TextField label="Monthly" type="number" fullWidth
                value={formData.pricing_monthly} onChange={(e) => setFormData({...formData, pricing_monthly: Number(e.target.value)})} 
              />
              <TextField label="Quarterly" type="number" fullWidth
                value={formData.pricing_quarterly} onChange={(e) => setFormData({...formData, pricing_quarterly: Number(e.target.value)})} 
              />
            </Box>
            <Box display="flex" gap={2}>
              <TextField label="Semi-Annual" type="number" fullWidth
                value={formData.pricing_semi_annual} onChange={(e) => setFormData({...formData, pricing_semi_annual: Number(e.target.value)})} 
              />
              <TextField label="Yearly" type="number" fullWidth
                value={formData.pricing_yearly} onChange={(e) => setFormData({...formData, pricing_yearly: Number(e.target.value)})} 
              />
            </Box>
            <TextField label="One Time Charge" type="number" fullWidth
              value={formData.pricing_one_time} onChange={(e) => setFormData({...formData, pricing_one_time: Number(e.target.value)})} 
            />

            <FormControlLabel 
              control={<Switch checked={formData.is_active} onChange={(e) => setFormData({...formData, is_active: e.target.checked})} />} 
              label="Active (Available in Marketplace)" 
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={loading}>Save</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
