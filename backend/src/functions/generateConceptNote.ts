import { Context } from "hono";
import { jsPDF } from "jspdf";

export default async function (c: Context) {
  try {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = 210;
    const margin = 20;
    const contentWidth = pageWidth - 2 * margin;
    let y = 20;

    const addPageIfNeeded = (needed = 30) => {
      if (y + needed > 275) {
        doc.addPage();
        y = 20;
      }
    };

    const addTitle = (text: string, size = 18) => {
      addPageIfNeeded(20);
      doc.setFontSize(size);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 51, 102);
      doc.text(text, pageWidth / 2, y, { align: 'center' });
      y += size * 0.6;
    };

    const addSectionTitle = (text: string) => {
      addPageIfNeeded(20);
      y += 4;
      doc.setFillColor(0, 51, 102);
      doc.rect(margin, y - 5, contentWidth, 9, 'F');
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(255, 255, 255);
      doc.text(text, margin + 3, y + 1);
      y += 10;
    };

    const addParagraph = (text: string) => {
      addPageIfNeeded(15);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      const lines = doc.splitTextToSize(text, contentWidth);
      doc.text(lines, margin, y);
      y += lines.length * 5 + 3;
    };

    const addBullet = (text: string) => {
      addPageIfNeeded(10);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      doc.text('•', margin + 3, y);
      const lines = doc.splitTextToSize(text, contentWidth - 10);
      doc.text(lines, margin + 8, y);
      y += lines.length * 5 + 2;
    };

    const addKeyValue = (key: string, value: string) => {
      addPageIfNeeded(10);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(0, 51, 102);
      doc.text(key + ':', margin + 3, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      const lines = doc.splitTextToSize(value, contentWidth - 45);
      doc.text(lines, margin + 45, y);
      y += lines.length * 5 + 2;
    };

    const addTable = (headers: string[], rows: string[][]) => {
      addPageIfNeeded(15 + rows.length * 8);
      const colWidth = contentWidth / headers.length;
      // Header
      doc.setFillColor(0, 51, 102);
      doc.rect(margin, y - 4, contentWidth, 8, 'F');
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(255, 255, 255);
      headers.forEach((h, i) => {
        doc.text(h, margin + i * colWidth + 2, y);
      });
      y += 6;
      // Rows
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      rows.forEach((row, ri) => {
        addPageIfNeeded(10);
        if (ri % 2 === 0) {
          doc.setFillColor(240, 245, 250);
          doc.rect(margin, y - 4, contentWidth, 7, 'F');
        }
        row.forEach((cell, ci) => {
          doc.text(String(cell), margin + ci * colWidth + 2, y);
        });
        y += 7;
      });
      y += 3;
    };

    // ===== COVER PAGE =====
    doc.setFillColor(0, 51, 102);
    doc.rect(0, 0, pageWidth, 60, 'F');
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('CONCEPT NOTE', pageWidth / 2, 30, { align: 'center' });
    doc.setFontSize(14);
    doc.text('VaaniAI — AI-Powered Voice Agent for e-Governance', pageWidth / 2, 42, { align: 'center' });
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text('Government of Rajasthan', pageWidth / 2, 52, { align: 'center' });

    y = 75;
    addKeyValue('Submitted To', 'Department of Information Technology & Communications, Government of Rajasthan');
    addKeyValue('Submitted By', 'VaaniAI Technologies');
    addKeyValue('Date', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }));
    addKeyValue('Document Type', 'Concept Note — AI Voice Agent for Citizen Services');
    addKeyValue('Version', '1.0');
    addKeyValue('Classification', 'Confidential');

    // ===== PAGE 2 — EXECUTIVE SUMMARY =====
    doc.addPage();
    y = 20;
    addSectionTitle('1. EXECUTIVE SUMMARY');
    addParagraph('VaaniAI proposes an AI-powered multilingual voice agent platform designed to transform citizen engagement for the Government of Rajasthan. The solution enables 24/7 automated voice-based interactions in Hindi, English, and Rajasthani dialects, handling citizen queries about government schemes, grievance registration, appointment booking, and service status tracking.');
    addParagraph('By leveraging cutting-edge AI technologies including Natural Language Processing (NLP), Automatic Speech Recognition (ASR), and Text-to-Speech (TTS), VaaniAI eliminates long wait times, reduces operational costs, and ensures consistent, accurate information delivery to citizens across the state.');

    // ===== PROBLEM STATEMENT =====
    addSectionTitle('2. PROBLEM STATEMENT');
    addParagraph('The current citizen service delivery mechanism faces several critical challenges:');
    addBullet('High call volumes at government helplines leading to long wait times (average 15-20 minutes)');
    addBullet('Limited operating hours (typically 9 AM to 5 PM) restricting citizen access');
    addBullet('Language barriers — many citizens are more comfortable in Hindi or Rajasthani dialects');
    addBullet('Inconsistent information delivery due to varying agent knowledge levels');
    addBullet('High operational costs for maintaining large call center teams');
    addBullet('Lack of data-driven insights into citizen needs and service gaps');
    addBullet('Manual grievance tracking leading to delayed resolution and poor follow-up');

    // ===== PROPOSED SOLUTION =====
    addSectionTitle('3. PROPOSED SOLUTION');
    addParagraph('VaaniAI provides an end-to-end AI voice agent platform with the following core capabilities:');
    
    y += 2;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('3.1 AI Voice Agent', margin, y);
    y += 6;
    addBullet('Real-time speech recognition and natural language understanding in Hindi, English, and Rajasthani');
    addBullet('Context-aware conversational AI with memory for multi-turn dialogues');
    addBullet('Dynamic knowledge base integration for up-to-date scheme information');
    addBullet('Seamless handoff to human agents for complex queries');

    addPageIfNeeded(40);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('3.2 Citizen Service Features', margin, y);
    y += 6;
    addBullet('Scheme Information: Detailed information about 100+ government schemes with eligibility checking');
    addBullet('Grievance Registration: Automated complaint filing with reference number generation');
    addBullet('Appointment Booking: Schedule visits to government offices');
    addBullet('Application Status Tracking: Real-time status updates on pending applications');
    addBullet('Document Guidance: Step-by-step guidance on required documents for services');

    addPageIfNeeded(30);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('3.3 Administrative Dashboard', margin, y);
    y += 6;
    addBullet('Real-time analytics on call volumes, resolution rates, and citizen satisfaction');
    addBullet('Automated reporting for departmental performance monitoring');
    addBullet('Knowledge base management for easy content updates');
    addBullet('Campaign management for proactive citizen outreach');

    // ===== TECHNOLOGY ARCHITECTURE =====
    addSectionTitle('4. TECHNOLOGY ARCHITECTURE');
    addParagraph('VaaniAI is built on a cloud-native, microservices architecture leveraging enterprise-grade Azure services:');
    addTable(
      ['Component', 'Technology', 'Purpose'],
      [
        ['Speech Recognition', 'Azure AI Speech', 'Real-time ASR in multiple languages'],
        ['NLP Engine', 'Azure OpenAI GPT-4', 'Intent recognition & response generation'],
        ['Text-to-Speech', 'Azure AI Speech', 'Natural voice synthesis in Hindi/English'],
        ['Telephony', 'Smartflo / SIP Trunk', 'Call routing and IVR integration'],
        ['Database', 'Cloud Database', 'Citizen data and interaction logs'],
        ['Analytics', 'Custom Dashboard', 'Real-time monitoring and reporting'],
        ['Security', 'Azure Security Center', 'End-to-end encryption & compliance'],
      ]
    );

    // ===== EXPECTED IMPACT =====
    addSectionTitle('5. EXPECTED IMPACT & MEASURABLE OUTCOMES');
    addParagraph('The deployment of VaaniAI is expected to deliver significant improvements across multiple dimensions:');
    addTable(
      ['Metric', 'Current State', 'Expected Outcome', 'Improvement'],
      [
        ['Call Handling Time', '15-20 mins avg', '1-2 mins avg', '90% Reduction'],
        ['Citizen Satisfaction', '~40%', '~95%', '70% Improvement'],
        ['Grievance Resolution', '~50% success', '~90% success', '80% Increase'],
        ['Citizen Engagement', 'Limited hours', '24/7 availability', '50% Rise'],
        ['Operational Cost', 'High (manual)', 'Automated', '30% Savings'],
        ['Language Coverage', 'Mostly English', 'Hindi/English/Rajasthani', '3x Coverage'],
      ]
    );

    // ===== SCALABILITY =====
    addSectionTitle('6. SCALABILITY & SUSTAINABILITY');
    addParagraph('VaaniAI is designed for phased deployment ensuring minimal risk and maximum adoption:');
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    addPageIfNeeded(10);
    doc.text('Phase 1 — Pilot (3 months):', margin + 3, y);
    y += 5;
    addBullet('Deploy in 1-2 departments (e.g., Jan Soochna Portal, CM Helpline)');
    addBullet('Handle up to 10,000 calls/day with 5 concurrent channels');

    addPageIfNeeded(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('Phase 2 — State-wide Rollout (6-12 months):', margin + 3, y);
    y += 5;
    addBullet('Expand to all major departments across Rajasthan');
    addBullet('Scale to 100,000+ calls/day with 50+ concurrent channels');

    addPageIfNeeded(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('Phase 3 — Multi-State / National (12-24 months):', margin + 3, y);
    y += 5;
    addBullet('Replicate the model across other Indian states');
    addBullet('Add regional languages (Tamil, Telugu, Bengali, etc.)');
    addBullet('Integration with national platforms (UMANG, DigiLocker)');

    // ===== SUPPORT REQUIRED =====
    addSectionTitle('7. SUPPORT REQUIRED FROM DEPARTMENT');
    addBullet('Data Access: Secure API access to citizen databases, scheme repositories, and grievance management systems for AI model training and real-time operations.');
    addBullet('Policy Support: Official adoption mandate, legal frameworks for AI-based citizen interactions, and data governance policies aligned with IT Act provisions.');
    addBullet('Infrastructure Support: Integration with existing IT systems (e-Mitra, SSOID, Jan Aadhaar), dedicated DID numbers, and network connectivity at government offices.');
    addBullet('Stakeholder Coordination: Designated nodal officers for each department to facilitate knowledge transfer and content validation.');
    addBullet('Feedback Mechanism: Citizen feedback channels to continuously improve AI accuracy and service quality.');

    // ===== BUDGET ESTIMATE =====
    addSectionTitle('8. INDICATIVE BUDGET ESTIMATE');
    addTable(
      ['Component', 'Pilot Phase', 'State-wide Phase', 'Remarks'],
      [
        ['Platform Setup', '₹5,00,000', '—', 'One-time setup'],
        ['AI Services (Monthly)', '₹2,50,000', '₹15,00,000', 'Azure AI consumption'],
        ['Telephony (Monthly)', '₹1,50,000', '₹8,00,000', 'DID & call charges'],
        ['Maintenance (Monthly)', '₹1,00,000', '₹5,00,000', 'Support & updates'],
        ['Training & Onboarding', '₹2,00,000', '₹5,00,000', 'Staff training'],
      ]
    );
    addParagraph('Note: Actual costs may vary based on call volumes, number of departments, and specific requirements. A detailed commercial proposal will be provided upon request.');

    // ===== IMPLEMENTATION TIMELINE =====
    addSectionTitle('9. IMPLEMENTATION TIMELINE');
    addTable(
      ['Phase', 'Duration', 'Key Activities'],
      [
        ['Discovery & Planning', 'Weeks 1-2', 'Requirements gathering, stakeholder meetings'],
        ['Development & Integration', 'Weeks 3-6', 'AI model training, system integration'],
        ['Testing & UAT', 'Weeks 7-8', 'User acceptance testing, performance tuning'],
        ['Pilot Launch', 'Weeks 9-10', 'Go-live in pilot department(s)'],
        ['Optimization', 'Weeks 11-12', 'Performance monitoring, feedback incorporation'],
        ['State-wide Rollout', 'Month 4-12', 'Phased expansion across departments'],
      ]
    );

    // ===== CONCLUSION =====
    addSectionTitle('10. CONCLUSION');
    addParagraph('VaaniAI represents a transformative opportunity for the Government of Rajasthan to modernize citizen service delivery through AI-powered voice technology. By automating routine interactions, providing 24/7 multilingual support, and delivering data-driven insights, VaaniAI will significantly enhance transparency, efficiency, and citizen satisfaction.');
    addParagraph('We look forward to partnering with the Department of IT & Communications to bring this vision to life and set a benchmark for AI-driven e-Governance in India.');

    y += 10;
    addPageIfNeeded(20);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 51, 102);
    doc.text('Contact Information', margin, y);
    y += 6;
    addKeyValue('Organization', 'VaaniAI Technologies');
    addKeyValue('Email', 'contact@vaaniai.in');
    addKeyValue('Website', 'www.vaaniai.in');

    // Generate PDF
    const pdfBytes = doc.output('arraybuffer');

    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', 'attachment; filename=VaaniAI_Concept_Note_Rajasthan_eGovernance.pdf');
    return c.body(pdfBytes, 200);
  } catch (error: any) {
    console.error('[generateConceptNote] Error:', error);
    return c.json({ data: { success: false, error: error.message } });
  }
}
