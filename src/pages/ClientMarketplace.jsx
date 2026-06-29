import React, { useState, useEffect } from 'react';
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

  if (loading) {
    return <div className="p-6"><p>Loading Marketplace...</p></div>;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Add-on Marketplace</h1>
      <p className="text-gray-600 mb-8">
        Enhance your AI calling experience with modular add-ons and industry suites.
      </p>

      {error && (
        <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-md border border-red-200">
          {error}
          <button onClick={() => setError(null)} className="float-right font-bold">&times;</button>
        </div>
      )}
      
      {success && (
        <div className="mb-6 p-4 bg-green-50 text-green-700 rounded-md border border-green-200">
          {success}
          <button onClick={() => setSuccess(null)} className="float-right font-bold">&times;</button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {services.map(service => (
          <div key={service.id} className="bg-white rounded-lg shadow-md border border-gray-100 flex flex-col hover:shadow-lg transition-shadow">
            <div className="p-6 flex-grow">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-xl font-semibold text-gray-900">{service.name}</h2>
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                  service.category === 'industry_suite' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                }`}>
                  {service.category.replace('_', ' ').toUpperCase()}
                </span>
              </div>
              
              <p className="text-gray-600 text-sm mb-6 h-10 overflow-hidden text-ellipsis line-clamp-2">
                {service.description}
              </p>
              
              <div className="border-t pt-4">
                <p className="text-xs text-gray-500 uppercase font-semibold">Starting from</p>
                <p className="text-2xl font-bold text-gray-900">
                  ₹{service.pricing_monthly.toLocaleString()} <span className="text-sm font-normal text-gray-500">/mo</span>
                </p>
              </div>
            </div>
            
            <div className="p-6 pt-0 mt-auto">
              <button 
                onClick={() => handleOpen(service)}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Request Add-on
              </button>
            </div>
          </div>
        ))}
      </div>

      {open && selectedService && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="px-6 py-4 border-b flex justify-between items-center">
              <h2 className="text-xl font-bold">Request {selectedService.name}</h2>
              <button onClick={handleClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
            </div>
            
            <div className="p-6">
              <p className="text-sm text-gray-600 mb-6">{selectedService.description}</p>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">Billing Cycle</label>
                <select
                  className="w-full border border-gray-300 rounded-md shadow-sm p-2.5 bg-white focus:ring-blue-500 focus:border-blue-500"
                  value={billingCycle}
                  onChange={(e) => setBillingCycle(e.target.value)}
                >
                  {selectedService.pricing_monthly > 0 && <option value="monthly">Monthly - ₹{selectedService.pricing_monthly}</option>}
                  {selectedService.pricing_quarterly > 0 && <option value="quarterly">Quarterly - ₹{selectedService.pricing_quarterly}</option>}
                  {selectedService.pricing_semi_annual > 0 && <option value="semi_annual">Semi-Annual - ₹{selectedService.pricing_semi_annual}</option>}
                  {selectedService.pricing_yearly > 0 && <option value="yearly">Yearly - ₹{selectedService.pricing_yearly}</option>}
                  {selectedService.pricing_one_time > 0 && <option value="one_time">One-Time - ₹{selectedService.pricing_one_time}</option>}
                </select>
              </div>

              <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">Summary</h3>
                <p className="text-sm text-gray-700">
                  You are requesting <strong>{selectedService.name}</strong> on a <strong>{billingCycle.replace('_', ' ')}</strong> cycle for <strong>₹{getPrice(selectedService, billingCycle)}</strong>.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Note: Upon approval by your administrator, the amount will be automatically deducted from your prepaid wallet balance.
                </p>
              </div>
            </div>

            <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3 rounded-b-lg">
              <button 
                onClick={handleClose}
                className="bg-white py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none"
              >
                Cancel
              </button>
              <button 
                onClick={handleRequest}
                disabled={requestLoading || getPrice(selectedService, billingCycle) <= 0}
                className="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {requestLoading ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
