/**
 * ─── BolifyAI Central Asset Registry ──────────────────────────────────────────
 *
 * Single source of truth for all branded image/logo URLs.
 *
 * These files must be uploaded once to Azure Blob (Container: bolify-public).
 *   az storage blob upload --connection-string $AZURE_STORAGE_CONNECTION_STRING \
 *     --container-name bolify-public --name logos/bolifyai-logo.jpg \
 *     --file path/to/your/logo.jpg --overwrite true
 *
 * To replace: update the URL constants here and optionally add a cache-bust
 * query string (e.g., ?v=2). The branding system for Master Resellers /
 * Resellers / Master Admins reads their logo URL from the `brand` entity in
 * the database — see `getBrandForClient()` in Layout.jsx.
 */

const STORAGE_ACCOUNT = import.meta.env.VITE_AZURE_STORAGE_ACCOUNT || "tipsglms";
const PUBLIC_CONTAINER = import.meta.env.VITE_AZURE_PUBLIC_CONTAINER || "bolify-public";
const CDN_BASE = `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${PUBLIC_CONTAINER}`;

/**
 * Default BolifyAI logo (dark / coloured version).
 * Used on: Navbar, Footer, Landing pages, Onboarding, PartnerSignup
 */
export const BOLIFYAI_LOGO = `${CDN_BASE}/logos/bolifyai-logo.jpg`;

/**
 * BolifyAI logo — alternate (lighter / monochrome, if applicable).
 * Falls back to main logo if not uploaded separately.
 */
export const BOLIFYAI_LOGO_ALT = `${CDN_BASE}/logos/bolifyai-logo-alt.png`;

/**
 * Dashboard sidebar logo (slightly wider/shorter format).
 * For white-label resellers this is overridden by brand.dashboard_logo_url from DB.
 */
export const BOLIFYAI_LOGO_DASHBOARD = `${CDN_BASE}/logos/bolifyai-logo-dashboard.png`;

/**
 * Favicon path (served as a static file from /public, not from blob).
 */
export const BOLIFYAI_FAVICON = "/favicon.ico";
