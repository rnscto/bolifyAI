import { useEffect } from 'react';

export default function SEOHead() {
  useEffect(() => {
    document.title = 'Bolify AI — Business Automation Platform | AI CRM | AI Agent | IVR | WhatsApp';
    
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

    setMeta('description', 'Bolify AI is India\'s leading Business Automation Platform — AI CRM, AI Agent, IVR & WhatsApp automation. Speak · Connect · Automate your business. Hindi + English. 7-day free trial. 23+ industries.');
    setMeta('keywords', 'Bolify AI, business automation platform, AI CRM India, AI agent, IVR, WhatsApp automation, AI voice agent India, AI calling software, automated outbound calling, AI sales automation, voice bot Hindi English, lead qualification AI, sales automation India');
    setMeta('author', 'Bolify AI');
    setMeta('robots', 'index, follow, max-snippet:-1, max-image-preview:large');

    setMeta('og:title', 'Bolify AI — Business Automation Platform | Speak · Connect · Automate', true);
    setMeta('og:description', 'AI CRM | AI Agent | IVR | WhatsApp automation for Indian businesses. 7-day free trial. 23+ industry CRMs.', true);
    setMeta('og:type', 'website', true);
    setMeta('og:locale', 'en_IN', true);
    setMeta('og:site_name', 'Bolify AI', true);

    setMeta('twitter:card', 'summary_large_image');
    setMeta('twitter:title', 'Bolify AI — Business Automation Platform | Speak · Connect · Automate');
    setMeta('twitter:description', 'AI-powered business automation in Hindi & English. Free trial available.');

    setMeta('geo.region', 'IN-RJ');
    setMeta('geo.placename', 'Jaipur, Rajasthan, India');
    setMeta('geo.position', '26.9124;75.7873');
    setMeta('ICBM', '26.9124, 75.7873');
    setMeta('content-language', 'en-IN');
    document.documentElement.lang = 'en-IN';

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "name": "Bolify AI",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "Bolify AI — Business Automation Platform. AI CRM, AI Agent, IVR & WhatsApp automation for Indian businesses. Speak · Connect · Automate.",
      "url": "https://bolify.ai",
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
        "name": "Bolify AI",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "101 Chanda Tower, Gandhi Path, Vaishali Nagar",
          "addressLocality": "Jaipur",
          "addressRegion": "Rajasthan",
          "postalCode": "302021",
          "addressCountry": "IN"
        },
        "telephone": "+91-7020609101",
        "email": "sales@bolify.ai"
      }
    };

    let script = document.querySelector('#bolifyai-jsonld');
    if (!script) {
      script = document.createElement('script');
      script.id = 'bolifyai-jsonld';
      script.type = 'application/ld+json';
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(jsonLd);

    const faqJsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is Bolify AI?", "acceptedAnswer": { "@type": "Answer", "text": "Bolify AI is India's leading Business Automation Platform with AI CRM, AI Agent, IVR & WhatsApp automation — the Speak · Connect · Automate your business." }},
        { "@type": "Question", "name": "How much does Bolify AI cost?", "acceptedAnswer": { "@type": "Answer", "text": "Bolify AI starts at ₹6,500/month per channel with unlimited calls. 7-day free trial, no credit card required." }},
        { "@type": "Question", "name": "Which industries can use Bolify AI?", "acceptedAnswer": { "@type": "Answer", "text": "Bolify AI supports 23+ industries including Real Estate, Healthcare, Education, Gym, Insurance, Automobile, and more with pre-built CRM templates." }}
      ]
    };

    let faqScript = document.querySelector('#bolifyai-faq-jsonld');
    if (!faqScript) {
      faqScript = document.createElement('script');
      faqScript.id = 'bolifyai-faq-jsonld';
      faqScript.type = 'application/ld+json';
      document.head.appendChild(faqScript);
    }
    faqScript.textContent = JSON.stringify(faqJsonLd);

  }, []);

  return null;
}