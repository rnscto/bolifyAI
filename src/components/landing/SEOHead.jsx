import { useEffect } from 'react';

export default function SEOHead() {
  useEffect(() => {
    // Dynamic SEO meta tags
    document.title = 'VaaniAI — India\'s #1 AI Voice Agent & Calling Software | ₹6,500/mo';
    
    const setMeta = (name, content, isProperty = false) => {
      const attr = isProperty ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    // Primary SEO
    setMeta('description', 'VaaniAI is India\'s leading AI voice agent platform for automated sales calling, lead qualification & CRM. Hindi + English. ₹6,500/mo per channel. 7-day free trial. 23+ industries.');
    setMeta('keywords', 'AI voice agent India, AI calling software, automated outbound calling, AI sales automation, voice bot Hindi English, lead qualification AI, CRM India, AI phone agent, VaaniAI, sales automation India, cold calling AI, AI telecalling, e-governance voice bot');
    setMeta('author', 'Tech Brainbucks Infosoft Pvt Ltd');
    setMeta('robots', 'index, follow, max-snippet:-1, max-image-preview:large');

    // Open Graph
    setMeta('og:title', 'VaaniAI — AI Voice Agent & Calling Software for Indian Businesses', true);
    setMeta('og:description', 'Automate sales calls with AI in Hindi & English. ₹6,500/mo. 7-day free trial. 23+ industry CRMs.', true);
    setMeta('og:type', 'website', true);
    setMeta('og:locale', 'en_IN', true);
    setMeta('og:site_name', 'VaaniAI', true);

    // Twitter
    setMeta('twitter:card', 'summary_large_image');
    setMeta('twitter:title', 'VaaniAI — India\'s #1 AI Voice Agent Platform');
    setMeta('twitter:description', 'AI-powered sales calling in Hindi & English. ₹6,500/mo. Free trial.');

    // GEO tags
    setMeta('geo.region', 'IN-RJ');
    setMeta('geo.placename', 'Jaipur, Rajasthan, India');
    setMeta('geo.position', '26.9124;75.7873');
    setMeta('ICBM', '26.9124, 75.7873');

    // Language
    setMeta('content-language', 'en-IN');
    document.documentElement.lang = 'en-IN';

    // JSON-LD Structured Data
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "VaaniAI",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "India's #1 AI voice agent platform for automated sales calling, lead qualification, and CRM pipeline management in Hindi & English.",
      "url": "https://vaaniai.io",
      "offers": {
        "@type": "Offer",
        "price": "6500",
        "priceCurrency": "INR",
        "priceValidUntil": "2027-12-31",
        "availability": "https://schema.org/InStock"
      },
      "aggregateRating": {
        "@type": "AggregateRating",
        "ratingValue": "4.8",
        "ratingCount": "150",
        "bestRating": "5"
      },
      "provider": {
        "@type": "Organization",
        "name": "Tech Brainbucks Infosoft Pvt Ltd",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "101 Chanda Tower, Gandhi Path, Vaishali Nagar",
          "addressLocality": "Jaipur",
          "addressRegion": "Rajasthan",
          "postalCode": "302021",
          "addressCountry": "IN"
        },
        "telephone": "+91-7020609101",
        "email": "sales@vaaniai.io"
      }
    };

    let script = document.querySelector('#vaaniai-jsonld');
    if (!script) {
      script = document.createElement('script');
      script.id = 'vaaniai-jsonld';
      script.type = 'application/ld+json';
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(jsonLd);

    // FAQ structured data
    const faqJsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is VaaniAI?", "acceptedAnswer": { "@type": "Answer", "text": "VaaniAI is India's leading AI voice agent platform that automates outbound sales calls using artificial intelligence in Hindi and English." }},
        { "@type": "Question", "name": "How much does AI calling software cost in India?", "acceptedAnswer": { "@type": "Answer", "text": "VaaniAI starts at ₹6,500/month per channel with unlimited calls. 7-day free trial, no credit card required." }},
        { "@type": "Question", "name": "Which industries can use VaaniAI?", "acceptedAnswer": { "@type": "Answer", "text": "VaaniAI supports 23+ industries including Real Estate, Healthcare, Education, Gym, Insurance, Automobile, and more with pre-built CRM templates." }}
      ]
    };

    let faqScript = document.querySelector('#vaaniai-faq-jsonld');
    if (!faqScript) {
      faqScript = document.createElement('script');
      faqScript.id = 'vaaniai-faq-jsonld';
      faqScript.type = 'application/ld+json';
      document.head.appendChild(faqScript);
    }
    faqScript.textContent = JSON.stringify(faqJsonLd);

  }, []);

  return null;
}