const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "/api" : "http://localhost:8000/api");
const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');

let ws = null;
const subscribers = {};

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  const wsUrl = WS_BASE_URL + '/realtime';
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    for (const entity of Object.keys(subscribers)) {
      if (subscribers[entity].length > 0) {
        ws.send(JSON.stringify({ action: "subscribe", entity }));
      }
    }
  };

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const entity = data.entity;
      const cbs = subscribers[entity] || [];
      const typeMap = { created: 'create', updated: 'update', deleted: 'delete' };
      const eventType = typeMap[data.type] || data.type;

      const event = {
        type: eventType,
        id: data.record?.id,
        data: data.record
      };

      cbs.forEach(cb => cb(event));
    } catch (err) {
      console.error("WS Parse Error:", err);
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 5000); // Reconnect after 5s
  };
}

function getToken() {
  return localStorage.getItem("bolifyai_token");
}

function setToken(token) {
  if (token) localStorage.setItem("bolifyai_token", token);
  else localStorage.removeItem("bolifyai_token");
}

export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  if (options.body instanceof FormData) {
    delete headers["Content-Type"];
  }

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let errorMsg = "API Error";
    try {
      const err = await response.json();
      errorMsg = err?.data?.error || err?.error || err?.message || errorMsg;
    } catch (e) { }
    throw new Error(errorMsg);
  }

  return response.json();
}

class EntityClient {
  constructor(endpoint, subscriptionName) {
    this.endpoint = endpoint;
    this.subscriptionName = subscriptionName; // e.g. "campaignlead" to maintain realtime compatibility
  }

