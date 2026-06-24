const API_BASE_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "/api" : "http://localhost:8000/api");

function getToken() {
  return localStorage.getItem("bolifyai_token");
}

function setToken(token) {
  if (token) localStorage.setItem("bolifyai_token", token);
  else localStorage.removeItem("bolifyai_token");
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  
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
      errorMsg = err.error || errorMsg;
    } catch (e) {}
    throw new Error(errorMsg);
  }

  return response.json();
}

class EntityHandler {
  constructor(entityName) {
    this.entityName = entityName.toLowerCase();
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
    return apiFetch(`/entities/${this.entityName}?${searchParams.toString()}`);
  }

  async list(sort = "", limit = 100) {
    return this.filter({}, sort, limit);
  }

  async get(id) {
    return apiFetch(`/entities/${this.entityName}/${id}`);
  }

  async create(data) {
    return apiFetch(`/entities/${this.entityName}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async update(id, data) {
    return apiFetch(`/entities/${this.entityName}/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async delete(id) {
    return apiFetch(`/entities/${this.entityName}/${id}`, {
      method: "DELETE",
    });
  }

  subscribe(callback) {
    // Mock subscription
    console.warn(`Subscriptions are currently mocked for ${this.entityName}`);
    return () => {}; // Unsubscribe function
  }
}

const entitiesProxy = new Proxy({}, {
  get: function(target, prop) {
    if (typeof prop === "string") {
      if (!target[prop]) {
        target[prop] = new EntityHandler(prop);
      }
      return target[prop];
    }
    return target[prop];
  }
});

const functionsProxy = new Proxy({}, {
  get: function(target, prop) {
    if (prop === "invoke") {
      return async (functionName, args) => {
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
      };
    }
    return target[prop];
  }
});

const integrationsProxy = new Proxy({}, {
  get: function(target, prop) {
    if (prop === "Core") {
      return {
        UploadFile: async ({ file }) => {
          console.warn("Mocking UploadFile");
          return { file_url: "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/77d0f07f9_WhatsAppImage2026-04-16at102149AM.jpg" };
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
      };
    }
    return target[prop];
  }
});

export const base44 = {
  auth: {
    login: async (email, password) => {
      const res = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      return res.user;
    },
    signup: async (email, password, full_name) => {
      const res = await apiFetch("/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, full_name }),
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
    redirectToLogin: (redirectUrl) => {
      window.location.href = "/Login"; 
    }
  },
  entities: entitiesProxy,
  functions: functionsProxy,
  integrations: integrationsProxy,
};
