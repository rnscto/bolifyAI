import React, { useState, useEffect } from 'react';
import { apiClient } from '../api/apiClient';

export default function AdminMarketplaceConfig() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    category: 'add_on',
    is_active: true,
    pricing_monthly: 0,
    pricing_quarterly: 0,
    pricing_semi_annual: 0,
    pricing_yearly: 0,
    pricing_one_time: 0
  });

  const fetchServices = async () => {
    try {
      setLoading(true);
      const res = await apiClient.MarketplaceService.filter({});
      setServices(res.data || []);
    } catch (err) {
      setError("Failed to load services");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  const handleOpen = (service = null) => {
    if (service) {
      setEditingId(service.id);
      setFormData(service);
    } else {
      setEditingId(null);
      setFormData({
        name: '', description: '', category: 'add_on', is_active: true,
        pricing_monthly: 0, pricing_quarterly: 0, pricing_semi_annual: 0, pricing_yearly: 0, pricing_one_time: 0
      });
    }
    setOpen(true);
  };

  const handleClose = () => setOpen(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setError(null);
      if (editingId) {
        await apiClient.MarketplaceService.update(editingId, formData);
        setSuccess("Service updated successfully");
      } else {
        await apiClient.MarketplaceService.create(formData);
        setSuccess("Service created successfully");
      }
      handleClose();
      fetchServices();
    } catch (err) {
      setError(err.message || "Failed to save service");
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Marketplace Setup</h1>
          <p className="text-gray-600">Configure add-ons and modular suites for clients.</p>
        </div>
        <button 
          onClick={() => handleOpen()}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium shadow-sm"
        >
          Add New Service
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 text-red-700 rounded-md border border-red-200">
          {error}
          <button onClick={() => setError(null)} className="float-right font-bold">&times;</button>
        </div>
      )}
      
      {success && (
        <div className="mb-4 p-4 bg-green-50 text-green-700 rounded-md border border-green-200">
          {success}
          <button onClick={() => setSuccess(null)} className="float-right font-bold">&times;</button>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Service Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly (₹)</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {services.map(service => (
              <tr key={service.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{service.name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{service.category}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{service.pricing_monthly}</td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${service.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
                    {service.is_active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <button onClick={() => handleOpen(service)} className="text-blue-600 hover:text-blue-900">Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b flex justify-between items-center">
              <h2 className="text-xl font-bold">{editingId ? 'Edit Service' : 'Add Service'}</h2>
              <button onClick={handleClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
            </div>
            
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input 
                    type="text" required
                    className="w-full border border-gray-300 rounded-md shadow-sm p-2"
                    value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})}
                  />
                </div>
                
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea 
                    rows={3}
                    className="w-full border border-gray-300 rounded-md shadow-sm p-2"
                    value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select 
                    className="w-full border border-gray-300 rounded-md shadow-sm p-2 bg-white"
                    value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})}
                  >
                    <option value="add_on">Add-on</option>
                    <option value="industry_suite">Industry Suite</option>
                    <option value="integration">Integration</option>
                  </select>
                </div>

                <div className="flex items-center mt-6">
                  <input 
                    type="checkbox" id="isActive"
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    checked={formData.is_active} onChange={e => setFormData({...formData, is_active: e.target.checked})}
                  />
                  <label htmlFor="isActive" className="ml-2 block text-sm text-gray-900">
                    Active
                  </label>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monthly Price (₹)</label>
                  <input type="number" className="w-full border border-gray-300 rounded-md shadow-sm p-2" value={formData.pricing_monthly} onChange={e => setFormData({...formData, pricing_monthly: Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quarterly Price (₹)</label>
                  <input type="number" className="w-full border border-gray-300 rounded-md shadow-sm p-2" value={formData.pricing_quarterly} onChange={e => setFormData({...formData, pricing_quarterly: Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Semi-Annual Price (₹)</label>
                  <input type="number" className="w-full border border-gray-300 rounded-md shadow-sm p-2" value={formData.pricing_semi_annual} onChange={e => setFormData({...formData, pricing_semi_annual: Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Yearly Price (₹)</label>
                  <input type="number" className="w-full border border-gray-300 rounded-md shadow-sm p-2" value={formData.pricing_yearly} onChange={e => setFormData({...formData, pricing_yearly: Number(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">One-Time Price (₹)</label>
                  <input type="number" className="w-full border border-gray-300 rounded-md shadow-sm p-2" value={formData.pricing_one_time} onChange={e => setFormData({...formData, pricing_one_time: Number(e.target.value)})} />
                </div>
              </div>
              
              <div className="pt-4 border-t flex justify-end gap-3 mt-6">
                <button type="button" onClick={handleClose} className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none">
                  Cancel
                </button>
                <button type="submit" className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
