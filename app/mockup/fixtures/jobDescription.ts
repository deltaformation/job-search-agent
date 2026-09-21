export interface JobFixture {
  id: string;
  title: string;
  company: string;
  location: string;
  arrangement: "Remote" | "Hybrid" | "Onsite";
  residenceRequirement: string;
  employmentType: string;
  department: string;
  postedAt: string;
  salaryMinCAD: number;
  salaryMaxCAD: number;
  salaryText: string;
  payPeriodNote: string;
  compensationHighlights: string[];
  compensationOriginalText: string;
  applyUrl: string;
  sourceCanonicalKey: string;
  descriptionText: string;
  sections: {
    overview: string;
    whatYoullDo: string[];
    aboutYou: string[];
    compensationNote: string;
  };
}

export const LIME_JOB_FIXTURE: JobFixture = {
  id: "3f79665a-5b00-4124-b64f-4edc0233c227",
  title: "Lead Product Manager, Supply Chain Systems",
  company: "Lime",
  location: "Canada",
  arrangement: "Remote",
  residenceRequirement: "Must reside in Canada to maintain effective collaboration across teams",
  employmentType: "Full time",
  department: "Corporate Technology",
  postedAt: "2026-09-11",
  salaryMinCAD: 126000,
  salaryMaxCAD: 174000,
  salaryText: "CA$126,000–CA$174,000",
  payPeriodNote: "Annual base salary (pay period not explicitly stated in supplied text)",
  compensationHighlights: ["Discretionary annual bonus", "Equity opportunity"],
  compensationOriginalText:
    "The base salary range listed reflects what Lime reasonably expects to offer for this role, with the final base salary determined by objective factors such as the candidate’s location and relevant skills and experience. Depending on the position, the total compensation package may also include discretionary annual performance bonus opportunities and equity, subject to applicable plan terms and eligibility requirements.",
  applyUrl: "https://jobs.ashbyhq.com/lime/ab357293-3421-4183-94d5-2b60ef711edf",
  sourceCanonicalKey: "url:https://jobs.ashbyhq.com/lime/ab357293-3421-4183-94d5-2b60ef711edf",
  descriptionText: `As the largest global shared micromobility business, Lime is on a mission to build a future where transportation is shared, affordable and carbon-free. A Time Magazine 100 Most Influential Company, Lime has powered more than one billion rides in close to 30 countries across five continents, spurring a new generation of clean alternatives to car ownership. Learn more at li.me.

We are seeking an experienced Product Manager to drive the strategy and roadmap of our supply chain systems. This role requires deep expertise in supply chain systems and logistics business processes, as well as a strong ability to drive the product lifecycle from ideation to delivery. The successful candidate will work closely with cross-functional teams to ensure our supply chain systems meet internal and external customer needs, add value to the business, and advance overall technology capabilities.

This is a remote position with a requirement for candidates to reside in Canada to maintain effective collaboration across teams.

What You'll Do:
• Define product strategy by understanding supply chain market trends, logistics needs, and emerging technologies.
• Lead the creation and execution of the supply chain product roadmap, ensuring alignment with overall business and operational objectives.
• Collaborate with procurement, inventory management, logistics, and operations teams to gather business requirements and translate them into clear, actionable product specifications.
• Understand and map complex supply chain, order management, and distribution business processes.
• Serve as the voice of the customer and business operations, ensuring that supply chain product solutions deliver tangible value and resolve operational pain points.
• Prioritize and advocate for enhancements and improvements that drive satisfaction, user adoption, and operational efficiencies.
• Work closely with engineering to create release plans, define MVP, and drive delivery of supply chain initiatives and features.
• Ensure that the supply chain product suite is scalable, secure, and adaptable to changing global trade regulations, compliance requirements, and business needs.
• Stay up-to-date with emerging supply chain technologies (e.g., real-time tracking, automated warehousing, advanced analytics), identifying opportunities to introduce new capabilities and improve the overall technology stack.
• Define and track key product performance metrics (KPIs) to assess the success and value delivered by supply chain systems. Use data to inform product decisions and continuously improve process efficiency.
• Build and nurture relationships with internal operational teams, external logistics partners, and vendors. Effectively communicate product vision and progress to senior leadership and key stakeholders.

About You:
• Bachelor’s degree in Supply Chain Management, Logistics, Business, Computer Science, or a related field.
• 7+ years of experience as a product manager, with demonstrated expertise in NetSuite ERP, NetSuite Inventory Management, and NetSuite WMS including integrations and data pipelines.
• Experience with demand planning systems, such as Anaplan, and transportation management systems, such as Oracle TMS, is a plus.
• Proven track record of delivering customer-centric and operationally focused products and solutions that add measurable business value. Strong ability to understand user needs and translate them into impactful product features.
• Excellent verbal and written communication skills with the ability to effectively present and explain product concepts to both technical engineering teams and non-technical operational stakeholders.
• Ability to build strong business relationships, influence key stakeholders across functions, and lead cross-functional teams towards shared goals.
• Demonstrated experience leading cross-functional product development in an Agile/Scrum environment, establishing and embedding effective Scrum practices across engineering and business teams, and guiding iterative planning, prioritization, and delivery.

The base salary range listed reflects what Lime reasonably expects to offer for this role, with the final base salary determined by objective factors such as the candidate’s location and relevant skills and experience. Depending on the position, the total compensation package may also include discretionary annual performance bonus opportunities and equity, subject to applicable plan terms and eligibility requirements.

Lime is proud to be an Equal Opportunity Employer. We believe different perspectives help us grow and achieve more. That’s why we’re dedicated to building and developing a team that reflects a wider range of backgrounds, abilities, identities, and experiences.`,
  sections: {
    overview:
      "As the largest global shared micromobility business, Lime is on a mission to build a future where transportation is shared, affordable and carbon-free. A Time Magazine 100 Most Influential Company, Lime has powered more than one billion rides in close to 30 countries across five continents, spurring a new generation of clean alternatives to car ownership.",
    whatYoullDo: [
      "Define product strategy by understanding supply chain market trends, logistics needs, and emerging technologies.",
      "Lead the creation and execution of the supply chain product roadmap, ensuring alignment with overall business and operational objectives.",
      "Collaborate with procurement, inventory management, logistics, and operations teams to gather business requirements and translate them into clear, actionable product specifications.",
      "Understand and map complex supply chain, order management, and distribution business processes.",
      "Serve as the voice of the customer and business operations, ensuring that supply chain product solutions deliver tangible value and resolve operational pain points.",
      "Prioritize and advocate for enhancements and improvements that drive satisfaction, user adoption, and operational efficiencies.",
      "Work closely with engineering to create release plans, define MVP, and drive delivery of supply chain initiatives and features.",
      "Ensure that the supply chain product suite is scalable, secure, and adaptable to changing global trade regulations, compliance requirements, and business needs.",
      "Stay up-to-date with emerging supply chain technologies (e.g., real-time tracking, automated warehousing, advanced analytics), identifying opportunities to introduce new capabilities and improve the overall technology stack.",
      "Define and track key product performance metrics (KPIs) to assess the success and value delivered by supply chain systems. Use data to inform product decisions and continuously improve process efficiency.",
      "Build and nurture relationships with internal operational teams, external logistics partners, and vendors. Effectively communicate product vision and progress to senior leadership and key stakeholders.",
    ],
    aboutYou: [
      "Bachelor’s degree in Supply Chain Management, Logistics, Business, Computer Science, or a related field.",
      "7+ years of experience as a product manager, with demonstrated expertise in NetSuite ERP, NetSuite Inventory Management, and NetSuite WMS including integrations and data pipelines.",
      "Experience with demand planning systems, such as Anaplan, and transportation management systems, such as Oracle TMS, is a plus.",
      "Proven track record of delivering customer-centric and operationally focused products and solutions that add measurable business value. Strong ability to understand user needs and translate them into impactful product features.",
      "Excellent verbal and written communication skills with the ability to effectively present and explain product concepts to both technical engineering teams and non-technical operational stakeholders.",
      "Ability to build strong business relationships, influence key stakeholders across functions, and lead cross-functional teams towards shared goals.",
      "Demonstrated experience leading cross-functional product development in an Agile/Scrum environment, establishing and embedding effective Scrum practices across engineering and business teams, and guiding iterative planning, prioritization, and delivery.",
    ],
    compensationNote:
      "Base salary CA$126,000–CA$174,000; discretionary annual bonus & equity. Candidate must reside in Canada.",
  },
};
