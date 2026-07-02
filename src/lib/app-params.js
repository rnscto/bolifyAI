/**
 * ─── App Parameters ───────────────────────────────────────────────────────────
 *
 * Reads startup URL parameters and session values for the BolifyAI portal.
 * Cleaned up to use `bolifyai_*` localStorage keys (not Base44 legacy keys).
 */

const isNode = typeof window === 'undefined';
const windowObj = isNode ? { localStorage: new Map() } : window;
const storage = windowObj.localStorage;

const toSnakeCase = (str) => {
	return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Reads a value from (in priority order):
 *   1. URL query parameter
 *   2. Provided defaultValue
 *   3. localStorage (`bolifyai_<paramName>`)
 */
const getAppParamValue = (paramName, { defaultValue = undefined, removeFromUrl = false } = {}) => {
	if (isNode) {
		return defaultValue;
	}
	// Use bolifyai_ prefix (not base44_)
	const storageKey = `bolifyai_${toSnakeCase(paramName)}`;
	const urlParams = new URLSearchParams(window.location.search);
	const searchParam = urlParams.get(paramName);
	if (removeFromUrl) {
		urlParams.delete(paramName);
		const newUrl = `${window.location.pathname}${urlParams.toString() ? `?${urlParams.toString()}` : ""
			}${window.location.hash}`;
		window.history.replaceState({}, document.title, newUrl);
	}
	if (searchParam) {
		storage.setItem(storageKey, searchParam);
		return searchParam;
	}
	if (defaultValue) {
		storage.setItem(storageKey, defaultValue);
		return defaultValue;
	}
	const storedValue = storage.getItem(storageKey);
	if (storedValue) {
		return storedValue;
	}
	return null;
}

const getAppParams = () => {
	// Clean up legacy base44 session tokens on clear_access_token=true
	if (getAppParamValue("clear_access_token") === 'true') {
		storage.removeItem('bolifyai_token');
		storage.removeItem('bolifyai_access_token');
		// Also clean any lingering legacy keys from previous Base44 sessions
		storage.removeItem('base44_access_token');
		storage.removeItem('token');
	}
	return {
		// Access token passed via URL on login redirect (e.g., SSO)
		token: getAppParamValue("access_token", { removeFromUrl: true }),
		fromUrl: getAppParamValue("from_url", { defaultValue: typeof window !== 'undefined' ? window.location.href : '' }),
	}
}

export const appParams = {
	...getAppParams()
}
