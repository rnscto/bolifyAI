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
    q: "What is Getway AI?",
    a: "Getway AI is India's Business Automation Platform with two products: (1) Business AI Agent — automates outbound sales calls, qualifies leads, and manages your CRM 24/7; (2) Personal AI Assistant — answers your incoming calls, screens spam, takes messages, and keeps you in control via WhatsApp. Both work in Hindi and English."
  },
  {
    q: "How does the Personal AI Call Assistant work?",
    a: "Simply forward your calls to your Getway AI number. The AI answers on your behalf, identifies who's calling and why, classifies calls (Family/Business/Promotional/Spam), and sends you real-time WhatsApp alerts. You can reply with instructions like 'tell them I'm busy' or 'transfer to me' — all while staying private."
  },
  {
    q: "Can I control what my AI assistant says during a live call?",
    a: "Yes! Getway AI's owner-in-the-loop feature sends you real-time updates during calls via WhatsApp. You can instruct the AI mid-call — 'tell them to call back at 5 PM', 'schedule a meeting for tomorrow', or 'transfer the call to me'. The AI follows your instructions instantly."
  },
  {
    q: "How much does the Personal AI Assistant cost?",
    a: "The Personal AI Assistant starts at just ₹499/month with a 7-day free trial. The Business AI Agent starts at ₹6,500/month per channel. No credit card required for the free trial."
  },
  {
    q: "Which languages does Getway AI support?",
    a: "Getway AI supports English, Hindi, and bilingual (Hinglish) conversations. The AI automatically adapts to the language preferred by the caller."
  },
  {
    q: "Does the AI disclose that it's not a real person?",
    a: "Yes, Getway AI complies with TRAI and DPDP regulations. The AI identifies itself appropriately as an AI assistant at the start of conversations. For personal accounts, it introduces itself as your personal assistant without revealing your personal details."
  },
  {
    q: "Which industries does the Business AI Agent support?",
    a: "Getway AI supports 23+ industries including Real Estate, Healthcare, Education, Insurance, SaaS, Automobile, E-Commerce, and more. Each gets pre-built CRM templates and AI-trained voice agents."
  },
  {
    q: "Can Getway AI schedule meetings from my calls?",
    a: "Yes! Both the Personal and Business products can detect meeting requests during calls and schedule them. The Personal AI Assistant will confirm with you via WhatsApp before scheduling."
  },
  {
    q: "Is there a free trial?",
    a: "Yes, Getway AI offers a 7-day free trial for both Personal and Business plans with full access to all features. No credit card required."
  },
  {
    q: "How is my privacy protected with the Personal AI Assistant?",
    a: "Your AI assistant never reveals your personal phone number, location, or schedule to callers. All call data is encrypted and only accessible to you. You control exactly what information the AI can share."
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
            Everything you need to know about AI calling software, voice bots, and how Getway AI automates sales in India.
          </p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-40px" }}
          transition={{ duration: 0.35, ease: "easeOut" }}
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