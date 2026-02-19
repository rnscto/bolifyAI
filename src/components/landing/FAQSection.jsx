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
    q: "What is VaaniAI and how does AI calling work?",
    a: "VaaniAI is India's leading AI voice agent platform that automates outbound sales calls using artificial intelligence. The AI calling software qualifies leads, books meetings, and manages your sales pipeline 24/7 in Hindi and English — with a built-in industry-specific CRM."
  },
  {
    q: "Which languages does the AI voice bot support?",
    a: "VaaniAI's AI voice bot supports English, Hindi, and bilingual (mixed) conversations. The voice AI agents automatically adapt to the language preferred by the person on the call, making it ideal for Indian businesses."
  },
  {
    q: "How much does AI calling software cost in India?",
    a: "VaaniAI's AI calling software starts at just ₹6,500 per month per channel — one of the most affordable AI voice agent solutions in India. You get a 7-day free trial with full access to AI calling, CRM, and analytics. No credit card required."
  },
  {
    q: "Which industries can use VaaniAI's AI voice agents?",
    a: "VaaniAI supports 23+ industries including Real Estate, Healthcare, Education, Gym & Fitness, Insurance, SaaS, Automobile, Hospitality, Legal Services, E-Commerce, Banking, and more. Each industry gets pre-built CRM templates, sales workflows, and AI-trained voice agents."
  },
  {
    q: "Can VaaniAI integrate with Salesforce, HubSpot, or Zoho CRM?",
    a: "Yes, VaaniAI integrates seamlessly with Salesforce, HubSpot, Zoho, and other popular CRM platforms via webhooks and REST APIs. You can also use VaaniAI's built-in industry-specific sales CRM."
  },
  {
    q: "How does VaaniAI's AI voice agent qualify leads?",
    a: "VaaniAI's AI voice agent uses natural language processing (NLP) and real-time speech recognition to call leads, have natural human-like conversations, ask qualifying questions, detect buyer intent, score leads, and automatically update your CRM — all without human intervention."
  },
  {
    q: "Is there a free trial for the AI calling platform?",
    a: "Yes, VaaniAI offers a 7-day free trial with full access to all features — AI voice agents, automated outbound calling, lead management, call transcription, and CRM. No credit card required. Deploy your first AI calling campaign within minutes."
  },
  {
    q: "Can AI voice agents be used for government e-Governance services?",
    a: "Yes, VaaniAI provides a dedicated AI voice agent solution for e-Governance. Government departments can use it for citizen helplines, scheme information, grievance registration, appointment booking, and service status tracking — available in Hindi, English, and regional Indian languages."
  },
  {
    q: "How is VaaniAI different from other AI calling services in India?",
    a: "VaaniAI stands out with its combination of AI voice calling + built-in CRM + industry-specific templates. Unlike competitors, VaaniAI offers unlimited outbound calls, real-time AI transcript analysis, automatic lead scoring, pipeline automation, and multilingual support — all starting at ₹6,500/month."
  },
  {
    q: "Can VaaniAI replace my call center team?",
    a: "VaaniAI's AI voice agents can handle the entire outbound calling process — lead qualification, follow-ups, appointment booking, and CRM updates. While it can replace repetitive calling tasks, it also works alongside your sales team by routing hot leads to human agents for complex conversations."
  }
];

export default function FAQSection() {
  return (
    <section id="faq" className="py-16 lg:py-20 bg-gray-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#1a365d]/5 text-[#1a365d] text-sm font-semibold mb-4">
            <HelpCircle className="w-3.5 h-3.5" /> FAQ
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4">
            Frequently Asked Questions About AI Voice Agents
          </h2>
          <p className="text-lg text-gray-500 max-w-xl mx-auto">
            Everything you need to know about AI calling software, voice bots, and how VaaniAI automates sales in India.
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