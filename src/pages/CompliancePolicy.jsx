import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { Shield, Database, Phone, Eye, Lock, Clock, UserCheck, Scale, ArrowLeft } from 'lucide-react';

const LOGO_URL = "https://media.base44.com/images/public/69c78272bd33d5309cbe2b7c/77d0f07f9_WhatsAppImage2026-04-16at102149AM.jpg";

export default function CompliancePolicy() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-900 to-blue-700 text-white">
        <div className="max-w-4xl mx-auto px-4 py-12">
          <Link to={createPageUrl('Home')} className="inline-flex items-center text-blue-200 hover:text-white text-sm mb-6">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to Home
          </Link>
          <div className="flex items-center gap-3 mb-4">
            <img src={LOGO_URL} alt="Bolify AI" className="h-12 object-contain rounded-md" />
          </div>
          <h1 className="text-3xl font-bold mb-2">Platform Data Retention & Compliance Policy</h1>
          <p className="text-blue-200">Version 2.1 — Effective March 2026</p>
          <div className="flex flex-wrap gap-3 mt-4">
            <span className="px-3 py-1 bg-white/10 rounded-full text-xs">DPDP Act 2023</span>
            <span className="px-3 py-1 bg-white/10 rounded-full text-xs">TRAI TCCCPR</span>
            <span className="px-3 py-1 bg-white/10 rounded-full text-xs">IT Act 2000</span>
            <span className="px-3 py-1 bg-white/10 rounded-full text-xs">MeitY 2026 Guidelines</span>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-12">
        <div className="prose prose-gray max-w-none">

          {/* 1. Introduction */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Shield className="w-6 h-6 text-blue-600" /> 1. Introduction & Scope
            </h2>
            <p className="text-gray-600 mt-3">
              Bolify AI ("Platform"), operated by Bolify AI Technology, 
              is an AI-powered business automation platform. This policy governs how we collect, process, store, and 
              delete personal data in compliance with Indian regulatory frameworks.
            </p>
            <p className="text-gray-600">
              As a <strong>Data Processor</strong> under the Digital Personal Data Protection (DPDP) Act 2023, 
              we process voice data on behalf of our clients (Data Fiduciaries/Principal Entities). This policy 
              applies to all users, clients, partners, and data subjects.
            </p>
          </section>

          {/* 2. Data Residency */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Database className="w-6 h-6 text-green-600" /> 2. Data Residency & Storage
            </h2>
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 mt-3">
              <p className="font-semibold text-green-800">🇮🇳 All data resides on Indian servers</p>
              <p className="text-sm text-green-700 mt-1">
                Voice recordings, transcripts, lead data, and all personal data are stored exclusively on 
                Indian cloud infrastructure (Azure Central India / South India regions). No cross-border 
                data transfer occurs for processing or storage of Indian citizen data.
              </p>
            </div>
            <ul className="mt-4 space-y-2 text-gray-600">
              <li>• <strong>Voice Recordings:</strong> Stored encrypted (AES-256) on Azure India servers</li>
              <li>• <strong>Transcripts & AI Analysis:</strong> Processed via Azure OpenAI India deployment</li>
              <li>• <strong>Lead & CRM Data:</strong> Stored in India-region database instances</li>
              <li>• <strong>Audit Logs:</strong> Maintained for minimum 180 days per IT Rules</li>
            </ul>
          </section>

          {/* 3. TRAI Compliance */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Phone className="w-6 h-6 text-orange-600" /> 3. Telecom Compliance (TRAI & TCCCPR)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-2">AI Disclosure</h3>
                <p className="text-sm text-gray-600">
                  All AI-generated calls are required to disclose their AI nature within the first 15 seconds. 
                  Clients must include mandatory AI identification in their agent system prompts.
                </p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-2">DLT Registration</h3>
                <p className="text-sm text-gray-600">
                  Clients (Principal Entities) must register on the TRAI DLT portal with approved headers 
                  and templates before using the platform for automated calling.
                </p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-2">Number Series</h3>
                <p className="text-sm text-gray-600">
                  The platform supports 140-series (Marketing) and 160-series (Service) numbers as mandated 
                  by TRAI for automated calling operations.
                </p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-2">Complaint Handling</h3>
                <p className="text-sm text-gray-600">
                  Per March 2026 TRAI amendments, if a DID receives 3 unique complaints, the platform 
                  automatically initiates a "Cooling Off" period and suspends the number immediately.
                </p>
              </div>
            </div>
          </section>

          {/* 4. DPDP Act */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Eye className="w-6 h-6 text-purple-600" /> 4. Data Privacy (DPDP Act 2023/2025 Rules)
            </h2>
            <h3 className="text-lg font-semibold mt-4">4.1 Purpose Limitation</h3>
            <p className="text-gray-600">
              Data collected for a specific purpose (e.g., order tracking) cannot be repurposed (e.g., marketing 
              AI training) without separate, explicit consent being logged. Our database architecture enforces 
              purpose-specific consent tracking.
            </p>
            <h3 className="text-lg font-semibold mt-4">4.2 Consent Management</h3>
            <p className="text-gray-600">
              All clients must provide explicit consent during onboarding for data processing, AI voice usage, 
              and data retention. Consent logs are immutable and timestamped with version tracking.
            </p>
            <h3 className="text-lg font-semibold mt-4">4.3 Automated Data Purging</h3>
            <p className="text-gray-600">
              Call recordings and transcripts are automatically deleted after the configurable retention period 
              (default: 30 days) unless a legal mandate requires longer retention. Clients can configure their 
              retention period from their dashboard.
            </p>
            <h3 className="text-lg font-semibold mt-4">4.4 Right to Erasure</h3>
            <p className="text-gray-600">
              Data subjects can request erasure of their personal data. Erasure requests are processed within 
              72 hours. Clients can view and manage erasure requests from their Compliance Dashboard.
            </p>
          </section>

          {/* 5. IT & AI Governance */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Scale className="w-6 h-6 text-red-600" /> 5. IT & AI Governance (MeitY 2026)
            </h2>
            <h3 className="text-lg font-semibold mt-4">5.1 Provenance Metadata</h3>
            <p className="text-gray-600">
              All AI-generated audio streams carry metadata identifying them as synthetically generated content (SGI), 
              aligned with C2PA standards for AI transparency.
            </p>
            <h3 className="text-lg font-semibold mt-4">5.2 Emergency Takedown (3-Hour Rule)</h3>
            <p className="text-gray-600">
              If government or court flags an AI-generated conversation as unlawful or misleading, the platform 
              can pause the specific agent/campaign within minutes via our Emergency Takedown system. All takedown 
              actions are logged in the immutable audit trail.
            </p>
            <h3 className="text-lg font-semibold mt-4">5.3 Audit Logs</h3>
            <p className="text-gray-600">
              Unalterable audit logs are maintained for at least 180 days, recording: who initiated each call, 
              which script/prompt was used, which DID was utilized, and all administrative actions taken on the platform.
            </p>
          </section>

          {/* 6. Security */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Lock className="w-6 h-6 text-blue-600" /> 6. Security Measures
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold mb-1">Encryption at Rest</h3>
                <p className="text-sm text-gray-600">AES-256 encryption for all stored recordings, transcripts, and personal data.</p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold mb-1">Encryption in Transit</h3>
                <p className="text-sm text-gray-600">TLS 1.2+ for all data transmission including live call streams.</p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold mb-1">RBAC</h3>
                <p className="text-sm text-gray-600">Role-Based Access Control ensuring users only access authorized data.</p>
              </div>
              <div className="border rounded-xl p-4">
                <h3 className="font-semibold mb-1">Bias Monitoring</h3>
                <p className="text-sm text-gray-600">Periodic LLM audits to ensure fair treatment across accents and dialects.</p>
              </div>
            </div>
          </section>

          {/* 7. DPO */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <UserCheck className="w-6 h-6 text-teal-600" /> 7. Data Protection Officer
            </h2>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 mt-4">
              <p className="font-bold text-blue-900 text-lg">Satish Saini</p>
              <p className="text-blue-800 mt-1">Data Protection Officer</p>
              <div className="mt-3 space-y-1 text-sm text-blue-700">
                <p>📧 Email: <a href="mailto:connect@bolify.ai" className="underline">connect@bolify.ai</a></p>
                <p>📞 Phone: <a href="tel:+919255522544" className="underline">92555-22544</a></p>
                <p>🏢 Bolify AI Technology</p>
              </div>
              <p className="text-xs text-blue-600 mt-3">
                For data access, correction, erasure, or portability requests, please contact the DPO. 
                We respond to all requests within 72 hours.
              </p>
            </div>
          </section>

          {/* 8. Summary Table */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Clock className="w-6 h-6 text-gray-600" /> 8. Compliance Summary
            </h2>
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="border px-4 py-3 text-left font-semibold">Regulation</th>
                    <th className="border px-4 py-3 text-left font-semibold">Responsibility</th>
                    <th className="border px-4 py-3 text-left font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="border px-4 py-3">TRAI TCCCPR</td><td className="border px-4 py-3">Telecom Integrity</td><td className="border px-4 py-3">AI Disclosure + 140/160 Numbering + Opt-out + Complaint Cooling Off</td></tr>
                  <tr className="bg-gray-50"><td className="border px-4 py-3">DPDP Act 2023</td><td className="border px-4 py-3">Privacy</td><td className="border px-4 py-3">Indian Hosting + Consent Logs + Auto Purging + Erasure Workflows</td></tr>
                  <tr><td className="border px-4 py-3">IT Rules 2026</td><td className="border px-4 py-3">Content Safety</td><td className="border px-4 py-3">3-Hour Takedown + 180-Day Audit Logs + Provenance Metadata</td></tr>
                  <tr className="bg-gray-50"><td className="border px-4 py-3">Security Standards</td><td className="border px-4 py-3">Infrastructure</td><td className="border px-4 py-3">AES-256 + TLS 1.2+ + RBAC + End-to-End Encryption</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-xs text-gray-400 text-center mt-8">
            Last updated: March 2026 | Version 2.1 | © {new Date().getFullYear()} Bolify AI Technology
          </p>
        </div>
      </div>
    </div>
  );
}