  async filter(params = {}, sort = "", limit = 100) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, value);
      }
    }
    if (sort) searchParams.append("sort", sort);
    if (limit) searchParams.append("limit", limit);
    return apiFetch(`${this.endpoint}?${searchParams.toString()}`);
  }

  async list(sort = "", limit = 100) {
    return this.filter({}, sort, limit);
  }

  async get(id) {
    return apiFetch(`${this.endpoint}/${id}`);
  }

  async create(data) {
    return apiFetch(this.endpoint, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async bulkCreate(dataArray) {
    const results = [];
    for (const item of dataArray) {
      results.push(await this.create(item));
    }
    return results;
  }

  async update(id, data) {
    return apiFetch(`${this.endpoint}/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async delete(id) {
    return apiFetch(`${this.endpoint}/${id}`, {
      method: "DELETE",
    });
  }

  subscribe(callback) {
    const entityName = this.subscriptionName;
    if (!subscribers[entityName]) {
      subscribers[entityName] = [];
    }
    subscribers[entityName].push(callback);

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "subscribe", entity: entityName }));
    }

    return () => {
      subscribers[entityName] = subscribers[entityName].filter(cb => cb !== callback);
    };
  }
}

export const apiClient = {
  baseUrl: API_BASE_URL,
  get: async (url) => await apiFetch(url),
  post: async (url, body) => await apiFetch(url, { method: "POST", body: JSON.stringify(body) }),
  put: async (url, body) => await apiFetch(url, { method: "PUT", body: JSON.stringify(body) }),
  delete: async (url) => await apiFetch(url, { method: "DELETE" }),
  auth: {
    login: async (email, password) => {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      return res.user;
    },
    signup: async (email, password, full_name, upline_id) => {
      const res = await apiFetch("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, full_name, upline_id }),
      });
      setToken(res.token);
      return res.user;
    },
    me: async () => {
      try {
        return await apiFetch("/auth/me");
      } catch (e) {
        throw { type: 'auth_required' };
      }
    },
    updateMe: async (updates) => {
      return await apiFetch("/auth/me", {
        method: "PUT",
        body: JSON.stringify(updates),
      });
    },
    isAuthenticated: async () => {
      try {
        await apiFetch("/auth/me");
        return true;
      } catch (e) {
        return false;
      }
    },
    logout: (redirectUrl) => {
      setToken(null);
      if (redirectUrl) window.location.href = redirectUrl;
      else window.location.href = "/Home";
    },
    redirectToLogin: () => {
      window.location.href = "/Login";
    },
    impersonate: async (targetUserId) => {
      const res = await apiFetch("/auth/impersonate", {
        method: "POST",
        body: JSON.stringify({ target_user_id: targetUserId }),
      });
      // backup original token
      const currentToken = getToken();
      if (currentToken) {
        localStorage.setItem("bolifyai_original_token", currentToken);
      }
      setToken(res.token);
      return res.user;
    },
    stopImpersonating: () => {
      const orig = localStorage.getItem("bolifyai_original_token");
      if (orig) {
        setToken(orig);
        localStorage.removeItem("bolifyai_original_token");
      }
      window.location.href = "/";
    }
  },
  branding: {
    getByDomain: async (domain) => {
      return await apiFetch(`/v1/branding?domain=${domain}`);
    }
  },

  // New V1 endpoints mapped to EntityClients
  Lead: new EntityClient('/v1/leads', 'lead'),
  LeadGroup: new EntityClient('/v1/lead-groups', 'leadgroup'),
  CampaignLead: new EntityClient('/v1/campaign-leads', 'campaignlead'),
  Campaign: new EntityClient('/v1/campaigns', 'campaign'),
  Activity: new EntityClient('/v1/activities', 'activity'),
  Agent: new EntityClient('/v1/agents', 'agent'),
  Client: new EntityClient('/v1/clients', 'client'),
  DID: new EntityClient('/v1/dids', 'did'),
  CallLog: new EntityClient('/v1/call-logs', 'calllog'),
  Deal: new EntityClient('/v1/deals', 'deal'),
  CRMConfig: new EntityClient('/v1/crm-config', 'crmconfig'),
  EmailSequence: new EntityClient('/v1/email-sequences', 'emailsequence'),
  SequenceEnrollment: new EntityClient('/v1/sequence-enrollments', 'sequenceenrollment'),
  ClientIntegration: new EntityClient('/v1/client-integrations', 'clientintegration'),
  PlatformAnnouncement: new EntityClient('/v1/platform-announcements', 'platformannouncement'),
  ClientLifecycleEvent: new EntityClient('/v1/client-lifecycle-events', 'clientlifecycleevent'),
  Subscription: new EntityClient('/v1/subscriptions', 'subscription'),
  VoicemailMessage: new EntityClient('/v1/voicemail-messages', 'voicemailmessage'),
  OutreachLog: new EntityClient('/v1/outreach-logs', 'outreachlog'),
  DomainMapping: new EntityClient('/v1/domain-mappings', 'domainmapping'),
  CommissionLedger: new EntityClient('/v1/commission-ledgers', 'commissionledger'),
  Ticket: new EntityClient('/v1/tickets', 'ticket'),
  TicketMessage: new EntityClient('/v1/ticket-messages', 'ticketmessage'),
  ClientAgreement: new EntityClient('/v1/client-agreements', 'clientagreement'),
  ClientAgreementTemplate: new EntityClient('/v1/client-agreement-templates', 'clientagreementtemplate'),
  AgreementTemplate: new EntityClient('/v1/agreement-templates', 'agreementtemplate'),
  PartnerAgreement: new EntityClient('/v1/partner-agreements', 'partneragreement'),
  BrandSettings: new EntityClient('/v1/brand-settings', 'brandsettings'),
  AuditLog: new EntityClient('/v1/audit-logs', 'auditlog'),
  CalendarIntegration: new EntityClient('/v1/calendar-integrations', 'calendarintegration'),
  CallDecision: new EntityClient('/v1/call-decisions', 'calldecision'),
  ClientMessagingConfig: new EntityClient('/v1/client-messaging-configs', 'clientmessagingconfig'),
  ComplaintLog: new EntityClient('/v1/complaint-logs', 'complaintlog'),
  ConsentLog: new EntityClient('/v1/consent-logs', 'consentlog'),
  Contact: new EntityClient('/v1/contacts', 'contact'),
  CRMIntegration: new EntityClient('/v1/crm-integrations', 'crmintegration'),
  DataErasureRequest: new EntityClient('/v1/data-erasure-requests', 'dataerasurerequest'),
  IndustryTemplate: new EntityClient('/v1/industry-templates', 'industrytemplate'),
  KnowledgeBase: new EntityClient('/v1/knowledge-bases', 'knowledgebase'),
  KYCDocument: new EntityClient('/v1/kyc-documents', 'kycdocument'),
  MarketplaceIntegration: new EntityClient('/v1/marketplace-integrations', 'marketplaceintegration'),
  OwnerStatus: new EntityClient('/v1/owner-statuses', 'ownerstatus'),
  Partner: new EntityClient('/v1/partners', 'partner'),
  PartnerPayout: new EntityClient('/v1/partner-payouts', 'partnerpayout'),
  Payment: new EntityClient('/v1/payments', 'payment'),
  PaymentApprovalRequest: new EntityClient('/v1/payment-approval-requests', 'paymentapprovalrequest'),
  PlatformMessagingConfig: new EntityClient('/v1/platform-messaging-configs', 'platformmessagingconfig'),
  Referral: new EntityClient('/v1/referrals', 'referral'),
  RetentionConfig: new EntityClient('/v1/retention-configs', 'retentionconfig'),
  SmartfloAuth: new EntityClient('/v1/smartflo-auths', 'smartfloauth'),
  SocialMediaPost: new EntityClient('/v1/social-media-posts', 'socialmediapost'),
  TrustedClient: new EntityClient('/v1/trusted-clients', 'trustedclient'),
  TrustedContact: new EntityClient('/v1/trusted-contacts', 'trustedcontact'),
  UsageLog: new EntityClient('/v1/usage-logs', 'usagelog'),
  User: new EntityClient('/v1/users', 'user'),
  Invoice: new EntityClient('/v1/invoices', 'invoice'),
  WhatsAppTemplate: new EntityClient('/v1/whatsapp-templates', 'whatsapptemplate'),
  functions: {
    invoke: async (functionName, args) => {
      try {
        const res = await apiFetch(`/functions/${functionName}`, {
          method: "POST",
          body: JSON.stringify(args)
        });
        return res;
      } catch (err) {
        console.error(`Error invoking function ${functionName}:`, err);
        return { data: { success: false, error: err.message } };
      }
    }
  },

  integrations: {
    Core: {
      UploadFile: async ({ file }) => {
        const formData = new FormData();
        formData.append("file", file);
        const res = await apiFetch("/functions/azureBlobUpload", {
          method: "POST",
          body: formData,
        });
        if (!res.data || !res.data.success) {
          throw new Error(res.data?.error || "Upload failed");
        }
        return { file_url: res.data.file_url || res.data.file_uri };
      },
      InvokeLLM: async (args) => {
        console.warn("Mocking InvokeLLM", args);
        return { result: "Mocked LLM Output" };
      },
      ExtractDataFromUploadedFile: async (args) => {
        console.warn("Mocking ExtractDataFromUploadedFile");
        return { data: [] };
      },
      SendEmail: async (args) => {
        console.warn("Mocking SendEmail");
        return { success: true };
      }
    }
  }
};
