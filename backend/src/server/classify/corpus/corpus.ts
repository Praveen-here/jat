import { parseAddress } from '../../email/normalize';
import type { NormalizedEmail } from '../../email/types';
import type { Category } from '../categories';
import type { EmploymentType } from '../extract';

/**
 * Synthetic labelled email corpus (docs/plan §14.4). All companies, people and IDs are made up.
 * Built from templates modelled on how real recruiting emails are phrased, with random variation,
 * so accuracy can be MEASURED without collecting anyone's real email.
 *
 * Honest limitation: the templates and the rules were written by the same author, so scores on this
 * corpus are optimistic. Real-world accuracy must be checked on real mail (the user's own review).
 */
export interface Expected {
  category: Category;
  company?: string | null;
  role?: string | null;
  employmentType?: EmploymentType;
  reqId?: string;
  applicationRef?: string;
  eventAt?: Date;
  deadlineAt?: Date;
}

export interface LabeledEmail {
  template: string;
  email: NormalizedEmail;
  expected: Expected;
}

// ---- deterministic randomness --------------------------------------------------------------------

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    // mulberry32
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---- fictional data ------------------------------------------------------------------------------

const COMPANIES = [
  { name: 'Nimbus Labs', domain: 'nimbuslabs.io', slug: 'nimbuslabs' },
  { name: 'Orbitra Technologies', domain: 'orbitra.in', slug: 'orbitra' },
  { name: 'Kestrel Systems', domain: 'kestrelsystems.com', slug: 'kestrel-systems' },
  { name: 'Bluepeak Software', domain: 'bluepeak.co', slug: 'bluepeak' },
  { name: 'Tatva Fintech', domain: 'tatvafintech.com', slug: 'tatva-fintech' },
  { name: 'Zenvault', domain: 'zenvault.io', slug: 'zenvault' },
  { name: 'Lumina Health', domain: 'luminahealth.in', slug: 'lumina-health' },
  { name: 'Quarkbyte', domain: 'quarkbyte.ai', slug: 'quarkbyte' },
  { name: 'Saffron Retail', domain: 'saffronretail.com', slug: 'saffron-retail' },
  { name: 'Vertex Mobility', domain: 'vertexmobility.com', slug: 'vertexmobility' },
  { name: 'Meridian Bank', domain: 'meridianbank.co.in', slug: 'meridian-bank' },
  { name: 'Cobalt AI', domain: 'cobalt.ai', slug: 'cobalt-ai' },
  { name: 'Indigo Logistics', domain: 'indigologistics.com', slug: 'indigo-logistics' },
  { name: 'Pixelwave Studios', domain: 'pixelwave.studio', slug: 'pixelwave' },
  { name: 'Arcturus Energy', domain: 'arcturusenergy.com', slug: 'arcturus-energy' },
  { name: 'Granite Analytics', domain: 'graniteanalytics.io', slug: 'granite-analytics' },
] as const;

const LEGAL_FORMS = ['', '', '', ' Pvt. Ltd.', ' Private Limited', ' Inc.'];

const ROLES: Array<{ title: string; type: EmploymentType }> = [
  { title: 'Software Development Engineer Intern', type: 'internship' },
  { title: 'SDE Intern', type: 'internship' },
  { title: 'Data Analyst', type: 'unknown' },
  { title: 'Backend Engineer', type: 'unknown' },
  { title: 'Frontend Developer Intern', type: 'internship' },
  { title: 'Machine Learning Engineer', type: 'unknown' },
  { title: 'Product Design Intern', type: 'internship' },
  { title: 'Business Analyst', type: 'unknown' },
  { title: 'Associate Software Engineer', type: 'unknown' },
  { title: 'DevOps Engineer', type: 'unknown' },
  { title: 'Graduate Engineer Trainee', type: 'unknown' },
  { title: 'Marketing Intern', type: 'internship' },
  { title: 'Full Stack Developer', type: 'unknown' },
  { title: 'Data Science Intern', type: 'internship' },
];

const FIRST_NAMES = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Karthik', 'Meera', 'Vikram', 'Sneha', 'Arjun', 'Priya', 'Rahul', 'Ishita'];
const RECRUITERS = ['Neha Sharma', 'Rajesh Kumar', 'Pooja Iyer', 'Amit Verma', 'Sana Khan', 'Deepak Rao'];
const CITIES = ['Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Gurugram', 'Remote'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const IST_MS = 330 * 60_000;

interface Ctx {
  r: Rng;
  company: (typeof COMPANIES)[number];
  companyName: string;
  role: (typeof ROLES)[number];
  name: string;
  date: Date;
  n: number;
}

/** An IST wall-clock time on day `daysAhead` after the email, as a UTC Date. */
function istTime(base: Date, daysAhead: number, hour: number, minute: number): Date {
  const ist = new Date(base.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + daysAhead, hour, minute) - IST_MS);
}

