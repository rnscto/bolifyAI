/**
 * pages.config.js - Page routing configuration
 * 
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 * 
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 * 
 * Example file structure:
 * 
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *   
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *   
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 * 
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import APIDocs from './pages/APIDocs';
import AdminAgents from './pages/AdminAgents';
import AdminClients from './pages/AdminClients';
import AdminDIDs from './pages/AdminDIDs';
import AdminDashboard from './pages/AdminDashboard';
import AdminOutreach from './pages/AdminOutreach';
import AdminPartners from './pages/AdminPartners';
import AdminPayments from './pages/AdminPayments';
import AdminRetention from './pages/AdminRetention';
import AdminSubscriptions from './pages/AdminSubscriptions';
import AdminTrustedClients from './pages/AdminTrustedClients';
import AdminWebsiteLeads from './pages/AdminWebsiteLeads';
import AgentDashboard from './pages/AgentDashboard';
import CampaignDetail from './pages/CampaignDetail';
import ClientActivities from './pages/ClientActivities';
import ClientAgents from './pages/ClientAgents';
import ClientAnalytics from './pages/ClientAnalytics';
import ClientAutomationEngine from './pages/ClientAutomationEngine';
import ClientCRM from './pages/ClientCRM';
import ClientCRMContacts from './pages/ClientCRMContacts';
import ClientCRMDashboard from './pages/ClientCRMDashboard';
import ClientCRMDeals from './pages/ClientCRMDeals';
import ClientCRMReports from './pages/ClientCRMReports';
import ClientCRMSetup from './pages/ClientCRMSetup';
import ClientCallLogs from './pages/ClientCallLogs';
import ClientCallbacks from './pages/ClientCallbacks';
import ClientCampaigns from './pages/ClientCampaigns';
import ClientDashboard from './pages/ClientDashboard';
import ClientIntegrations from './pages/ClientIntegrations';
import ClientKnowledgeBase from './pages/ClientKnowledgeBase';
import ClientLeads from './pages/ClientLeads';
import ClientSettings from './pages/ClientSettings';
import ClientSubscription from './pages/ClientSubscription';
import ConceptNote from './pages/ConceptNote';
import Home from './pages/Home';
import LeadDetail from './pages/LeadDetail';
import Onboarding from './pages/Onboarding';
import PartnerDashboard from './pages/PartnerDashboard';
import PartnerSignup from './pages/PartnerSignup';
import PrivacyPolicy from './pages/PrivacyPolicy';
import RefundPolicy from './pages/RefundPolicy';
import TermsOfService from './pages/TermsOfService';
import __Layout from './Layout.jsx';


export const PAGES = {
    "APIDocs": APIDocs,
    "AdminAgents": AdminAgents,
    "AdminClients": AdminClients,
    "AdminDIDs": AdminDIDs,
    "AdminDashboard": AdminDashboard,
    "AdminOutreach": AdminOutreach,
    "AdminPartners": AdminPartners,
    "AdminPayments": AdminPayments,
    "AdminRetention": AdminRetention,
    "AdminSubscriptions": AdminSubscriptions,
    "AdminTrustedClients": AdminTrustedClients,
    "AdminWebsiteLeads": AdminWebsiteLeads,
    "AgentDashboard": AgentDashboard,
    "CampaignDetail": CampaignDetail,
    "ClientActivities": ClientActivities,
    "ClientAgents": ClientAgents,
    "ClientAnalytics": ClientAnalytics,
    "ClientAutomationEngine": ClientAutomationEngine,
    "ClientCRM": ClientCRM,
    "ClientCRMContacts": ClientCRMContacts,
    "ClientCRMDashboard": ClientCRMDashboard,
    "ClientCRMDeals": ClientCRMDeals,
    "ClientCRMReports": ClientCRMReports,
    "ClientCRMSetup": ClientCRMSetup,
    "ClientCallLogs": ClientCallLogs,
    "ClientCallbacks": ClientCallbacks,
    "ClientCampaigns": ClientCampaigns,
    "ClientDashboard": ClientDashboard,
    "ClientIntegrations": ClientIntegrations,
    "ClientKnowledgeBase": ClientKnowledgeBase,
    "ClientLeads": ClientLeads,
    "ClientSettings": ClientSettings,
    "ClientSubscription": ClientSubscription,
    "ConceptNote": ConceptNote,
    "Home": Home,
    "LeadDetail": LeadDetail,
    "Onboarding": Onboarding,
    "PartnerDashboard": PartnerDashboard,
    "PartnerSignup": PartnerSignup,
    "PrivacyPolicy": PrivacyPolicy,
    "RefundPolicy": RefundPolicy,
    "TermsOfService": TermsOfService,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};