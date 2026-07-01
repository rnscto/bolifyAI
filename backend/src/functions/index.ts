import verifyPayment from "./verifyPayment.ts";
import whatsappCreateTemplate from "./whatsappCreateTemplate.ts";
import pgCampaignLeadSync from "./pgCampaignLeadSync.ts";
import sendWhatsAppMedia from "./sendWhatsAppMedia.ts";
import generateAgentPrompt from "./generateAgentPrompt.ts";
import enrollLeadsInSequence from "./enrollLeadsInSequence.ts";
import autoCloseStaleSupportTickets from "./autoCloseStaleSupportTickets.ts";
import testPlatformWhatsAppConnection from "./testPlatformWhatsAppConnection.ts";
import publicBulkCall from "./publicBulkCall.ts";
import processLeadGroupSequences from "./processLeadGroupSequences.ts";
import platformBroadcast from "./platformBroadcast.ts";
import adminListClients from "./adminListClients.ts";
import processScreeningOnCallUpdate from "./processScreeningOnCallUpdate.ts";
import linkTeamMemberOnLogin from "./linkTeamMemberOnLogin.ts";
import getAgentConfig from "./getAgentConfig.ts";
import assignSupportTicket from "./assignSupportTicket.ts";
import checkDemoSessionCap from "./checkDemoSessionCap.ts";
import smartfloInboundRouter from "./smartfloInboundRouter.ts";
import generateCandidateCV from "./generateCandidateCV.ts";
import reconcileClientStats from "./reconcileClientStats.ts";
import backfillCallbackActivities from "./backfillCallbackActivities.ts";
import publicLeadsIngest from "./publicLeadsIngest.ts";
import generateSocialContent from "./generateSocialContent.ts";
import pgLeadsStats from "./pgLeadsStats.ts";
import publicInitiateCall from "./publicInitiateCall.ts";
import getGeminiConfig from "./getGeminiConfig.ts";
import initiateCall from "./initiateCall.ts";
import whatsappSendTemplate from "./whatsappSendTemplate.ts";
import captureWebsiteLead from "./captureWebsiteLead.ts";
import exportBfsiAuditCsv from "./exportBfsiAuditCsv.ts";
import dispatchOutboundWebhook from "./dispatchOutboundWebhook.ts";
import sendInvoiceEmail from "./sendInvoiceEmail.ts";
import getPublicSupportTicket from "./getPublicSupportTicket.ts";
import twilioSearchAvailableNumbers from "./twilioSearchAvailableNumbers.ts";
import processTranscript from "./processTranscript.ts";
import matchCandidatesToJob from "./matchCandidatesToJob.ts";
import generateAuthKey from "./generateAuthKey.ts";
import twilioInitiateCall from "./twilioInitiateCall.ts";
import seedPricingCatalog from "./seedPricingCatalog.ts";
import inviteTeamMember from "./inviteTeamMember.ts";
import updateCallLog from "./updateCallLog.ts";
import logBfsiCompliance from "./logBfsiCompliance.ts";
import sendPlatformWhatsApp from "./sendPlatformWhatsApp.ts";
import submitPaymentApproval from "./submitPaymentApproval.ts";
import signalWireWebhook from "./signalWireWebhook.ts";
import diagnoseCampaignHealth from "./diagnoseCampaignHealth.ts";
import streamGeminiBrowser from "./streamGeminiBrowser.ts";
import enrollEmailCampaignRecipients from "./enrollEmailCampaignRecipients.ts";
import getLeadsPage from "./getLeadsPage.ts";
import createCalendarEvent from "./createCalendarEvent.ts";
import fetchSmartfloChannels from "./fetchSmartfloChannels.ts";
import diagnoseVaaniKb from "./diagnoseVaaniKb.ts";
import streamAudio from "./streamAudio.ts";
import renewSubscription from "./renewSubscription.ts";
import autoImportBookingToVaaniLead from "./autoImportBookingToVaaniLead.ts";
import dispatchPostCallEmail from "./dispatchPostCallEmail.ts";
import markDemoNoShows from "./markDemoNoShows.ts";
import createCustomInvoice from "./createCustomInvoice.ts";
import createIntlSubscription from "./createIntlSubscription.ts";
import submitTicketCSAT from "./submitTicketCSAT.ts";
import streamGeminiPersonal from "./streamGeminiPersonal.ts";
import autoEnrollSequence from "./autoEnrollSequence.ts";
import streamGeminiIncoming from "./streamGeminiIncoming.ts";
import kycEnforcement from "./kycEnforcement.ts";
import twilioInboundWebhook from "./twilioInboundWebhook.ts";
import getAgentDashboardStats from "./getAgentDashboardStats.ts";
import sendPlatformEmail from "./sendPlatformEmail.ts";
import extractDemoBookingFromCall from "./extractDemoBookingFromCall.ts";
import streamRealtimeOutgoing from "./streamRealtimeOutgoing.ts";
import whatsappListTemplates from "./whatsappListTemplates.ts";
import bfsiComplianceGate from "./bfsiComplianceGate.ts";
import getClientAnalyticsStats from "./getClientAnalyticsStats.ts";
import blogPrerender from "./blogPrerender.ts";
import adminIntlCreditAdjust from "./adminIntlCreditAdjust.ts";
import generateConceptNote from "./generateConceptNote.ts";
import googleSheetsPush from "./googleSheetsPush.ts";
import googleSheetsStatus from "./googleSheetsStatus.ts";
import invokeAzureLLM from "./invokeAzureLLM.ts";
import fetchTwilioRecording from "./fetchTwilioRecording.ts";
import maintainClientStats from "./maintainClientStats.ts";
import getCallLogsPage from "./getCallLogsPage.ts";
import composeEmail from "./composeEmail.ts";
import googleSheetsMeta from "./googleSheetsMeta.ts";
import sendDemoOtp from "./sendDemoOtp.ts";
import enrollWhatsAppCampaignRecipients from "./enrollWhatsAppCampaignRecipients.ts";
import pgBackfillLeads from "./pgBackfillLeads.ts";
import extractKBContent from "./extractKBContent.ts";
import linkStripeSubscriptionToClient from "./linkStripeSubscriptionToClient.ts";
import createTrialTopupOrder from "./createTrialTopupOrder.ts";
import checkSupportTicketSLA from "./checkSupportTicketSLA.ts";
import pgCampaignLeads from "./pgCampaignLeads.ts";
import processScreeningRetries from "./processScreeningRetries.ts";
import bulkUpdateSupportTickets from "./bulkUpdateSupportTickets.ts";
import sendClientEmail from "./sendClientEmail.ts";
import shopifyOAuthExchange from "./shopifyOAuthExchange.ts";
import importVerificationCases from "./importVerificationCases.ts";
import azureBlobUpload from "./azureBlobUpload.ts";
import notifyDemoAlert from "./notifyDemoAlert.ts";
import processScreeningResult from "./processScreeningResult.ts";
import buildAgentContext from "./buildAgentContext.ts";
import rcsDigitalWebhook from "./rcsDigitalWebhook.ts";
import createDemoBooking from "./createDemoBooking.ts";
import deleteAllLeads from "./deleteAllLeads.ts";
import trialExpiryCheck from "./trialExpiryCheck.ts";
import bfsiPostCallProcessor from "./bfsiPostCallProcessor.ts";
import setupTelegramWebhook from "./setupTelegramWebhook.ts";
import notifySupportTeamDemo from "./notifySupportTeamDemo.ts";
import initiateScreeningCall from "./initiateScreeningCall.ts";
import aiTemplateDraft from "./aiTemplateDraft.ts";
import replySupportTicket from "./replySupportTicket.ts";
import smartfloAgentDeprovisioner from "./smartfloAgentDeprovisioner.ts";
import postCallActionExtractor from "./postCallActionExtractor.ts";
import postDemoActionExtractor from "./postDemoActionExtractor.ts";
import verifyAddonPayment from "./verifyAddonPayment.ts";
import manageWebhook from "./manageWebhook.ts";
import verifyDemoAgentJoin from "./verifyDemoAgentJoin.ts";
import parseCallbacks from "./parseCallbacks.ts";
import verifyDemoOtp from "./verifyDemoOtp.ts";
import recordDemoConsent from "./recordDemoConsent.ts";
import campaignPostCall from "./campaignPostCall.ts";
import onNewLeadAutoTrigger from "./onNewLeadAutoTrigger.ts";
import generateFillerClip from "./generateFillerClip.ts";
import emailCampaignPoller from "./emailCampaignPoller.ts";
import generatePromptAndPersona from "./generatePromptAndPersona.ts";
import sendMeetingLinkEmail from "./sendMeetingLinkEmail.ts";
import pgCampaignLeadCounts from "./pgCampaignLeadCounts.ts";
import pgAnalytics from "./pgAnalytics.ts";
import bfsiProvisionPersona from "./bfsiProvisionPersona.ts";
import sendContentEmail from "./sendContentEmail.ts";
import publicLeadsExport from "./publicLeadsExport.ts";
import postCallOrchestrator from "./postCallOrchestrator.ts";
import diagnoseTwilioAuth from "./diagnoseTwilioAuth.ts";
import setupVaaniInternalTenant from "./setupVaaniInternalTenant.ts";
import executeScheduledActivities from "./executeScheduledActivities.ts";
import pgCallLogSync from "./pgCallLogSync.ts";
import bulkCloneAgent from "./bulkCloneAgent.ts";
import platformLifecycleNudges from "./platformLifecycleNudges.ts";
import pgBackfillCallLogs from "./pgBackfillCallLogs.ts";
import deleteCampaign from "./deleteCampaign.ts";
import cleanupOrphanKbs from "./cleanupOrphanKbs.ts";
import pgCampaignProgressBatch from "./pgCampaignProgressBatch.ts";
import aiSuggestReply from "./aiSuggestReply.ts";
import retentionCall from "./retentionCall.ts";
import executeWhatsAppCampaign from "./executeWhatsAppCampaign.ts";
import checkGoogleCalendarStatus from "./checkGoogleCalendarStatus.ts";
import generateProposalPDF from "./generateProposalPDF.ts";
import sendTelegramNotification from "./sendTelegramNotification.ts";
import dispatchPostCallWhatsApp from "./dispatchPostCallWhatsApp.ts";
import createStripeCheckout from "./createStripeCheckout.ts";
import sendWhatsAppTemplate from "./sendWhatsAppTemplate.ts";
import webVoiceAgent from "./webVoiceAgent.ts";
import emailUnsubscribe from "./emailUnsubscribe.ts";
import twilioListNumbers from "./twilioListNumbers.ts";
import zixflowWebhook from "./zixflowWebhook.ts";
import keepLLMWarm from "./keepLLMWarm.ts";
import unicommerceLookup from "./unicommerceLookup.ts";
import inboundSupportEmail from "./inboundSupportEmail.ts";
import cancelDemoBooking from "./cancelDemoBooking.ts";
import notifySupportTicketStatus from "./notifySupportTicketStatus.ts";
import autoCreateLeadFromInbound from "./autoCreateLeadFromInbound.ts";
import exportLeadsCsv from "./exportLeadsCsv.ts";
import checkTelegramWebhook from "./checkTelegramWebhook.ts";
import sendAcsSmtpEmail from "./sendAcsSmtpEmail.ts";
import pgLeadSync from "./pgLeadSync.ts";
import diagnoseCallHistory from "./diagnoseCallHistory.ts";
import getCampaignEligibleLeads from "./getCampaignEligibleLeads.ts";
import whatsappCampaignPoller from "./whatsappCampaignPoller.ts";
import generateInvoice from "./generateInvoice.ts";
import testMarketplaceConnection from "./testMarketplaceConnection.ts";
import bfsiDncAdd from "./bfsiDncAdd.ts";
import getDemoBooking from "./getDemoBooking.ts";
import twilioDirectTestCall from "./twilioDirectTestCall.ts";
import processSequences from "./processSequences.ts";
import diagnoseKbMappings from "./diagnoseKbMappings.ts";
import issueApiKey from "./issueApiKey.ts";
import callTransfer from "./callTransfer.ts";
import signalWireInitiateCall from "./signalWireInitiateCall.ts";
import generateManualInvoice from "./generateManualInvoice.ts";
import checkSignalWireCreds from "./checkSignalWireCreds.ts";
import rateBucketSweeper from "./rateBucketSweeper.ts";
import generateOgImage from "./generateOgImage.ts";
import removeTeamMember from "./removeTeamMember.ts";
import crmFollowupCheck from "./crmFollowupCheck.ts";
import mergeSupportTickets from "./mergeSupportTickets.ts";
import ecomSyncOrders from "./ecomSyncOrders.ts";
import rescheduleDemoBooking from "./rescheduleDemoBooking.ts";
import disconnectCall from "./disconnectCall.ts";
import repairKbMappings from "./repairKbMappings.ts";
import generatePartnerInvoice from "./generatePartnerInvoice.ts";
import sitemap from "./sitemap.ts";
import saveSignalWireConfig from "./saveSignalWireConfig.ts";
import telegramWebhook from "./telegramWebhook.ts";
import processAutoTriggerCalls from "./processAutoTriggerCalls.ts";
import listTeamMembers from "./listTeamMembers.ts";
import extractJobFromJD from "./extractJobFromJD.ts";
import rcsDigitalRcsSync from "./rcsDigitalRcsSync.ts";
import sendMeetingLinkWhatsApp from "./sendMeetingLinkWhatsApp.ts";
import chargeIntlOverage from "./chargeIntlOverage.ts";
import importLoanAccounts from "./importLoanAccounts.ts";
import rssFeed from "./rssFeed.ts";
import pgBackfillCampaignLeads from "./pgBackfillCampaignLeads.ts";
import extractCandidateFromCV from "./extractCandidateFromCV.ts";
import adminManageAgent from "./adminManageAgent.ts";
import pgLeadsOverlay from "./pgLeadsOverlay.ts";
import bookDemoFromCall from "./bookDemoFromCall.ts";
import executeCampaign from "./executeCampaign.ts";
import executeEmailCampaign from "./executeEmailCampaign.ts";
import postCallFollowup from "./postCallFollowup.ts";
import inboundAiAnalyze from "./inboundAiAnalyze.ts";
import streamTwilioOutgoing from "./streamTwilioOutgoing.ts";
import sendGetwayCRM from "./sendGetwayCRM.ts";
import fetchSmartfloDIDs from "./fetchSmartfloDIDs.ts";
import pgDashboardCounts from "./pgDashboardCounts.ts";
import checkDnc from "./checkDnc.ts";
import expireOwnerStatuses from "./expireOwnerStatuses.ts";
import leadQualification from "./leadQualification.ts";
import crmAutomation from "./crmAutomation.ts";
import smartfloWebhook from "./smartfloWebhook.ts";
import campaignPoller from "./campaignPoller.ts";
import whatsappAiAgent from "./whatsappAiAgent.ts";
import azureBlobSignedUrl from "./azureBlobSignedUrl.ts";
import getAnalyticsData from "./getAnalyticsData.ts";
import sendDemoReminder from "./sendDemoReminder.ts";
import syncVaaniSalesLeads from "./syncVaaniSalesLeads.ts";
import pgHealthCheck from "./pgHealthCheck.ts";
import sendVoiceAgentEmail from "./sendVoiceAgentEmail.ts";
import googleSheetsImport from "./googleSheetsImport.ts";
import sendWhatsAppManualReply from "./sendWhatsAppManualReply.ts";
import dailyTaskDigest from "./dailyTaskDigest.ts";
import sendRCSTemplate from "./sendRCSTemplate.ts";
import smartfloAgentProvisioner from "./smartfloAgentProvisioner.ts";
import checkSmartfloCreds from "./checkSmartfloCreds.ts";
import sendEmailFromTemplate from "./sendEmailFromTemplate.ts";
import debugSmartfloNumbers from "./debugSmartfloNumbers.ts";
import fetchCallRecording from "./fetchCallRecording.ts";
import streamSignalWireOutgoing from "./streamSignalWireOutgoing.ts";
import systemHealthCheck from "./systemHealthCheck.ts";
import resetMonthlyMinutes from "./resetMonthlyMinutes.ts";
import complaintCoolingOff from "./complaintCoolingOff.ts";
import testMessagingConnection from "./testMessagingConnection.ts";
import pgInitSchema from "./pgInitSchema.ts";
import whatsappAiAgentTest from "./whatsappAiAgentTest.ts";
import bfsiSendPaymentLink from "./bfsiSendPaymentLink.ts";
import processTransferRecording from "./processTransferRecording.ts";
import rescoreLeadFromHistory from "./rescoreLeadFromHistory.ts";
import loadBfsiCampaignAudience from "./loadBfsiCampaignAudience.ts";
import stripe_webhook from "./stripe-webhook.ts";
import sendProposalEmail from "./sendProposalEmail.ts";
import generateWhatsAppTemplate from "./generateWhatsAppTemplate.ts";
import createPaymentOrder from "./createPaymentOrder.ts";
import shopifyLookup from "./shopifyLookup.ts";
import uploadKBToStorage from "./uploadKBToStorage.ts";
import provisionSmartfloChannel from "./provisionSmartfloChannel.ts";
import buildLeadContext from "./buildLeadContext.ts";
import listApiKeys from "./listApiKeys.ts";
import pgDidConcurrency from "./pgDidConcurrency.ts";
import getClientDashboardStats from "./getClientDashboardStats.ts";
import dispatchCrmWebhook from "./dispatchCrmWebhook.ts";
import reserveDIDForClient from "./reserveDIDForClient.ts";
import sendDemoBookingWhatsApp from "./sendDemoBookingWhatsApp.ts";
import processPaymentApproval from "./processPaymentApproval.ts";
import reportAffiliateSale from "./reportAffiliateSale.ts";
import downloadInvoice from "./downloadInvoice.ts";
import sendBroadcast from "./sendBroadcast.ts";
import getRealtimeConfig from "./getRealtimeConfig.ts";
import streamAudioGemini from "./streamAudioGemini.ts";
import sendViaClientProvider from "./sendViaClientProvider.ts";
import createCampaignWithLeads from "./createCampaignWithLeads.ts";
import getCampaignLiveStats from "./getCampaignLiveStats.ts";
import createAddonOrder from "./createAddonOrder.ts";
import getLeadTimelineCalls from "./getLeadTimelineCalls.ts";
import toggleTicketShareLink from "./toggleTicketShareLink.ts";
import syncPlatformTemplates from "./syncPlatformTemplates.ts";
import streamGeminiDemo from "./streamGeminiDemo.ts";
import applyTrialMigration from "./applyTrialMigration.ts";
import getDemoSlots from "./getDemoSlots.ts";
import notifyVaaniDemoBooked from "./notifyVaaniDemoBooked.ts";

