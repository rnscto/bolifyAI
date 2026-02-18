import React from 'react';
import { motion } from 'framer-motion';
import { HelpCircle } from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const faqs = [
  {
    q: "What is VaaniAI?",
    a: "VaaniAI is an AI-powered voice agent platform that automates outbound sales calls, qualifies leads, and manages your entire sales pipeline. It works 24/7 in English and Hindi with a built-in industry-specific CRM."
  },
  {
    q: "Which languages does VaaniAI support?",
    a: "VaaniAI supports English, Hindi, and bilingual (mixed) conversations. The AI agents automatically adapt to the language preferred by the person on the call."
  },
  {
    q: "How much does VaaniAI cost?",
    a: "VaaniAI starts at ₹6,500 per month per channel. You get a 7-day free trial with full access to all features including AI voice agents, CRM, and analytics."
  },
  {
    q: "Which industries does VaaniAI support?",
    a: "VaaniAI supports 23+ industries including Real Estate, Healthcare, Education, Gym & Fitness, Insurance, SaaS, Automobile, Hospitality, Legal Services, and more. Each industry comes with pre-built CRM templates and AI prompts."
  },
  {
    q: "Can VaaniAI integrate with my existing CRM?",
    a: "Yes, VaaniAI integrates with Salesforce, HubSpot, Zoho, and other popular CRMs via webhooks and APIs. You can also use VaaniAI's built-in industry-specific CRM."
  },
  {
    q: "How does the AI voice agent work?",
    a: "VaaniAI uses advanced AI for natural language understanding and real-time speech recognition and synthesis. The agent calls leads, has natural conversations, qualifies them, and updates your CRM automatically."
  },
  {
    q: "Is there a free trial?",
    a: "Yes, VaaniAI offers a 7-day free trial with full access to all features. No credit card required. You can deploy AI voice agents, run campaigns, and use the CRM during the trial period."
  },
  {
    q: "Can VaaniAI be used for government services?",
    a: "Yes, VaaniAI has a dedicated e-Governance solution for government departments. It handles citizen queries about schemes, grievance registration, appointment booking, and service tracking in Hindi, English, and regional languages."
  }
];

export default function FAQSection() {
  return (
    <section id="faq" className="py-24 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1a365d]/5 text-[#1a365d] text-sm font-semibold mb-4">
            <HelpCircle className="w-3.5 h-3.5" /> FAQ
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Frequently Asked Questions
          </h2>
          <p className="text-lg text-gray-500 max-w-xl mx-auto">
            Everything you need to know about VaaniAI and how it can transform your sales process.
          </p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <Accordion type="single" collapsible className="space-y-3">
            {faqs.map((faq, i) => (
              <AccordionItem
                key={i}
                value={`faq-${i}`}
                className="bg-white rounded-xl border border-gray-200 px-6 shadow-sm data-[state=open]:shadow-md transition-shadow"
              >
                <AccordionTrigger className="text-left text-base font-medium text-gray-900 hover:no-underline py-5">
                  {faq.q}
                </AccordionTrigger>
                <AccordionContent className="text-gray-600 text-sm leading-relaxed pb-5">
                  {faq.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </div>
    </section>
  );
}