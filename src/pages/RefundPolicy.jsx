import React from 'react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '../utils';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function RefundPolicy() {
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
          <h1 className="text-4xl font-bold">Refund & Cancellation Policy</h1>
          <p className="text-slate-400 mt-2">Last updated: February 22, 2026</p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12 prose prose-slate max-w-none">
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">1. Overview</h2>
          <p className="text-gray-600 leading-relaxed">
            This Refund & Cancellation Policy applies to all subscription plans and services offered by 
            <strong> Bolify AI Technology</strong>, operating the brand 
            <strong> Bolify AI</strong>, through the platform at bolify.ai. By subscribing to our services, you agree 
            to the terms outlined in this policy.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">2. Subscription Plans</h2>
          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">2.1 Voice AI Agent Plan</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>Billed quarterly at ₹6,500 per channel per month.</li>
            <li>Each billing cycle covers 3 months of service.</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">2.2 Custom Sales CRM Add-on</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-1">
            <li>Billed monthly at ₹1,999 per month.</li>
            <li>Includes a 7-day free trial for new subscribers.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">3. Free Trial Policy</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>The CRM add-on comes with a <strong>7-day free trial</strong> period.</li>
            <li>No charges are applied during the trial period.</li>
            <li>You may cancel at any time during the trial without being charged.</li>
            <li>If not cancelled before the trial ends, your subscription will automatically convert to a paid plan and you will be billed at the standard rate.</li>
            <li>No refund is applicable once the trial converts to a paid subscription and billing begins.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">4. Cancellation Policy</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>You may cancel your subscription at any time through your account dashboard or by contacting us at <a href="mailto:connect@bolify.ai" className="text-blue-600 hover:underline">connect@bolify.ai</a>.</li>
            <li>Cancellation will take effect at the <strong>end of the current billing period</strong>.</li>
            <li>You will continue to have access to the service until the end of the paid period.</li>
            <li>No partial or pro-rata refunds will be issued for unused days within a billing cycle.</li>
            <li>Upon cancellation, your data will be retained for <strong>90 days</strong>, after which it will be permanently deleted.</li>
            <li>You may request a data export within the 90-day retention window.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">5. Refund Policy</h2>
          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">5.1 General Policy</h3>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>All subscription payments are <strong>non-refundable</strong> by default once the billing cycle has commenced.</li>
            <li>No refunds are provided for partial use of services during a billing period.</li>
            <li>Downgrading channels during a billing period does not entitle you to a refund for the difference.</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">5.2 Exceptions — When Refunds May Be Considered</h3>
          <p className="text-gray-600 leading-relaxed">Refund requests will be reviewed on a <strong>case-by-case basis</strong> under the following circumstances:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-2 mt-2">
            <li><strong>Duplicate Payment:</strong> If you were charged more than once for the same billing period due to a technical error.</li>
            <li><strong>Service Unavailability:</strong> If the platform experienced significant, prolonged downtime (exceeding 72 continuous hours) due to issues on our end that materially impacted your business.</li>
            <li><strong>Billing Error:</strong> If you were incorrectly charged for services you did not subscribe to or for a plan different from the one selected.</li>
            <li><strong>First-Time Subscription:</strong> If you request cancellation within <strong>48 hours</strong> of your first-ever paid subscription and have not made any calls through the platform, a full refund may be considered.</li>
          </ul>

          <h3 className="text-lg font-semibold text-gray-800 mt-4 mb-2">5.3 Non-Refundable Scenarios</h3>
          <p className="text-gray-600 leading-relaxed">Refunds will <strong>not</strong> be issued in the following cases:</p>
          <ul className="list-disc pl-6 text-gray-600 space-y-2 mt-2">
            <li>Dissatisfaction with AI-generated call quality or outcomes (AI results may vary).</li>
            <li>Failure to use the service during the billing period.</li>
            <li>Account suspension or termination due to violation of our Terms of Service.</li>
            <li>Changes in your business needs or decision to switch to another provider.</li>
            <li>Third-party service disruptions (e.g., telecom network issues, payment gateway errors on your bank's side).</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">6. How to Request a Refund</h2>
          <p className="text-gray-600 leading-relaxed">To submit a refund request, follow these steps:</p>
          <ol className="list-decimal pl-6 text-gray-600 space-y-2 mt-2">
            <li>Send an email to <a href="mailto:connect@bolify.ai" className="text-blue-600 hover:underline">connect@bolify.ai</a> with the subject line: <strong>"Refund Request – [Your Company Name]"</strong>.</li>
            <li>Include the following details:
              <ul className="list-disc pl-6 space-y-1 mt-1">
                <li>Your registered email address</li>
                <li>Company name</li>
                <li>Payment transaction ID or invoice number</li>
                <li>Reason for the refund request</li>
                <li>Supporting evidence (screenshots, payment receipts, etc.)</li>
              </ul>
            </li>
            <li>Our team will acknowledge your request within <strong>2 business days</strong>.</li>
            <li>Refund requests will be reviewed and a decision communicated within <strong>7 business days</strong>.</li>
          </ol>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">7. Refund Processing</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>Approved refunds will be processed within <strong>7–10 business days</strong> from the date of approval.</li>
            <li>Refunds will be credited to the <strong>original payment method</strong> used during the transaction.</li>
            <li>Bank processing times may vary — please allow additional time for the refund to reflect in your account.</li>
            <li>Any applicable taxes (GST) paid will be refunded proportionally.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">8. DID Number (Channel) Add-ons</h2>
          <ul className="list-disc pl-6 text-gray-600 space-y-2">
            <li>Additional DID channels purchased mid-cycle are billed on a pro-rata basis for the remainder of the billing period.</li>
            <li>Refunds for additional channels are not available once provisioned and activated.</li>
            <li>You may remove additional channels at the next billing renewal.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">9. Modifications to This Policy</h2>
          <p className="text-gray-600 leading-relaxed">
            We reserve the right to update or modify this Refund & Cancellation Policy at any time. Any changes will 
            be posted on this page with an updated revision date. Continued use of the Service after changes constitutes 
            acceptance of the revised policy. Material changes will be communicated via email at least 15 days in advance.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4">10. Contact Us</h2>
          <p className="text-gray-600 leading-relaxed">
            For refund-related queries or to submit a request, please contact us:
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