import adminDirectTopup from "./adminDirectTopup.ts";
import twilioWebhook from "./twilioWebhook.ts";
import retentionFollowup from "./retentionFollowup.ts";
import getLeadCallHistory from "./getLeadCallHistory.ts";
import streamRealtimeIncoming from "./streamRealtimeIncoming.ts";
import rcsDigitalTemplateSync from "./rcsDigitalTemplateSync.ts";
import notifyUrgentTicket from "./notifyUrgentTicket.ts";
import createSupportTicket from "./createSupportTicket.ts";
import kbSearch from "./kbSearch.ts";
import streamGeminiOutgoing from "./streamGeminiOutgoing.ts";
import sendAgreementEmail from "./sendAgreementEmail.ts";

export const functionRegistry: Record<string, any> = {
  "verifyPayment": verifyPayment,
  "whatsappCreateTemplate": whatsappCreateTemplate,
  "pgCampaignLeadSync": pgCampaignLeadSync,
  "sendWhatsAppMedia": sendWhatsAppMedia,
  "generateAgentPrompt": generateAgentPrompt,
  "enrollLeadsInSequence": enrollLeadsInSequence,
  "autoCloseStaleSupportTickets": autoCloseStaleSupportTickets,
  "testPlatformWhatsAppConnection": testPlatformWhatsAppConnection,
  "publicBulkCall": publicBulkCall,
  "processLeadGroupSequences": processLeadGroupSequences,
  "platformBroadcast": platformBroadcast,
  "adminListClients": adminListClients,
  "processScreeningOnCallUpdate": processScreeningOnCallUpdate,
  "linkTeamMemberOnLogin": linkTeamMemberOnLogin,
  "getAgentConfig": getAgentConfig,
  "assignSupportTicket": assignSupportTicket,
  "checkDemoSessionCap": checkDemoSessionCap,
  "smartfloInboundRouter": smartfloInboundRouter,
  "generateCandidateCV": generateCandidateCV,
  "reconcileClientStats": reconcileClientStats,
  "backfillCallbackActivities": backfillCallbackActivities,
  "publicLeadsIngest": publicLeadsIngest,
  "generateSocialContent": generateSocialContent,
  "pgLeadsStats": pgLeadsStats,
  "publicInitiateCall": publicInitiateCall,
  "getGeminiConfig": getGeminiConfig,
  "initiateCall": initiateCall,
  "whatsappSendTemplate": whatsappSendTemplate,
  "captureWebsiteLead": captureWebsiteLead,
  "exportBfsiAuditCsv": exportBfsiAuditCsv,
  "dispatchOutboundWebhook": dispatchOutboundWebhook,
  "sendInvoiceEmail": sendInvoiceEmail,
  "getPublicSupportTicket": getPublicSupportTicket,
  "twilioSearchAvailableNumbers": twilioSearchAvailableNumbers,
  "processTranscript": processTranscript,
  "matchCandidatesToJob": matchCandidatesToJob,
  "generateAuthKey": generateAuthKey,
  "twilioInitiateCall": twilioInitiateCall,
  "seedPricingCatalog": seedPricingCatalog,
  "inviteTeamMember": inviteTeamMember,
  "updateCallLog": updateCallLog,
  "logBfsiCompliance": logBfsiCompliance,
  "sendPlatformWhatsApp": sendPlatformWhatsApp,
  "submitPaymentApproval": submitPaymentApproval,
  "signalWireWebhook": signalWireWebhook,
  "diagnoseCampaignHealth": diagnoseCampaignHealth,
  "streamGeminiBrowser": streamGeminiBrowser,
  "enrollEmailCampaignRecipients": enrollEmailCampaignRecipients,
  "getLeadsPage": getLeadsPage,
  "createCalendarEvent": createCalendarEvent,
  "fetchSmartfloChannels": fetchSmartfloChannels,
  "diagnoseVaaniKb": diagnoseVaaniKb,
  "streamAudio": streamAudio,
  "renewSubscription": renewSubscription,
  "autoImportBookingToVaaniLead": autoImportBookingToVaaniLead,
  "dispatchPostCallEmail": dispatchPostCallEmail,
  "markDemoNoShows": markDemoNoShows,
  "createCustomInvoice": createCustomInvoice,
  "createIntlSubscription": createIntlSubscription,
  "submitTicketCSAT": submitTicketCSAT,
  "streamGeminiPersonal": streamGeminiPersonal,
  "autoEnrollSequence": autoEnrollSequence,
  "streamGeminiIncoming": streamGeminiIncoming,
  "kycEnforcement": kycEnforcement,
  "twilioInboundWebhook": twilioInboundWebhook,
  "getAgentDashboardStats": getAgentDashboardStats,
  "sendPlatformEmail": sendPlatformEmail,
  "extractDemoBookingFromCall": extractDemoBookingFromCall,
  "streamRealtimeOutgoing": streamRealtimeOutgoing,
  "whatsappListTemplates": whatsappListTemplates,
  "bfsiComplianceGate": bfsiComplianceGate,
  "getClientAnalyticsStats": getClientAnalyticsStats,
  "blogPrerender": blogPrerender,
  "adminIntlCreditAdjust": adminIntlCreditAdjust,
  "generateConceptNote": generateConceptNote,
  "googleSheetsPush": googleSheetsPush,
  "googleSheetsStatus": googleSheetsStatus,
  "invokeAzureLLM": invokeAzureLLM,
  "fetchTwilioRecording": fetchTwilioRecording,
  "maintainClientStats": maintainClientStats,
  "getCallLogsPage": getCallLogsPage,
  "composeEmail": composeEmail,
  "googleSheetsMeta": googleSheetsMeta,
  "sendDemoOtp": sendDemoOtp,
  "enrollWhatsAppCampaignRecipients": enrollWhatsAppCampaignRecipients,
  "pgBackfillLeads": pgBackfillLeads,
  "extractKBContent": extractKBContent,
  "linkStripeSubscriptionToClient": linkStripeSubscriptionToClient,
  "createTrialTopupOrder": createTrialTopupOrder,
  "checkSupportTicketSLA": checkSupportTicketSLA,
  "pgCampaignLeads": pgCampaignLeads,
  "processScreeningRetries": processScreeningRetries,
  "bulkUpdateSupportTickets": bulkUpdateSupportTickets,
  "sendClientEmail": sendClientEmail,
  "shopifyOAuthExchange": shopifyOAuthExchange,
  "importVerificationCases": importVerificationCases,
  "azureBlobUpload": azureBlobUpload,
  "notifyDemoAlert": notifyDemoAlert,
  "processScreeningResult": processScreeningResult,
  "buildAgentContext": buildAgentContext,
  "rcsDigitalWebhook": rcsDigitalWebhook,
  "createDemoBooking": createDemoBooking,
  "deleteAllLeads": deleteAllLeads,
  "trialExpiryCheck": trialExpiryCheck,
  "bfsiPostCallProcessor": bfsiPostCallProcessor,
  "setupTelegramWebhook": setupTelegramWebhook,
  "notifySupportTeamDemo": notifySupportTeamDemo,
  "initiateScreeningCall": initiateScreeningCall,
  "aiTemplateDraft": aiTemplateDraft,
  "replySupportTicket": replySupportTicket,
  "smartfloAgentDeprovisioner": smartfloAgentDeprovisioner,
  "postCallActionExtractor": postCallActionExtractor,
  "postDemoActionExtractor": postDemoActionExtractor,
  "verifyAddonPayment": verifyAddonPayment,
  "manageWebhook": manageWebhook,
  "verifyDemoAgentJoin": verifyDemoAgentJoin,
  "parseCallbacks": parseCallbacks,
  "verifyDemoOtp": verifyDemoOtp,
  "recordDemoConsent": recordDemoConsent,
  "campaignPostCall": campaignPostCall,
  "onNewLeadAutoTrigger": onNewLeadAutoTrigger,
  "generateFillerClip": generateFillerClip,
  "emailCampaignPoller": emailCampaignPoller,
  "generatePromptAndPersona": generatePromptAndPersona,
  "sendMeetingLinkEmail": sendMeetingLinkEmail,
  "pgCampaignLeadCounts": pgCampaignLeadCounts,
  "pgAnalytics": pgAnalytics,
  "bfsiProvisionPersona": bfsiProvisionPersona,
  "sendContentEmail": sendContentEmail,
  "publicLeadsExport": publicLeadsExport,
  "postCallOrchestrator": postCallOrchestrator,
  "diagnoseTwilioAuth": diagnoseTwilioAuth,
  "setupVaaniInternalTenant": setupVaaniInternalTenant,
  "executeScheduledActivities": executeScheduledActivities,
  "pgCallLogSync": pgCallLogSync,
  "bulkCloneAgent": bulkCloneAgent,
  "platformLifecycleNudges": platformLifecycleNudges,
  "pgBackfillCallLogs": pgBackfillCallLogs,
  "deleteCampaign": deleteCampaign,
  "cleanupOrphanKbs": cleanupOrphanKbs,
  "pgCampaignProgressBatch": pgCampaignProgressBatch,
  "aiSuggestReply": aiSuggestReply,
  "retentionCall": retentionCall,
  "executeWhatsAppCampaign": executeWhatsAppCampaign,
  "checkGoogleCalendarStatus": checkGoogleCalendarStatus,
  "generateProposalPDF": generateProposalPDF,
  "sendTelegramNotification": sendTelegramNotification,
  "dispatchPostCallWhatsApp": dispatchPostCallWhatsApp,
  "createStripeCheckout": createStripeCheckout,
  "sendWhatsAppTemplate": sendWhatsAppTemplate,
  "webVoiceAgent": webVoiceAgent,
  "emailUnsubscribe": emailUnsubscribe,
  "twilioListNumbers": twilioListNumbers,
  "zixflowWebhook": zixflowWebhook,
  "keepLLMWarm": keepLLMWarm,
  "unicommerceLookup": unicommerceLookup,
  "inboundSupportEmail": inboundSupportEmail,
  "cancelDemoBooking": cancelDemoBooking,
  "notifySupportTicketStatus": notifySupportTicketStatus,
  "autoCreateLeadFromInbound": autoCreateLeadFromInbound,
  "exportLeadsCsv": exportLeadsCsv,
  "checkTelegramWebhook": checkTelegramWebhook,
  "sendAcsSmtpEmail": sendAcsSmtpEmail,
  "pgLeadSync": pgLeadSync,
  "diagnoseCallHistory": diagnoseCallHistory,
  "getCampaignEligibleLeads": getCampaignEligibleLeads,
  "whatsappCampaignPoller": whatsappCampaignPoller,
  "generateInvoice": generateInvoice,
  "testMarketplaceConnection": testMarketplaceConnection,
  "bfsiDncAdd": bfsiDncAdd,
  "getDemoBooking": getDemoBooking,
  "twilioDirectTestCall": twilioDirectTestCall,
  "processSequences": processSequences,
  "diagnoseKbMappings": diagnoseKbMappings,
  "issueApiKey": issueApiKey,
  "callTransfer": callTransfer,
  "signalWireInitiateCall": signalWireInitiateCall,
  "generateManualInvoice": generateManualInvoice,
  "checkSignalWireCreds": checkSignalWireCreds,
  "rateBucketSweeper": rateBucketSweeper,
  "generateOgImage": generateOgImage,
  "removeTeamMember": removeTeamMember,
  "crmFollowupCheck": crmFollowupCheck,
  "mergeSupportTickets": mergeSupportTickets,
  "ecomSyncOrders": ecomSyncOrders,
  "rescheduleDemoBooking": rescheduleDemoBooking,
  "disconnectCall": disconnectCall,
  "repairKbMappings": repairKbMappings,
  "generatePartnerInvoice": generatePartnerInvoice,
  "sitemap": sitemap,
  "saveSignalWireConfig": saveSignalWireConfig,
  "telegramWebhook": telegramWebhook,
  "processAutoTriggerCalls": processAutoTriggerCalls,
  "listTeamMembers": listTeamMembers,
  "extractJobFromJD": extractJobFromJD,
  "rcsDigitalRcsSync": rcsDigitalRcsSync,
  "sendMeetingLinkWhatsApp": sendMeetingLinkWhatsApp,
  "chargeIntlOverage": chargeIntlOverage,
  "importLoanAccounts": importLoanAccounts,
  "rssFeed": rssFeed,
  "pgBackfillCampaignLeads": pgBackfillCampaignLeads,
  "extractCandidateFromCV": extractCandidateFromCV,
  "adminManageAgent": adminManageAgent,
  "pgLeadsOverlay": pgLeadsOverlay,
  "bookDemoFromCall": bookDemoFromCall,
  "executeCampaign": executeCampaign,
  "executeEmailCampaign": executeEmailCampaign,
  "postCallFollowup": postCallFollowup,
  "inboundAiAnalyze": inboundAiAnalyze,
  "streamTwilioOutgoing": streamTwilioOutgoing,
  "sendGetwayCRM": sendGetwayCRM,
  "fetchSmartfloDIDs": fetchSmartfloDIDs,
  "pgDashboardCounts": pgDashboardCounts,
  "checkDnc": checkDnc,
  "expireOwnerStatuses": expireOwnerStatuses,
  "leadQualification": leadQualification,
  "crmAutomation": crmAutomation,
  "smartfloWebhook": smartfloWebhook,
  "campaignPoller": campaignPoller,
  "whatsappAiAgent": whatsappAiAgent,
  "azureBlobSignedUrl": azureBlobSignedUrl,
  "getAnalyticsData": getAnalyticsData,
  "sendDemoReminder": sendDemoReminder,
  "syncVaaniSalesLeads": syncVaaniSalesLeads,
  "pgHealthCheck": pgHealthCheck,
  "sendVoiceAgentEmail": sendVoiceAgentEmail,
  "googleSheetsImport": googleSheetsImport,
  "sendWhatsAppManualReply": sendWhatsAppManualReply,
  "dailyTaskDigest": dailyTaskDigest,
  "sendRCSTemplate": sendRCSTemplate,
  "smartfloAgentProvisioner": smartfloAgentProvisioner,
  "checkSmartfloCreds": checkSmartfloCreds,
  "sendEmailFromTemplate": sendEmailFromTemplate,
  "debugSmartfloNumbers": debugSmartfloNumbers,
  "fetchCallRecording": fetchCallRecording,
  "streamSignalWireOutgoing": streamSignalWireOutgoing,
  "systemHealthCheck": systemHealthCheck,
  "resetMonthlyMinutes": resetMonthlyMinutes,
  "complaintCoolingOff": complaintCoolingOff,
  "testMessagingConnection": testMessagingConnection,
  "pgInitSchema": pgInitSchema,
  "whatsappAiAgentTest": whatsappAiAgentTest,
  "bfsiSendPaymentLink": bfsiSendPaymentLink,
  "processTransferRecording": processTransferRecording,
  "rescoreLeadFromHistory": rescoreLeadFromHistory,
  "loadBfsiCampaignAudience": loadBfsiCampaignAudience,
  "stripe-webhook": stripe_webhook,
  "sendProposalEmail": sendProposalEmail,
  "generateWhatsAppTemplate": generateWhatsAppTemplate,
  "createPaymentOrder": createPaymentOrder,
  "shopifyLookup": shopifyLookup,
  "uploadKBToStorage": uploadKBToStorage,
  "provisionSmartfloChannel": provisionSmartfloChannel,
  "buildLeadContext": buildLeadContext,
  "listApiKeys": listApiKeys,
  "pgDidConcurrency": pgDidConcurrency,
  "getClientDashboardStats": getClientDashboardStats,
  "dispatchCrmWebhook": dispatchCrmWebhook,
  "reserveDIDForClient": reserveDIDForClient,
  "sendDemoBookingWhatsApp": sendDemoBookingWhatsApp,
  "processPaymentApproval": processPaymentApproval,
  "reportAffiliateSale": reportAffiliateSale,
  "downloadInvoice": downloadInvoice,
  "sendBroadcast": sendBroadcast,
  "getRealtimeConfig": getRealtimeConfig,
  "streamAudioGemini": streamAudioGemini,
  "sendViaClientProvider": sendViaClientProvider,
  "createCampaignWithLeads": createCampaignWithLeads,
  "getCampaignLiveStats": getCampaignLiveStats,
  "createAddonOrder": createAddonOrder,
  "getLeadTimelineCalls": getLeadTimelineCalls,
  "toggleTicketShareLink": toggleTicketShareLink,
  "syncPlatformTemplates": syncPlatformTemplates,
  "streamGeminiDemo": streamGeminiDemo,
  "applyTrialMigration": applyTrialMigration,
  "getDemoSlots": getDemoSlots,
  "notifyVaaniDemoBooked": notifyVaaniDemoBooked,

  "adminDirectTopup": adminDirectTopup,
  "twilioWebhook": twilioWebhook,
  "retentionFollowup": retentionFollowup,
  "getLeadCallHistory": getLeadCallHistory,
  "streamRealtimeIncoming": streamRealtimeIncoming,
  "rcsDigitalTemplateSync": rcsDigitalTemplateSync,
  "notifyUrgentTicket": notifyUrgentTicket,
  "createSupportTicket": createSupportTicket,
  "kbSearch": kbSearch,
  "streamGeminiOutgoing": streamGeminiOutgoing,
  "sendAgreementEmail": sendAgreementEmail,
};
