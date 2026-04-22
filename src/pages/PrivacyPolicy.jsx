import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="bg-slate-950 text-white py-12">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <Link to={createPageUrl('Home')}>
            <Button variant="ghost" className="text-slate-300 hover:text-white mb-4 -ml-4">
              <ArrowLeft className="w-4 h-4 mr-2" /> Back to Home
            </Button>
          </Link>
          <h1 className="text-4xl font-bold">Privacy Policy</h1>
          <p className="text-slate-400 mt-2">Last updated: February 11, 2026</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 prose prose-slate max-w-none">
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">1. Introduction</h2>
          <p className="text-gray-600 leading-relaxed">
            Bolify AI Technology ("Company," "we," "us," or "our"), operating the brand <strong>Bolify AI</strong>, 
            is committed to protecting the privacy of its users ("you," "your"). 
            This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our 
            AI-powered business automation platform and CRM services available at bolify.ai (the "Service").
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">2. Information We Collect</h2>
          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">2.1 Personal Information</h3>
          <p className="text-gray-600 leading-relaxed">When you register or use our Service, we may collect:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>Full name, email address, phone number</li>
            <li>Company name, business address, and GST number</li>
            <li>Billing and payment information (processed through third-party payment gateways)</li>
            <li>Login credentials and account preferences</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">2.2 Usage Data</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>Call logs, call recordings, and transcripts generated through our AI voice agents</li>
            <li>CRM data including leads, deals, contacts, and activities you create</li>
            <li>Browser type, IP address, device information, and access timestamps</li>
            <li>Pages visited, features used, and interaction patterns</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">2.3 Knowledge Base Data</h3>
          <p className="text-gray-600 leading-relaxed">
            Documents, PDFs, and files you upload to train your AI voice agents are stored securely and used solely 
            for the purpose of improving your agent's responses.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">3. How We Use Your Information</h2>
          <p className="text-gray-600 leading-relaxed">We use the collected information to:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>Provide, operate, and maintain the Bolify AI platform</li>
            <li>Process transactions and send billing-related communications</li>
            <li>Enable AI voice agent functionality including call placement, transcription, and analysis</li>
            <li>Manage your CRM data and provide industry-specific features</li>
            <li>Improve and personalize your experience</li>
            <li>Send service updates, security alerts, and support messages</li>
            <li>Comply with legal obligations and resolve disputes</li>
            <li>Detect, prevent, and address fraud or technical issues</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">4. Data Sharing and Disclosure</h2>
          <p className="text-gray-600 leading-relaxed">We do <strong>not</strong> sell your personal data. We may share information with:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li><strong>Service Providers:</strong> Third-party vendors who assist in payment processing, cloud hosting, telephony services (e.g., Smartflo/Tata Communications), AI processing (e.g., Azure Cognitive Services), and analytics.</li>
            <li><strong>Legal Requirements:</strong> When required by law, regulation, legal process, or governmental request.</li>
            <li><strong>Business Transfers:</strong> In connection with a merger, acquisition, or sale of company assets.</li>
            <li><strong>With Your Consent:</strong> For any purpose disclosed at the time of collection with your explicit consent.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">5. Data Storage and Security</h2>
          <p className="text-gray-600 leading-relaxed">
            Your data is stored on secure cloud infrastructure. We implement industry-standard security measures 
            including encryption in transit (TLS/SSL), encryption at rest, access controls, and regular security audits. 
            However, no method of electronic storage is 100% secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">6. Data Retention</h2>
          <p className="text-gray-600 leading-relaxed">
            We retain your personal data for as long as your account is active or as needed to provide services. 
            Call recordings and transcripts are retained for the duration of your subscription. Upon account deletion 
            or request, we will delete or anonymize your data within 90 days, except where retention is required by law.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">7. Your Rights</h2>
          <p className="text-gray-600 leading-relaxed">You have the right to:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>Access, update, or correct your personal information</li>
            <li>Request deletion of your account and associated data</li>
            <li>Withdraw consent for data processing</li>
            <li>Request a copy of your data in a portable format</li>
            <li>Object to processing of your personal data</li>
          </ul>
          <p className="text-gray-600 leading-relaxed mt-3">
            To exercise any of these rights, contact us at <a href="mailto:connect@bolify.ai" className="text-blue-600 hover:underline">connect@bolify.ai</a>.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">8. Cookies and Tracking</h2>
          <p className="text-gray-600 leading-relaxed">
            We use essential cookies and similar technologies to maintain your session and provide core functionality. 
            We may also use analytics cookies to understand platform usage. You can manage cookie preferences through 
            your browser settings.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">9. Third-Party Links</h2>
          <p className="text-gray-600 leading-relaxed">
            Our Service may contain links to third-party websites or services. We are not responsible for the privacy 
            practices of these external sites. We encourage you to review their privacy policies.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">10. Children's Privacy</h2>
          <p className="text-gray-600 leading-relaxed">
            Our Service is not directed to individuals under 18 years of age. We do not knowingly collect personal 
            information from minors. If we discover such data has been collected, we will promptly delete it.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">11. Changes to This Policy</h2>
          <p className="text-gray-600 leading-relaxed">
            We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated 
            revision date. Continued use of the Service after changes constitutes acceptance of the revised policy.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">12. Grievance Officer</h2>
          <p className="text-gray-600 leading-relaxed">
            In accordance with the Information Technology Act, 2000 and rules thereunder, the Grievance Officer for 
            the purpose of this Privacy Policy is:
          </p>
          <div className="bg-slate-50 rounded-lg p-4 mt-3 text-gray-600 text-sm">
            <p><strong>BolifyAI Sales Team</strong> — Data Protection Officer</p>
            <p><strong>Bolify AI Technology</strong></p>
            <p>Email: <a href="mailto:connect@bolify.ai" className="text-blue-600 hover:underline">connect@bolify.ai</a></p>
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">13. Contact Us</h2>
          <p className="text-gray-600 leading-relaxed">
            If you have questions or concerns about this Privacy Policy, please contact us at:
          </p>
          <div className="bg-slate-50 rounded-lg p-4 mt-3 text-gray-600 text-sm">
            <p><strong>Bolify AI Technology</strong></p>
            <p>Email: <a href="mailto:connect@bolify.ai" className="text-blue-600 hover:underline">connect@bolify.ai</a></p>
          </div>
        </section>
      </div>
    </div>
  );
}