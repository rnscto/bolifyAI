import { apiFetch } from './apiClient';

export const supportApi = {
  getTickets: (status = '') => {
    let url = '/support/tickets';
    if (status && status !== 'all') {
      url += `?status=${encodeURIComponent(status)}`;
    }
    return apiFetch(url);
  },

  createTicket: (data) => {
    return apiFetch('/support/tickets', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  updateTicketStatus: (id, status) => {
    return apiFetch(`/support/tickets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
  },

  getMessages: (ticketId) => {
    return apiFetch(`/support/tickets/${ticketId}/messages`);
  },

  sendMessage: (ticketId, message) => {
    return apiFetch(`/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  },
};
