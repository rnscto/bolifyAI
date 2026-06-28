import { apiFetch } from './apiClient';

// Helper to convert a File object to a Base64 string
export const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result); // e.g. "data:image/png;base64,..."
    reader.onerror = (error) => reject(error);
  });
};

export const supportApi = {
  getTickets: (status = '') => {
    let url = '/support/tickets';
    if (status && status !== 'all') {
      url += `?status=${encodeURIComponent(status)}`;
    }
    return apiFetch(url);
  },

  createTicket: async (data) => {
    let attachment_data = null;
    let attachment_type = null;

    if (data.file) {
      attachment_data = await fileToBase64(data.file);
      attachment_type = data.file.type;
    }

    const payload = {
      subject: data.subject,
      category: data.category,
      priority: data.priority,
      description: data.description,
      attachment_data,
      attachment_type
    };

    return apiFetch('/support/tickets', {
      method: 'POST',
      body: JSON.stringify(payload),
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

  sendMessage: async (ticketId, message, file = null) => {
    let attachment_data = null;
    let attachment_type = null;

    if (file) {
      attachment_data = await fileToBase64(file);
      attachment_type = file.type;
    }

    return apiFetch(`/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message, attachment_data, attachment_type }),
    });
  },

  reopenTicket: (ticketId) => {
    return apiFetch(`/support/tickets/${ticketId}/reopen`, {
      method: 'POST',
    });
  }
};
