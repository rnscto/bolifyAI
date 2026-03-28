import { useEffect } from 'react';

export default function SEOHead() {
  useEffect(() => {
    document.title = 'Getway AI — Business Automation Platform | AI CRM | AI Agent | IVR | WhatsApp';
    
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

    setMeta('description', 'Getway AI is India\'s leading Business Automation Platform — AI CRM, AI Agent, IVR & WhatsApp automation. Digital Way to Grow your business. Hindi + English. 7-day free trial. 23+ industries.');
    setMeta('keywords', 'Getway AI, business automation platform, AI CRM India, AI agent, IVR, WhatsApp automation, AI voice agent India, AI calling software, automated outbound calling, AI sales automation, voice bot Hindi English, lead qualification AI, sales automation India');
    setMeta('author', 'Getway AI');
    setMeta('robots', 'index, follow, max-snippet:-1, max-image-preview:large');

    setMeta('og:title', 'Getway AI — Business Automation Platform | Digital Way to Grow', true);
    setMeta('og:description', 'AI CRM | AI Agent | IVR | WhatsApp automation for Indian businesses. 7-day free trial. 23+ industry CRMs.', true);
    setMeta('og:type', 'website', true);
    setMeta('og:locale', 'en_IN', true);
    setMeta('og:site_name', 'Getway AI', true);

    setMeta('twitter:card', 'summary_large_image');
    setMeta('twitter:title', 'Getway AI — Business Automation Platform | Digital Way to Grow');
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
      "name": "Getway AI",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "description": "Getway AI — Business Automation Platform. AI CRM, AI Agent, IVR & WhatsApp automation for Indian businesses. Digital Way to Grow.",
      "url": "https://getway.ai",
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
        "name": "Getway AI",
        "address": {
          "@type": "PostalAddress",
          "streetAddress": "101 Chanda Tower, Gandhi Path, Vaishali Nagar",
          "addressLocality": "Jaipur",
          "addressRegion": "Rajasthan",
          "postalCode": "302021",
          "addressCountry": "IN"
        },
        "telephone": "+91-7020609101",
        "email": "sales@getway.ai"
      }
    };

    let script = document.querySelector('#getwayai-jsonld');
    if (!script) {
      script = document.createElement('script');
      script.id = 'getwayai-jsonld';
      script.type = 'application/ld+json';
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify(jsonLd);

    const faqJsonLd = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "What is Getway AI?", "acceptedAnswer": { "@type": "Answer", "text": "Getway AI is India's leading Business Automation Platform with AI CRM, AI Agent, IVR & WhatsApp automation — the Digital Way to Grow your business." }},
        { "@type": "Question", "name": "How much does Getway AI cost?", "acceptedAnswer": { "@type": "Answer", "text": "Getway AI starts at ₹6,500/month per channel with unlimited calls. 7-day free trial, no credit card required." }},
        { "@type": "Question", "name": "Which industries can use Getway AI?", "acceptedAnswer": { "@type": "Answer", "text": "Getway AI supports 23+ industries including Real Estate, Healthcare, Education, Gym, Insurance, Automobile, and more with pre-built CRM templates." }}
      ]
    };

    let faqScript = document.querySelector('#getwayai-faq-jsonld');
    if (!faqScript) {
      faqScript = document.createElement('script');
      faqScript.id = 'getwayai-faq-jsonld';
      faqScript.type = 'application/ld+json';
      document.head.appendChild(faqScript);
    }
    faqScript.textContent = JSON.stringify(faqJsonLd);

  }, []);

  return null;
}