function formatIst(date: Date, style: number): string {
  const ist = new Date(date.getTime() + IST_MS);
  const d = ist.getUTCDate();
  const month = MONTHS[ist.getUTCMonth()]!;
  const weekday = WEEKDAYS[ist.getUTCDay()]!;
  const h24 = ist.getUTCHours();
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const h12 = `${((h24 + 11) % 12) + 1}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
  const year = ist.getUTCFullYear();
  switch (style % 3) {
    case 0:
      return `on ${weekday}, ${d} ${month} ${year} at ${h12} IST`;
    case 1:
      return `on ${month} ${d}, ${year} at ${h12} (IST)`;
    default:
      return `on ${d} ${month.slice(0, 3)} ${year}, ${String(h24).padStart(2, '0')}:${mm} IST`;
  }
}

function email(
  ctx: Ctx,
  options: {
    from: string;
    subject: string;
    text: string;
    links?: string[];
    bulk?: boolean;
    calendar?: NormalizedEmail['calendar'];
    attachments?: string[];
  },
): NormalizedEmail {
  return {
    id: `corpus-${ctx.n}`,
    threadId: `thread-${ctx.n}`,
    internalDate: ctx.date,
    labelIds: ['INBOX'],
    detail: 'full',
    from: parseAddress(options.from),
    replyTo: null,
    subject: options.subject,
    snippet: options.text.slice(0, 140),
    messageIdHeader: `<corpus-${ctx.n}@mail.example>`,
    bulk: options.bulk ?? false,
    text: options.text,
    links: (options.links ?? []).map((href) => ({ href, text: '' })),
    calendar: options.calendar ?? null,
    attachmentNames: options.attachments ?? [],
    isForward: false,
  };
}

const greet = (c: Ctx) => c.r.pick([`Hi ${c.name},`, `Dear ${c.name},`, `Hello ${c.name},`, 'Dear Candidate,']);
const signoff = (c: Ctx, team = `${c.companyName} Recruiting`) => c.r.pick([`Best regards,\n${team}`, `Thanks,\n${team}`, `Warm regards,\nTalent Acquisition Team\n${c.companyName}`, `Cheers,\nThe ${c.companyName} Hiring Team`]);
const reqId = (c: Ctx) => `R-${c.r.int(10000, 99999)}`;

type Template = { name: string; build: (c: Ctx) => LabeledEmail };
const T = (name: string, build: (c: Ctx) => Omit<LabeledEmail, 'template'>): Template => ({ name, build: (c) => ({ template: name, ...build(c) }) });

// ---- templates -----------------------------------------------------------------------------------

const TEMPLATES: Template[] = [
  // Application received
  T('greenhouse.received', (c) => ({
    email: email(c, {
      from: `${c.companyName} Recruiting <no-reply@us.greenhouse-mail.io>`,
      subject: c.r.pick([`Thank you for applying to ${c.companyName}`, `Thanks for your application to ${c.companyName}`]),
      text: `${greet(c)}\n\nThank you for your interest in ${c.companyName}! We wanted to let you know we received your application for ${c.role.title}, and we are delighted that you would consider joining our team.\n\nOur team will review your application and will be in touch if your qualifications match our needs for the role.\n\n${signoff(c)}`,
      links: [`https://boards.greenhouse.io/${c.company.slug}/jobs/${4000000 + c.n}`],
    }),
    expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title },
  })),
  T('lever.received', (c) => ({
    email: email(c, {
      from: `${c.companyName} <no-reply@hire.lever.co>`,
      subject: `Thanks for applying to ${c.companyName}`,
      text: `${greet(c)}\n\nThanks for applying to the ${c.role.title} position at ${c.companyName}. We've received your application and our team will be reviewing it shortly. If your background is a good fit, we'll reach out about next steps.\n\n${signoff(c)}`,
      links: [`https://jobs.lever.co/${c.company.slug}/0b6f4c9e-1d2a-4f5b-9c8d-${String(c.n).padStart(12, '0')}`],
    }),
    expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title },
  })),
  T('workday.received', (c) => {
    const rid = reqId(c);
    return {
      email: email(c, {
        from: `${c.companyName} Careers <${c.company.slug}@myworkday.com>`,
        subject: `Application Received - ${c.role.title} (${rid})`,
        text: `${greet(c)}\n\nThank you for applying for the ${c.role.title} position. We have received your application and will review your qualifications.\n\nJob requisition ID: ${rid}\n\nYou can track the status of your application on our careers site.\n\n${signoff(c)}`,
        links: [`https://${c.company.slug}.wd3.myworkdayjobs.com/en-US/careers/job/${c.r.pick(CITIES)}/${c.role.title.replace(/ /g, '-')}_${rid}`],
      }),
      expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title, reqId: rid },
    };
  }),
  T('linkedin.sent', (c) => ({
    email: email(c, {
      from: 'LinkedIn <jobs-noreply@linkedin.com>',
      subject: `${c.name}, your application was sent to ${c.companyName}`,
      text: `Your application was sent to ${c.companyName}\n${c.role.title}\n${c.companyName} · ${c.r.pick(CITIES)} (On-site)\nApplied on ${MONTHS[c.date.getUTCMonth()]} ${c.date.getUTCDate()}\n\nView job\n\nYou're receiving job application emails.\nUnsubscribe`,
      links: [`https://www.linkedin.com/comm/jobs/view/${3900000000 + c.n}/?trackingId=abc`],
      bulk: true,
    }),
    expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title },
  })),
  T('naukri.applied', (c) => ({
    email: email(c, {
      from: 'Naukri <naukri@naukri.com>',
      subject: `Your application for ${c.role.title} has been submitted`,
      text: `${greet(c)}\n\nYou have successfully applied to ${c.role.title} at ${c.companyName}. The recruiter will contact you if your profile is shortlisted.\n\nApplied on: ${c.date.toDateString()}\n\nTeam Naukri`,
      bulk: true,
    }),
    expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title },
  })),
  T('internshala.applied', (c) => ({
    email: email(c, {
      from: 'Internshala <student@internshala.com>',
      subject: `Application submitted: ${c.role.title} at ${c.companyName}`,
      text: `${greet(c)}\n\nYour application for the ${c.role.title} internship at ${c.companyName} has been successfully submitted. The employer will review your application and get back to you if you are shortlisted.\n\nAll the best!\nTeam Internshala`,
    }),
    expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title, employmentType: 'internship' },
  })),
  T('direct.received', (c) => {
    const ref = `APP-${c.r.int(100000, 999999)}`;
    return {
      email: email(c, {
        from: `${c.companyName} Careers <careers@${c.company.domain}>`,
        subject: `Application acknowledgement – ${c.role.title}`,
        text: `${greet(c)}\n\nWe have received your application for the position of ${c.role.title}. Your application reference number: ${ref}.\n\nOur recruitment team will review your profile and contact you if it matches our requirements.\n\n${signoff(c)}`,
      }),
      expected: { category: 'APPLICATION_RECEIVED', company: c.company.name, role: c.role.title, applicationRef: ref },
    };
  }),

  // Assessments
  T('hackerrank.invite', (c) => {
    const deadline = istTime(c.date, c.r.int(2, 5), 23, 59);
    return {
      email: email(c, {
        from: 'HackerRank <support@hackerrankforwork.com>',
        subject: `${c.companyName} has invited you to take a test`,
        text: `${greet(c)}\n\n${c.companyName} has invited you to take a coding test for the ${c.role.title} position. Test duration: 90 minutes.\n\nPlease complete the test by ${formatIst(deadline, c.n).replace(/^on /, '')}.\n\nStart test\n\nGood luck!\nHackerRank`,
        links: ['https://www.hackerrank.com/tests/abc123/login'],
      }),
      expected: { category: 'ASSESSMENT_INVITE', company: c.company.name, role: c.role.title, deadlineAt: deadline },
    };
  }),
  T('hackerearth.invite', (c) => ({
    email: email(c, {
      from: 'HackerEarth <noreply@hackerearth.com>',
      subject: `Invitation: ${c.companyName} Online Assessment`,
      text: `${greet(c)}\n\n${c.companyName} invites you to participate in the online assessment for ${c.role.title}. You have been invited to take this assessment as part of the hiring process.\n\nThe assessment link will be active for 72 hours.\n\nRegards,\nHackerEarth`,
    }),
    expected: { category: 'ASSESSMENT_INVITE', company: c.company.name, role: c.role.title },
  })),
  T('mettl.invite', (c) => ({
    email: email(c, {
      from: 'Mercer Mettl <noreply@mettl.com>',
      subject: `Assessment invitation from ${c.companyName}`,
      text: `${greet(c)}\n\nYou have been invited to take an online test by ${c.companyName} for the role of ${c.role.title}. Please use the test link below to begin. Ensure a stable internet connection.\n\nMercer | Mettl`,
    }),
    expected: { category: 'ASSESSMENT_INVITE', company: c.company.name, role: c.role.title },
  })),
  T('direct.assessment', (c) => ({
    email: email(c, {
      from: `${c.r.pick(RECRUITERS)} <talent@${c.company.domain}>`,
      subject: `Online Assessment – Next steps for ${c.role.title}`,
      text: `${greet(c)}\n\nThank you for applying to ${c.companyName}. As the next step in our hiring process, we would like to invite you to complete an online coding assessment. Please complete it within 3 days of receiving this email.\n\n${signoff(c)}`,
    }),
    expected: { category: 'ASSESSMENT_INVITE', company: c.company.name, role: c.role.title },
  })),
  T('hackerrank.reminder', (c) => ({
    email: email(c, {
      from: 'HackerRank <support@hackerrankforwork.com>',
      subject: `Reminder: Your ${c.companyName} test is pending`,
      text: `${greet(c)}\n\nThis is a gentle reminder that you have not yet started the test from ${c.companyName}. The test link expires soon, so please attempt it at the earliest.\n\nHackerRank`,
    }),
    expected: { category: 'ASSESSMENT_REMINDER', company: c.company.name },
  })),
  T('assessment.completed', (c) => ({
    email: email(c, {
      from: `${c.companyName} Hiring <hiring@${c.company.domain}>`,
      subject: 'Thank you for completing the assessment',
      text: `${greet(c)}\n\nThank you for completing the ${c.companyName} online assessment for the ${c.role.title} role. Our team will review your results and get back to you with next steps.\n\n${signoff(c)}`,
    }),
    expected: { category: 'ASSESSMENT_COMPLETED', company: c.company.name, role: c.role.title },
  })),

  // Interviews
  T('calendar.interview', (c) => {
    const start = istTime(c.date, c.r.int(2, 9), c.r.pick([10, 11, 15, 16]), c.r.pick([0, 30]));
    return {
      email: email(c, {
        from: `${c.r.pick(RECRUITERS)} <recruiting@${c.company.domain}>`,
        subject: `Invitation: ${c.companyName} Technical Interview - ${c.name}`,
        text: `You have been invited to the following event.\n\nTechnical Interview - ${c.role.title}\nJoining info: Join with Google Meet\n\nInvitation from Google Calendar`,
        calendar: { start, end: new Date(start.getTime() + 3600_000), summary: `Technical Interview - ${c.role.title}`, organizerDomain: c.company.domain, location: 'Google Meet' },
      }),
      expected: { category: 'INTERVIEW_INVITE', company: c.company.name, eventAt: start },
    };
  }),
  T('direct.interview', (c) => {
    const start = istTime(c.date, c.r.int(2, 9), c.r.pick([10, 11, 15, 16]), c.r.pick([0, 30]));
    return {
      email: email(c, {
        from: `${c.r.pick(RECRUITERS)} <hr@${c.company.domain}>`,
        subject: `Interview Invitation – ${c.role.title} at ${c.companyName}`,
        text: `${greet(c)}\n\nWe are pleased to invite you for a technical interview for the position of ${c.role.title}. The interview is scheduled ${formatIst(start, c.n)} and will be conducted over Google Meet.\n\nPlease confirm your availability by replying to this email.\n\n${signoff(c)}`,
      }),
      expected: { category: 'INTERVIEW_INVITE', company: c.company.name, role: c.role.title, eventAt: start },
    };
  }),
  T('direct.interview-datetime-lines', (c) => {
    const start = istTime(c.date, c.r.int(2, 9), c.r.pick([10, 11, 15, 16]), c.r.pick([0, 30]));
    const ist = new Date(start.getTime() + IST_MS);
    const h24 = ist.getUTCHours();
    return {
      email: email(c, {
        from: `HR Team <hr@${c.company.domain}>`,
        subject: `Interview Schedule - ${c.role.title}`,
        text: `${greet(c)}\n\nWe would like to invite you to an interview for the ${c.role.title} role at ${c.companyName}.\n\nDate: ${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}\nTime: ${((h24 + 11) % 12) + 1}:${String(ist.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'} IST\nMode: Video call\n\n${signoff(c)}`,
      }),
      expected: { category: 'INTERVIEW_INVITE', company: c.company.name, role: c.role.title, eventAt: start },
    };
  }),
  T('greenhouse.schedule', (c) => ({
    email: email(c, {
      from: `${c.companyName} Recruiting <no-reply@us.greenhouse-mail.io>`,
      subject: `Interview availability for ${c.role.title}`,
      text: `${greet(c)}\n\nThanks again for your interest in ${c.companyName}. We'd love to schedule an interview with you for the ${c.role.title} role. Please pick a time for your interview using the link below.\n\n${signoff(c)}`,
      links: [`https://app.greenhouse.io/scheduling/${c.n}`, `https://boards.greenhouse.io/${c.company.slug}/jobs/${5000000 + c.n}`],
    }),
    expected: { category: 'INTERVIEW_INVITE', company: c.company.name, role: c.role.title },
  })),
  T('trap.offer-chance-to-interview', (c) => ({
    email: email(c, {
      from: `${c.r.pick(RECRUITERS)} <talent@${c.company.domain}>`,
      subject: `Next steps with ${c.companyName}`,
      text: `${greet(c)}\n\nThank you for applying to ${c.companyName}. We'd like to offer you a chance to interview with our engineering team for the ${c.role.title} role. Please share a few time slots that work for you this week.\n\n${signoff(c)}`,
    }),
    expected: { category: 'INTERVIEW_INVITE', company: c.company.name, role: c.role.title },
  })),
  T('interview.rescheduled', (c) => {
    const start = istTime(c.date, c.r.int(2, 6), c.r.pick([11, 14, 17]), 0);
    return {
      email: email(c, {
        from: `${c.r.pick(RECRUITERS)} <recruiting@${c.company.domain}>`,
        subject: `Updated invitation: Interview rescheduled – ${c.role.title}`,
        text: `${greet(c)}\n\nYour interview for the ${c.role.title} position at ${c.companyName} has been rescheduled. The new time is ${formatIst(start, c.n + 1).replace(/^on /, '')}. Apologies for any inconvenience.\n\n${signoff(c)}`,
      }),
      expected: { category: 'INTERVIEW_RESCHEDULED', company: c.company.name, role: c.role.title, eventAt: start },
    };
  }),
  T('interview.cancelled', (c) => ({
    email: email(c, {
      from: `${c.r.pick(RECRUITERS)} <recruiting@${c.company.domain}>`,
      subject: 'Interview cancelled',
      text: `${greet(c)}\n\nWe're writing to let you know that your interview with ${c.companyName} scheduled for this week has been cancelled due to a change in the panel's availability. We will reach out shortly to find a new time.\n\n${signoff(c)}`,
    }),
    expected: { category: 'INTERVIEW_CANCELLED', company: c.company.name },
  })),

  // Progress and outcomes
  T('internshala.shortlisted', (c) => ({
    email: email(c, {
      from: 'Internshala <student@internshala.com>',
      subject: `Congratulations! You have been shortlisted by ${c.companyName}`,
      text: `${greet(c)}\n\nCongratulations! You have been shortlisted for the ${c.role.title} internship at ${c.companyName}. The employer will contact you soon with the next steps.\n\nTeam Internshala`,
    }),
    expected: { category: 'SHORTLISTED', company: c.company.name, employmentType: 'internship' },
  })),
  T('direct.next-round', (c) => ({
    email: email(c, {
      from: `${c.companyName} Talent Team <talent@${c.company.domain}>`,
      subject: `Update on your application – ${c.role.title}`,
      text: `${greet(c)}\n\nGood news! You have cleared the online assessment round and we are moving you forward to the next round of our hiring process for the ${c.role.title} role. Our team will share details soon.\n\n${signoff(c)}`,
    }),
    expected: { category: 'SHORTLISTED', company: c.company.name, role: c.role.title },
  })),
  T('direct.offer', (c) => ({
    email: email(c, {
      from: `${c.r.pick(RECRUITERS)} <hr@${c.company.domain}>`,
      subject: `Offer Letter – ${c.role.title} at ${c.companyName}`,
      text: `${greet(c)}\n\nWe are delighted to extend an offer for the position of ${c.role.title} at ${c.companyName}. Please find your offer letter attached, which includes details of your compensation and joining date.\n\nKindly sign and return the letter within 5 working days.\n\n${signoff(c)}`,
      attachments: [`Offer_Letter_${c.name}.pdf`],
    }),
    expected: { category: 'OFFER', company: c.company.name, role: c.role.title },
  })),
  T('greenhouse.rejection', (c) => ({
    email: email(c, {
      from: `${c.companyName} Recruiting <no-reply@us.greenhouse-mail.io>`,
      subject: `Update on your application to ${c.companyName}`,
      text: `${greet(c)}\n\nThank you for your interest in ${c.companyName} and for applying to the ${c.role.title} role. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our current needs.\n\nWe appreciate the time you invested and wish you the best in your search.\n\n${signoff(c)}`,
      links: [`https://boards.greenhouse.io/${c.company.slug}/jobs/${4000000 + c.n}`],
    }),
    expected: { category: 'REJECTION', company: c.company.name, role: c.role.title },
  })),
  T('workday.rejection', (c) => {
    const rid = reqId(c);
    return {
      email: email(c, {
        from: `${c.companyName} Careers <${c.company.slug}@myworkday.com>`,
        subject: `Regarding your application for ${c.role.title} (${rid})`,
        text: `${greet(c)}\n\nThank you for applying for the ${c.role.title} position. After careful review, we regret to inform you that you have not been selected to move forward in the process.\n\n${signoff(c)}`,
      }),
      expected: { category: 'REJECTION', company: c.company.name, role: c.role.title, reqId: rid },
    };
  }),
  T('lever.rejection', (c) => ({
    email: email(c, {
      from: `${c.companyName} <no-reply@hire.lever.co>`,
      subject: `Your application to ${c.companyName}`,
      text: `${greet(c)}\n\nThank you for taking the time to apply for the ${c.role.title} position at ${c.companyName}. After reviewing your application, we will not be moving forward with your candidacy at this time.\n\n${signoff(c)}`,
    }),
    expected: { category: 'REJECTION', company: c.company.name, role: c.role.title },
  })),
  T('direct.rejection-after-interview', (c) => ({
    email: email(c, {
      from: `${c.r.pick(RECRUITERS)} <careers@${c.company.domain}>`,
      subject: `Application status – ${c.role.title}`,
      text: `${greet(c)}\n\nThank you for interviewing with us for the ${c.role.title} role. After careful consideration, we are sorry to inform you that we will be proceeding with other candidates. We truly enjoyed speaking with you.\n\n${signoff(c)}`,
    }),
    expected: { category: 'REJECTION', company: c.company.name, role: c.role.title },
  })),
  T('direct.info-request', (c) => ({
    email: email(c, {
      from: `HR Operations <hr@${c.company.domain}>`,
      subject: 'Action required: Submit your documents',
      text: `${greet(c)}\n\nAs part of the onboarding process for the ${c.role.title} role at ${c.companyName}, kindly submit the following documents: PAN card, final semester marksheets and a government ID proof.\n\n${signoff(c, 'HR Operations')}`,
    }),
    expected: { category: 'INFO_REQUEST', company: c.company.name, role: c.role.title },
  })),
  T('withdrawal', (c) => ({
    email: email(c, {
      from: `${c.companyName} Careers <careers@${c.company.domain}>`,
      subject: 'Application withdrawn',
      text: `${greet(c)}\n\nYou have successfully withdrawn your application for ${c.role.title} at ${c.companyName}. If this was a mistake, you can apply again from our careers page.\n\n${signoff(c)}`,
    }),
    expected: { category: 'WITHDRAWAL_CONFIRMATION', company: c.company.name, role: c.role.title },
  })),

  // Recruiter outreach (not an application)
  T('outreach.personal', (c) => {
    const recruiter = c.r.pick(RECRUITERS);
    return {
      email: email(c, {
        from: `${recruiter} <${recruiter.toLowerCase().replace(' ', '.')}@gmail.com>`,
        subject: `Exciting opportunity: ${c.role.title}`,
        text: `Hi ${c.name},\n\nI came across your profile on LinkedIn and wanted to reach out about a ${c.role.title} opening with my client, a leading fintech company in ${c.r.pick(CITIES)}. Would you be interested in a quick call this week?\n\nRegards,\n${recruiter}`,
      }),
      expected: { category: 'RECRUITER_OUTREACH', company: null },
    };
  }),

  // Job alerts and newsletters (must never become applications)
  T('linkedin.alert', (c) => {
    const others = Array.from({ length: 5 }, (_, i) => COMPANIES[(c.n + i) % COMPANIES.length]!.name);
    return {
      email: email(c, {
        from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
        subject: `${c.role.title} at ${c.companyName} and 9 more jobs in ${c.r.pick(CITIES)} for you`,
        text: `Your job alert for ${c.role.title}\n\n${others.map((o) => `${c.role.title}\n${o}\nApply now`).join('\n\n')}\n\nSee all jobs\n\nUnsubscribe`,
        links: others.map((_, i) => `https://www.linkedin.com/comm/jobs/view/${3800000000 + c.n * 10 + i}`),
        bulk: true,
      }),
      expected: { category: 'JOB_ALERT' },
    };
  }),
  T('naukri.recommended', (c) => ({
    email: email(c, {
      from: 'Naukri <jobalert@naukri.com>',
      subject: 'Recommended jobs for you',
      text: `Jobs matching your profile\n\n${COMPANIES.slice(0, 4).map((co) => `${c.role.title} | ${co.name} | 0-2 Yrs\nApply`).join('\n')}\n\nView all jobs`,
      links: COMPANIES.slice(0, 4).map((_, i) => `https://www.naukri.com/job-listings-${c.n}-${i}`),
      bulk: true,
    }),
    expected: { category: 'JOB_ALERT' },
  })),
  T('indeed.alert', (c) => ({
    email: email(c, {
      from: 'Indeed <alert@indeed.com>',
      subject: `${c.r.int(5, 30)} new jobs for ${c.role.title}`,
      text: `New jobs matching your search for ${c.role.title} in ${c.r.pick(CITIES)}.\n\n${COMPANIES.slice(4, 8).map((co) => `${c.role.title} - ${co.name}\nEasily apply`).join('\n')}`,
      links: COMPANIES.slice(4, 8).map((_, i) => `https://in.indeed.com/viewjob?jk=${(c.n * 31 + i).toString(16).padStart(16, '0')}`),
      bulk: true,
    }),
    expected: { category: 'JOB_ALERT' },
  })),
  T('trap.alert-mentions-application', (c) => ({
    email: email(c, {
      from: `${c.r.pick(['Internshala <recommendations@internshala.com>', 'foundit <jobalert@foundit.in>', 'Cutshort <jobs@cutshort.io>'])}`,
      subject: 'Jobs you may be interested in, based on your recent application',
      text: `Based on your recent application, here are similar jobs you might like:\n\n${COMPANIES.slice(8, 12).map((co) => `${c.role.title} at ${co.name}\nApply now`).join('\n\n')}`,
      links: COMPANIES.slice(8, 12).map((co) => `https://example-jobs.com/jobs/${co.slug}-${c.n}`),
      bulk: true,
    }),
    expected: { category: 'JOB_ALERT' },
  })),
  T('newsletter.webinar', (c) => ({
    email: email(c, {
      from: 'Unstop <events@unstop.com>',
      subject: 'Webinar: How to crack your next coding interview',
      text: `Join our free webinar this ${WEEKDAYS[c.r.int(0, 6)]} with engineers from top companies. Learn how to prepare for coding interview rounds, build your resume and more.\n\nRegister now\n\nUnsubscribe`,
      bulk: true,
    }),
    expected: { category: 'NEWSLETTER_MARKETING' },
  })),
  T('newsletter.career-tips', (c) => ({
    email: email(c, {
      from: 'Glassdoor Community <community@glassdoor.com>',
      subject: c.r.pick(['5 resume tips that get you hired', 'Salary trends for freshers in 2026']),
      text: 'Career tips from our community: how to stand out, negotiate your offer, and ace interviews. Upgrade to premium for more insights.\n\nUnsubscribe',
      bulk: true,
    }),
    expected: { category: 'NEWSLETTER_MARKETING' },
  })),

  // Unrelated mail, including traps that mention job words
  T('unrelated.otp', (c) => ({
    email: email(c, {
      from: 'Meridian Bank Alerts <alerts@meridianbank.co.in>',
      subject: 'Your OTP for login',
      text: `Your one-time password is ${c.r.int(100000, 999999)}. It is valid for 5 minutes. Do not share it with anyone.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('unrelated.order', (c) => ({
    email: email(c, {
      from: 'Swiftcart <orders@swiftcart.in>',
      subject: `Your order #${c.r.int(10000, 99999)} has been delivered`,
      text: 'Your order has been delivered. Rate your experience and get 10% off your next order.',
      bulk: true,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.college-event', (c) => ({
    email: email(c, {
      from: 'Student Affairs <events@university.edu>',
      subject: 'Alumni Talk & Mock Interview Series this Friday',
      text: `Dear Students,\n\nThe placement cell invites you to the alumni talk and mock interview series this Friday in the main auditorium. Registration is free for all final-year students.\n\nRegards,\nStudent Affairs`,
      bulk: true,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.friend-job-chat', (c) => ({
    email: email(c, {
      from: `${c.r.pick(FIRST_NAMES)} <friend.${c.n}@gmail.com>`,
      subject: c.r.pick(['Dinner on Saturday?', 'Photos from the trip']),
      text: `Hey! How's the new job going? Let's catch up over dinner this weekend. Also sharing the photos from last month.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  // Traps seen in a real inbox (2026-10-11): security mail and hiring newsletters.
  T('trap.otp', (c) => ({
    email: email(c, {
      from: c.r.pick(['Naukri <info@naukri.com>', 'Internshala <noreply@internshala.com>', 'Unstop <noreply@unstop.com>']),
      subject: c.r.pick(['Your OTP for login', 'OTP to verify your mobile number', 'Your one-time password']),
      text: `${c.r.int(100000, 999999)} is your OTP to log in to your account. It is valid for 10 minutes. Do not share it with anyone. If you did not request this, please ignore this email. Apply to jobs faster with our app.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.password-reset', (c) => ({
    email: email(c, {
      from: c.r.pick(['LinkedIn <security-noreply@linkedin.com>', `${c.companyName} Careers <noreply@${c.company.domain}>`]),
      subject: c.r.pick(['Reset your password', 'Your password was changed', 'New sign-in to your account']),
      text: `Hi ${c.name}, we received a request to reset your password for your candidate account. Click the link below to choose a new password. If this wasn't you, secure your account. Track your job application status anytime.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.verify-account', (c) => ({
    email: email(c, {
      from: `${c.companyName} Careers <${c.company.slug}@myworkday.com>`,
      subject: 'Verify your email to activate your candidate account',
      text: `Hi ${c.name}, thank you for creating a candidate account with ${c.companyName}. Please verify your email address to activate your account before you can submit an application for the ${c.role.title} role.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.test-login-code', (c) => ({
    email: email(c, {
      from: 'HackerRank <support@hackerrankforwork.com>',
      subject: 'Your verification code for the test',
      text: `Your verification code to access the ${c.companyName} online test is ${c.r.int(100000, 999999)}. Enter this code on the test login page. The test link is valid for 24 hours.`,
    }),
    expected: { category: 'UNRELATED' },
  })),
  T('trap.hiring-newsletter', (c) => ({
    email: email(c, {
      from: c.r.pick(['Unstop <noreply@unstop.news>', 'Unstop Events <hello@unstop.events>', 'Campus Hiring Digest <news@hiringdigest.in>']),
      subject: c.r.pick([`${c.companyName} Hackathon: new dates announced!`, 'This week: coding rounds, interviews and offers you can win', 'Register now: hiring challenge with interview opportunities']),
      text: `Big news! The ${c.companyName} hiring hackathon has a new date. Clear the online coding round, get shortlisted for interview rounds, and top performers win internship offers and offer letters with prizes worth ₹5 lakh. Candidates who have been shortlisted last season got PPOs. Registrations close soon. Apply now!\n\nUnsubscribe`,
      bulk: true,
    }),
    expected: { category: 'NEWSLETTER_MARKETING' },
  })),
  T('onboarding.documents', (c) => ({
    email: email(c, {
      from: `${c.companyName} Campus Team <campus@${c.company.domain}>`,
      subject: 'Action required: Upload your documents for onboarding',
      text: `${greet(c)}\n\nAs part of your pre-joining formalities at ${c.companyName}, please upload the following documents on the onboarding portal: signed offer letter, PAN card, Aadhaar, and final semester marksheets. Your joining date will be confirmed once verification is complete.\n\n${signoff(c, `${c.companyName} Campus Team`)}`,
      bulk: c.r.chance(0.5),
    }),
    expected: { category: 'INFO_REQUEST', company: c.company.name },
  })),
  T('unrelated.github', (c) => ({
    email: email(c, {
      from: 'GitHub <notifications@github.com>',
      subject: `[repo] Pull request #${c.r.int(1, 400)} merged`,
      text: 'Your pull request was merged into main. View it on GitHub.',
      bulk: true,
    }),
    expected: { category: 'UNRELATED' },
  })),
];

/**
 * Builds the corpus. Same seed, same corpus. Use seed 1 for tuning ("dev") and a different seed
 * for checking ("holdout"): it varies the fill-ins but not the templates, so it guards against
 * over-fitting to specific names and dates, not against unseen phrasings.
 */
export function buildCorpus(seed = 1, perTemplate = 20): LabeledEmail[] {
  const r = new Rng(seed);
  const out: LabeledEmail[] = [];
  let n = 0;
  for (const template of TEMPLATES) {
    for (let i = 0; i < perTemplate; i++) {
      const company = r.pick(COMPANIES);
      const ctx: Ctx = {
        r,
        company,
        companyName: `${company.name}${r.pick(LEGAL_FORMS)}`,
        role: r.pick(ROLES),
        name: r.pick(FIRST_NAMES),
        date: new Date(Date.UTC(2026, 7, 1, r.int(3, 12), r.int(0, 59)) + r.int(0, 60) * 86400_000),
        n: n++,
      };
      out.push(template.build(ctx));
    }
  }
  return out;
}

export const TEMPLATE_COUNT = TEMPLATES.length;
