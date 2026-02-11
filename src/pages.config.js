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
import AdminSubscriptions from './pages/AdminSubscriptions';
import ClientActivities from './pages/ClientActivities';
import ClientAgents from './pages/ClientAgents';
import ClientCRM from './pages/ClientCRM';
import ClientCRMContacts from './pages/ClientCRMContacts';
import ClientCRMDashboard from './pages/ClientCRMDashboard';
import ClientCRMDeals from './pages/ClientCRMDeals';
import ClientCRMReports from './pages/ClientCRMReports';
import ClientCRMSetup from './pages/ClientCRMSetup';
import ClientCallLogs from './pages/ClientCallLogs';
import ClientDashboard from './pages/ClientDashboard';
import ClientKnowledgeBase from './pages/ClientKnowledgeBase';
import ClientLeads from './pages/ClientLeads';
import ClientSubscription from './pages/ClientSubscription';
import Home from './pages/Home';
import PrivacyPolicy from './pages/PrivacyPolicy';
import TermsOfService from './pages/TermsOfService';
import __Layout from './Layout.jsx';


export const PAGES = {
    "APIDocs": APIDocs,
    "AdminAgents": AdminAgents,
    "AdminClients": AdminClients,
    "AdminDIDs": AdminDIDs,
    "AdminDashboard": AdminDashboard,
    "AdminSubscriptions": AdminSubscriptions,
    "ClientActivities": ClientActivities,
    "ClientAgents": ClientAgents,
    "ClientCRM": ClientCRM,
    "ClientCRMContacts": ClientCRMContacts,
    "ClientCRMDashboard": ClientCRMDashboard,
    "ClientCRMDeals": ClientCRMDeals,
    "ClientCRMReports": ClientCRMReports,
    "ClientCRMSetup": ClientCRMSetup,
    "ClientCallLogs": ClientCallLogs,
    "ClientDashboard": ClientDashboard,
    "ClientKnowledgeBase": ClientKnowledgeBase,
    "ClientLeads": ClientLeads,
    "ClientSubscription": ClientSubscription,
    "Home": Home,
    "PrivacyPolicy": PrivacyPolicy,
    "TermsOfService": TermsOfService,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};