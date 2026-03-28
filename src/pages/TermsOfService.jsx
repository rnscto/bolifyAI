import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function TermsOfService() {
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
          <h1 className="text-4xl font-bold">Terms of Service</h1>
          <p className="text-slate-400 mt-2">Last updated: February 11, 2026</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 prose prose-slate max-w-none">
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">1. Acceptance of Terms</h2>
          <p className="text-gray-600 leading-relaxed">
            These Terms of Service ("Terms") constitute a legally binding agreement between you ("User," "you," "your") 
            and <strong>Getway Technology</strong>, operating the brand <strong>Getway AI</strong> ("Company," "we," "us," "our"), 
            with its registered office at SCO: 24, 2nd Floor, Above Om Sweets, Huda Market, Sector-10A, Gurugram (HR) - 122001.
          </p>
          <p className="text-gray-600 leading-relaxed mt-3">
            By accessing or using our AI-powered business automation platform and CRM services at getway.in (the "Service"), 
            you agree to be bound by these Terms. If you do not agree, do not use the Service.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">2. Description of Service</h2>
          <p className="text-gray-600 leading-relaxed">Getway AI provides:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>AI-powered voice agents for automated outbound and inbound calling</li>
            <li>Call transcription and AI-driven conversation analysis</li>
            <li>Industry-specific Customer Relationship Management (CRM) tools</li>
            <li>Lead management, deal pipeline, and sales automation</li>
            <li>Knowledge base management for AI agent training</li>
            <li>DID (Direct Inward Dialing) number assignment and management</li>
            <li>Reporting, analytics, and integrations</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">3. Account Registration</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>You must provide accurate, complete, and current registration information.</li>
            <li>You are responsible for maintaining the confidentiality of your account credentials.</li>
            <li>You must be at least 18 years old to create an account.</li>
            <li>You are responsible for all activities under your account.</li>
            <li>You must notify us immediately of any unauthorized use of your account.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">4. Subscription Plans and Pricing</h2>
          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">4.1 Voice AI Agent Plan</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>Priced at ₹6,500 per channel per month, billed quarterly.</li>
            <li>Each channel includes a dedicated DID number and AI voice agent.</li>
            <li>Additional channels can be added at the same per-channel rate.</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">4.2 Custom Sales CRM Add-on</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>Priced at ₹1,999 per month.</li>
            <li>Includes a 7-day free trial period.</li>
            <li>After the trial, you will be charged unless you cancel before the trial ends.</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">4.3 Payment Terms</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>All prices are in Indian Rupees (INR) and exclusive of applicable taxes (GST).</li>
            <li>Payments are processed through authorized third-party payment gateways.</li>
            <li>Invoices are generated and available through your account dashboard.</li>
            <li>Late payments may result in service suspension.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">5. Free Trial</h2>
          <p className="text-gray-600 leading-relaxed">
            The CRM add-on includes a 7-day free trial. During the trial, you have full access to all CRM features. 
            If you do not cancel before the trial period ends, your subscription will automatically convert to a 
            paid subscription at the then-current rate. No charges are made during the trial period.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">6. Cancellation and Refunds</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>You may cancel your subscription at any time through your account dashboard or by contacting support.</li>
            <li>Cancellation takes effect at the end of the current billing period.</li>
            <li>No pro-rata refunds are provided for partial billing periods.</li>
            <li>Upon cancellation, your data will be retained for 90 days, after which it will be permanently deleted.</li>
            <li>Refund requests for specific circumstances may be submitted to <a href="mailto:connect@getway.in" className="text-blue-600 hover:underline">connect@getway.in</a> and will be reviewed on a case-by-case basis.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">7. Acceptable Use</h2>
          <p className="text-gray-600 leading-relaxed">You agree not to:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>Use the Service for any unlawful purpose or in violation of TRAI regulations.</li>
            <li>Make calls to numbers registered on the NDNC (National Do Not Call) registry without proper consent.</li>
            <li>Use the AI voice agents for harassment, spam, or fraudulent activity.</li>
            <li>Attempt to reverse-engineer, decompile, or hack any part of the Service.</li>
            <li>Upload malicious content, viruses, or harmful code.</li>
            <li>Share your account credentials with unauthorized third parties.</li>
            <li>Resell or redistribute the Service without written authorization.</li>
            <li>Violate any applicable local, state, national, or international laws.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">8. Intellectual Property</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>The Getway AI platform, including its software, design, logos, and documentation, is the exclusive property of Getway Technology.</li>
            <li>You retain ownership of your data, including leads, contacts, deals, and uploaded documents.</li>
            <li>By using the Service, you grant us a limited license to process your data solely for providing the Service.</li>
            <li>We do not claim ownership of any content you create or upload.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">9. AI-Generated Content</h2>
          <p className="text-gray-600 leading-relaxed">
            Our AI voice agents generate conversations, transcripts, summaries, and lead scoring based on automated 
            analysis. While we strive for accuracy, AI-generated content may contain errors or inaccuracies. 
            You acknowledge that:
          </p>
          <ul className="list-disc pl-6 text-gray-600 space-y-1 mt-2">
            <li>AI-generated analysis and recommendations are provided as guidance, not guarantees.</li>
            <li>You are responsible for verifying critical information before making business decisions.</li>
            <li>Call transcripts may not be 100% accurate and should be verified for important communications.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">10. Call Recording and Compliance</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>Calls made through Getway AI may be recorded for quality, training, and compliance purposes.</li>
            <li>You are solely responsible for obtaining necessary consents from call recipients as required by applicable laws.</li>
            <li>You must comply with all applicable telecom regulations, including TRAI guidelines.</li>
            <li>We are not liable for any non-compliance on your part regarding call recording regulations.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">11. Service Availability</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>We strive to maintain 99.9% uptime but do not guarantee uninterrupted service.</li>
            <li>Scheduled maintenance will be communicated in advance when possible.</li>
            <li>We are not liable for disruptions caused by third-party services (telephony providers, cloud infrastructure, etc.).</li>
            <li>We reserve the right to modify, suspend, or discontinue any feature with reasonable notice.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">12. Data Protection</h2>
          <p className="text-gray-600 leading-relaxed">
            Your use of the Service is also governed by our <Link to={createPageUrl('PrivacyPolicy')} className="text-blue-600 hover:underline">Privacy Policy</Link>, 
            which describes how we collect, use, and protect your data. By using the Service, you consent to 
            the data practices described in the Privacy Policy.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">13. Limitation of Liability</h2>
          <p className="text-gray-600 leading-relaxed">
            To the maximum extent permitted by applicable law:
          </p>
          <ul className="list-disc pl-6 text-gray-600 space-y-2 mt-2">
            <li>The Service is provided "AS IS" and "AS AVAILABLE" without warranties of any kind.</li>
            <li>We do not guarantee that the Service will meet your specific requirements or expectations.</li>
            <li>Our total liability for any claims arising from or related to the Service shall not exceed the amount paid by you in the 3 months preceding the claim.</li>
            <li>We are not liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or business opportunities.</li>
            <li>We are not responsible for the actions or results of AI voice agents in conversations with your leads or customers.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">14. Indemnification</h2>
          <p className="text-gray-600 leading-relaxed">
            You agree to indemnify and hold harmless Getway Technology, its officers, directors, 
            employees, and agents from any claims, liabilities, damages, losses, and expenses (including legal fees) 
            arising from your use of the Service, violation of these Terms, or infringement of any third-party rights.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">15. Termination</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>We may suspend or terminate your account if you violate these Terms.</li>
            <li>We may terminate your account with 30 days' notice for any reason.</li>
            <li>Upon termination, your right to use the Service ceases immediately.</li>
            <li>Your data will be available for export for 30 days after termination, after which it may be deleted.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">16. Governing Law and Dispute Resolution</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>These Terms are governed by and construed in accordance with the laws of India.</li>
            <li>Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of the courts in Jaipur, Rajasthan, India.</li>
            <li>Before initiating legal proceedings, parties agree to attempt resolution through good-faith negotiations for a period of 30 days.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">17. Modifications to Terms</h2>
          <p className="text-gray-600 leading-relaxed">
            We reserve the right to modify these Terms at any time. Material changes will be communicated via email 
            or through the Service at least 15 days before taking effect. Continued use of the Service after 
            modifications constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">18. Severability</h2>
          <p className="text-gray-600 leading-relaxed">
            If any provision of these Terms is held to be unenforceable or invalid, such provision will be modified 
            to the minimum extent necessary, and the remaining provisions will continue in full force and effect.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">19. Entire Agreement</h2>
          <p className="text-gray-600 leading-relaxed">
            These Terms, together with the Privacy Policy, constitute the entire agreement between you and 
            Getway Technology regarding the use of the Service and supersede all prior agreements 
            and understandings.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">20. Contact Us</h2>
          <p className="text-gray-600 leading-relaxed">
            For questions regarding these Terms, please contact us:
          </p>
          <div className="bg-slate-50 rounded-lg p-4 mt-3 text-gray-600 text-sm">
            <p><strong>Getway Technology</strong></p>
            <p>SCO: 24, 2nd Floor, Above Om Sweets, Huda Market, Sector-10A, Gurugram (HR) - 122001</p>
            <p>Email: <a href="mailto:connect@getway.in" className="text-blue-600 hover:underline">connect@getway.in</a></p>
            <p>Phone: <a href="tel:+919255522544" className="text-blue-600 hover:underline">92555-22544</a></p>
          </div>
        </section>
      </div>
    </div>
  );
}