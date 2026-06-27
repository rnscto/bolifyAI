import fetchSmartfloDIDs from "./fetchSmartfloDIDs.ts";
import initiateCall from "./initiateCall.ts";
import executeCampaign from "./executeCampaign.ts";
import adminListClients from "./adminListClients.ts";
import fetchCallRecording from "./fetchCallRecording.ts";
import rescoreLeadFromHistory from "./rescoreLeadFromHistory.ts";
import azureBlobSignedUrl from "./azureBlobSignedUrl.ts";
import azureBlobUpload from "./azureBlobUpload.ts";
import extractKBContent from "./extractKBContent.ts";
import generateConceptNote from "./generateConceptNote.ts";
import getClientDashboardStats from "./getClientDashboardStats.ts";
import getAgentDashboardStats from "./getAgentDashboardStats.ts";
import getClientAnalyticsStats from "./getClientAnalyticsStats.ts";
import getCampaignLiveStats from "./getCampaignLiveStats.ts";

import adminManageAgent from "./adminManageAgent.ts";

// AI Add-ons & Agents
import generatePromptAndPersona from "./generatePromptAndPersona.ts";
import uploadKBToStorage from "./uploadKBToStorage.ts";
import kbSearch from "./kbSearch.ts";

// CRM & Integrations
import sendGetwayCRM from "./sendGetwayCRM.ts";
import shopifyLookup from "./shopifyLookup.ts";

// Billing & Payments
import adminDirectTopup from "./adminDirectTopup.ts";
import submitPaymentApproval from "./submitPaymentApproval.ts";
import processPaymentApproval from "./processPaymentApproval.ts";
import createPaymentOrder from "./createPaymentOrder.ts";
import verifyPayment from "./verifyPayment.ts";
import generateInvoice from "./generateInvoice.ts";

// Communication & Email
import sendClientEmail from "./sendClientEmail.ts";
import sendAgreementEmail from "./sendAgreementEmail.ts";
import composeEmail from "./composeEmail.ts";

// WhatsApp & Messaging
import whatsappListTemplates from "./whatsappListTemplates.ts";
import whatsappCreateTemplate from "./whatsappCreateTemplate.ts";
import whatsappSendTemplate from "./whatsappSendTemplate.ts";
import aiTemplateDraft from "./aiTemplateDraft.ts";
import testMessagingConnection from "./testMessagingConnection.ts";
import testPlatformWhatsAppConnection from "./testPlatformWhatsAppConnection.ts";
import platformBroadcast from "./platformBroadcast.ts";
import sendPlatformWhatsApp from "./sendPlatformWhatsApp.ts";

// Post Call & AI Analysis
import processTranscript from "./processTranscript.ts";
import postCallActionExtractor from "./postCallActionExtractor.ts";
import campaignPostCall from "./campaignPostCall.ts";

// Core & Utility
import generateAuthKey from "./generateAuthKey.ts";

// Platform & Automation
import parseCallbacks from "./parseCallbacks.ts";
import backfillCallbackActivities from "./backfillCallbackActivities.ts";
import generateSocialContent from "./generateSocialContent.ts";
import retentionCall from "./retentionCall.ts";

export const functionRegistry: Record<string, Function> = {
  // Core & Utility
  generateAuthKey,
  fetchSmartfloDIDs,
  initiateCall,
  executeCampaign,
  adminListClients,
  adminManageAgent,
  fetchCallRecording,
  rescoreLeadFromHistory,
  azureBlobSignedUrl,
  azureBlobUpload,
  extractKBContent,
  generateConceptNote,
  getClientDashboardStats,
  getAgentDashboardStats,
  getClientAnalyticsStats,
  getCampaignLiveStats,
  
  // AI Add-ons & Agents
  generatePromptAndPersona,
  uploadKBToStorage,
  kbSearch,
  
  // CRM & Integrations
  sendGetwayCRM,
  shopifyLookup,
  
  // Platform & Automation
  parseCallbacks,
  backfillCallbackActivities,
  generateSocialContent,
  retentionCall,
  
  // Billing & Payments
  adminDirectTopup,
  submitPaymentApproval,
  processPaymentApproval,
  createPaymentOrder,
  verifyPayment,
  generateInvoice,
  
  // Communication
  sendClientEmail,
  sendAgreementEmail,
  composeEmail,
  
  // Messaging
  whatsappListTemplates,
  whatsappCreateTemplate,
  whatsappSendTemplate,
  aiTemplateDraft,
  testMessagingConnection,
  testPlatformWhatsAppConnection,
  platformBroadcast,
  sendPlatformWhatsApp,
  
  // Post Call & AI Analysis
  processTranscript,
  postCallActionExtractor,
  campaignPostCall,
};
