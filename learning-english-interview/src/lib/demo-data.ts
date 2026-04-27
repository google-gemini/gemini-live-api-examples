export type QuestionType = "rating" | "multiple_choice" | "open_ended" | "yes_no" | "scale";

export interface SurveyQuestion {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  required: boolean;
  followUp?: string;
}

export interface SurveySection {
  id: string;
  title: string;
  description: string;
  questions: SurveyQuestion[];
}

export interface Survey {
  id: string;
  name: string;
  product: string;
  status: "draft" | "active" | "completed" | "paused";
  createdAt: string;
  responsesCount: number;
  avgDuration: string;
  sections: SurveySection[];
  flowMode: "structured" | "flexible";
  avgSatisfaction?: number;
  systemInstructions?: string;
}

export interface SessionResult {
  id: string;
  surveyId: string;
  customerName: string;
  customerAvatar: string;
  date: string;
  duration: string;
  sentiment: "positive" | "neutral" | "negative";
  satisfactionScore: number;
  keyInsights: string[];
  topIssues: string[];
  pictures?: string[];
  transcript?: { role: "ai" | "user", text: string, time: string }[];
  videoUrl?: string;
  summary?: string;
  qaMapping?: { question: string, answer: string }[];
}

export function addSession(session: SessionResult) {
  demoSessions.unshift(session);
  localStorage.setItem("demo_sessions", JSON.stringify(demoSessions));
}

export interface AggregatedInsight {
  topic: string;
  mentions: number;
  sentiment: "positive" | "neutral" | "negative";
  percentage: number;
}

export const demoSurveys: Survey[] = [
  {
    id: "srv-001",
    name: "TurboClean Pro 3000 - User Experience",
    product: "TurboClean Pro 3000 Vacuum",
    status: "active",
    createdAt: "2026-03-15",
    responsesCount: 47,
    avgDuration: "12 min",
    avgSatisfaction: 4.2,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "General Satisfaction",
        description: "Overall experience with the product",
        questions: [
          { id: "q1", text: "How satisfied are you with your TurboClean Pro 3000?", type: "rating", required: true },
          { id: "q2", text: "How often do you use your vacuum cleaner?", type: "multiple_choice", options: ["Daily", "2-3 times/week", "Weekly", "Less than weekly"], required: true },
          { id: "q3", text: "Would you recommend this product to a friend?", type: "yes_no", required: true },
        ],
      },
      {
        id: "sec-2",
        title: "Ease of Use",
        description: "How intuitive and easy the product is to operate",
        questions: [
          { id: "q4", text: "How easy is it to turn the vacuum on and off?", type: "scale", required: true },
          { id: "q5", text: "How easy is it to change between cleaning modes?", type: "scale", required: true },
          { id: "q6", text: "What features do you find most difficult to use?", type: "open_ended", required: false, followUp: "Can you show me the part you're having trouble with?" },
        ],
      },
      {
        id: "sec-3",
        title: "Design & Build Quality",
        description: "Physical design and durability",
        questions: [
          { id: "q7", text: "How would you rate the build quality?", type: "rating", required: true },
          { id: "q8", text: "Have you experienced any breakage or defects?", type: "yes_no", required: true, followUp: "Can you show me the damage?" },
          { id: "q9", text: "What design improvements would you suggest?", type: "open_ended", required: false },
        ],
      },
    ],
  },
  {
    id: "srv-002",
    name: "AeroVac Slim - Post-Purchase Feedback",
    product: "AeroVac Slim Cordless",
    status: "active",
    createdAt: "2026-03-10",
    responsesCount: 23,
    avgDuration: "8 min",
    avgSatisfaction: 3.8,
    flowMode: "structured",
    sections: [
      {
        id: "sec-1",
        title: "First Impressions",
        description: "Initial unboxing and setup experience",
        questions: [
          { id: "q1", text: "How was your unboxing experience?", type: "rating", required: true },
          { id: "q2", text: "How easy was the initial setup?", type: "scale", required: true },
        ],
      },
    ],
  },
  {
    id: "srv-003",
    name: "Product Line Comparison",
    product: "All Vacuum Models",
    status: "draft",
    createdAt: "2026-03-20",
    responsesCount: 0,
    avgDuration: "—",
    flowMode: "flexible",
    sections: [],
  },
  {
    id: "srv-004",
    name: "Customer Support Experience",
    product: "Support Services",
    status: "completed",
    createdAt: "2026-02-28",
    responsesCount: 89,
    avgDuration: "15 min",
    avgSatisfaction: 3.5,
    flowMode: "structured",
    sections: [],
  },
  {
    id: "srv-005",
    name: "Soda Bottle Opening Experience",
    product: "Soda Bottle",
    status: "active",
    createdAt: "2026-03-26",
    responsesCount: 0,
    avgDuration: "—",
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Introduction",
        description: "Welcome and initial questions",
        questions: [
          { id: "q1", text: "What brand of soda are you using today?", type: "open_ended", required: true },
        ],
      },
      {
        id: "sec-2",
        title: "Opening the Bottle",
        description: "Evaluating the opening process",
        questions: [
          { id: "q2", text: "Please show me how you open the bottle.", type: "open_ended", required: true, followUp: "Can you do it slowly so I can observe?" },
          { id: "q3", text: "Did you find it easy or difficult to open?", type: "scale", required: true },
        ],
      },
      {
        id: "sec-3",
        title: "Verification",
        description: "Agent verification of the action",
        questions: [
          { id: "q4", text: "Did I evaluate your opening process correctly?", type: "yes_no", required: true },
        ],
      },
    ],
    systemInstructions: "For this survey, you must visually verify how the user opens the bottle. Ask them to show opening the bottle to the camera. You should observe the video feed (sent to you periodically) or take a picture using the `take_picture` tool if you need a clearer view. Evaluate if they are doing it correctly (e.g., using proper grip, direction, etc.). Provide friendly feedback on their technique.",
  },
  {
    id: "int-001",
    name: "Customer Engineer Prep Session",
    product: "Google Cloud AI CE role",
    status: "active",
    createdAt: "2026-03-28",
    responsesCount: 12,
    avgDuration: "25 min",
    avgSatisfaction: 4.8,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Architecture Design",
        description: "Evaluating architecture skills",
        questions: [{ id: "q1", text: "Design a scalable video processing pipeline on GCP.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a Senior Customer Engineer Interviewer at Google. Ask complex architecture questions and evaluate the candidate's use of GCP services. Be professional and probe for depth.",
  },
  {
    id: "int-002",
    name: "Software Engineer Mock Interview",
    product: "Algorithmic Prep",
    status: "active",
    createdAt: "2026-03-29",
    responsesCount: 5,
    avgDuration: "45 min",
    avgSatisfaction: 4.6,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Algorithms & Data Structures",
        description: "Technical coding prep",
        questions: [{ id: "q1", text: "Let's solve a graph traversal problem.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a Google Software Engineer conducting a mock coding interview. Ask algorithmic questions and evaluate time/space complexity.",
  },
  {
    id: "kid-001",
    name: "Math & English Adventure",
    product: "Kids Learning Fun",
    status: "active",
    createdAt: "2026-03-29",
    responsesCount: 34,
    avgDuration: "15 min",
    avgSatisfaction: 4.9,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Fun with Numbers",
        description: "Counting and basic math",
        questions: [{ id: "q1", text: "Let's count to 10! Or do a fun equation.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a friendly, fun AI tutor for kids. Teach them math and English concepts playfully. Use lots of encouragement and simple words. You can speak in Hebrew or English and adjust to their language preferences.",
  },
  {
    id: "kid-002",
    name: "English Alphabet & Words",
    product: "Kids English",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 15,
    avgDuration: "12 min",
    avgSatisfaction: 4.8,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Letters & Sounds",
        description: "Learning phonics and letters",
        questions: [{ id: "q1", text: "Let's learn a new letter! Which one do you want to start with?", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a playful English teacher for young children. Teach them letters and simple words. Use rhymes and songs!",
  },
  {
    id: "kid-003",
    name: "Math: Shapes & Counting",
    product: "Kids Math",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 22,
    avgDuration: "18 min",
    avgSatisfaction: 4.7,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Shapes are Everywhere",
        description: "Identifying shapes in the real world",
        questions: [{ id: "q1", text: "Look around you! Can you see a circle? Use the camera to show me!", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a fun Math teacher. Use objects around the room to teach geometry and counting. Encourage the user to use the camera!",
  },
  {
    id: "kid-004",
    name: "Pick Your Topic Adventure!",
    product: "General Learning",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 45,
    avgDuration: "20 min",
    avgSatisfaction: 4.9,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Free Choice",
        description: "Letting the child drive the learning",
        questions: [{ id: "q1", text: "What do you want to learn today? Dinosaurs, Space, Animals, or something else?", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a super-smart, fun AI companion. The child chooses the topic (Dinosaurs, Space, Animals, etc.). Adapt your teaching to whatever they choose and make it fun!",
  },
  {
    id: "gem-001",
    name: "Gemara Mastery Session",
    product: "Gemara",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 0,
    avgDuration: "0 min",
    avgSatisfaction: 0,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Page Selection",
        description: "Choose the page to learn",
        questions: [{ id: "q1", text: "Please tell me which Masechet and Daf you want to learn today.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "אתה מורה פרטי לגמרא. תפקידך לעזור לתלמיד להבין את הדף שהוא בחר (מסכת ודף). הסבר את המושגים בעברית ברורה ופשוטה. השתמש בשפה מכבדת. אל תהיה חברמני מדי, אלא מורה מקצועי ומעמיק.",
  },
  {
    id: "cou-001",
    name: "Marriage Counseling (Elderly)",
    product: "Counseling",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 0,
    avgDuration: "0 min",
    avgSatisfaction: 0,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Conflict Discovery",
        description: "Understanding the conflict from one of the partners",
        questions: [{ id: "q1", text: "Please tell me about the conflict you are experiencing with your partner.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a neutral, objective Marriage Counselor for elderly couples. Your job is to help the husband or wife resolve conflicts without taking sides. Listen carefully to their perspective and facilitate understanding. Be empathetic but professional. Help them find common ground.",
  },
  {
    id: "gui-001",
    name: "Guitar Mastery Session",
    product: "Guitar",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 0,
    avgDuration: "0 min",
    avgSatisfaction: 0,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Posture Check",
        description: "Checking how the user holds the guitar",
        questions: [{ id: "q1", text: "Please use the camera to show me how you are holding the guitar.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a strict and objective Guitar Instructor. Your job is to check the student's posture and technique. Use the camera tool to verify their grip. When they play a chord, listen carefully to the pitch and tone. Do not be overly complimentary—be honest. If it sounds bad or if their grip is incorrect, tell them clearly and direct them on how to fix it.",
  },
  {
    id: "lis-001",
    name: "Customer Engineer Real-time Assistant",
    product: "Google Cloud",
    status: "active",
    createdAt: "2026-03-30",
    responsesCount: 0,
    avgDuration: "0 min",
    avgSatisfaction: 0,
    flowMode: "flexible",
    sections: [
      {
        id: "sec-1",
        title: "Active Listening",
        description: "Listen to the meeting and provide real-time suggestions.",
        questions: [{ id: "q1", text: "I am listening to the meeting. I will provide suggestions soon.", type: "open_ended", required: true }],
      }
    ],
    systemInstructions: "You are a silent real-time assistant for Google Cloud Customer Engineers. Listen to the conversation. Generate real-time advice and technical architecture diagrams using Mermaid syntax. DO NOT speak over audio! Output text suggestions and Mermaid blocks only.",
  },
];

const savedSessions = localStorage.getItem("demo_sessions");
export const demoSessions: SessionResult[] = savedSessions ? JSON.parse(savedSessions) : [
  {
    id: "ses-001", surveyId: "srv-001", customerName: "Sarah Mitchell", customerAvatar: "SM",
    date: "2026-03-22", duration: "14 min", sentiment: "positive", satisfactionScore: 4.5,
    keyInsights: ["Loves the suction power", "Uses it daily for pet hair", "Battery life could be better"],
    topIssues: ["Battery drains fast on turbo mode"],
  },
  {
    id: "ses-002", surveyId: "srv-001", customerName: "James Rodriguez", customerAvatar: "JR",
    date: "2026-03-21", duration: "11 min", sentiment: "neutral", satisfactionScore: 3.5,
    keyInsights: ["Decent performance on hardwood", "Struggles with thick carpets", "Filter replacement is confusing"],
    topIssues: ["Hard to find the power button", "Filter replacement unclear"],
  },
  {
    id: "ses-003", surveyId: "srv-001", customerName: "Emily Chen", customerAvatar: "EC",
    date: "2026-03-20", duration: "9 min", sentiment: "positive", satisfactionScore: 4.8,
    keyInsights: ["Very quiet compared to old model", "Easy to empty dustbin", "Great on stairs"],
    topIssues: [],
  },
  {
    id: "ses-004", surveyId: "srv-001", customerName: "Michael Thompson", customerAvatar: "MT",
    date: "2026-03-19", duration: "16 min", sentiment: "negative", satisfactionScore: 2.5,
    keyInsights: ["Hose attachment broke after 2 weeks", "Customer support was slow to respond"],
    topIssues: ["Hose attachment broke", "Power button hard to reach", "Loud on turbo mode"],
  },
  {
    id: "ses-005", surveyId: "srv-001", customerName: "Lisa Park", customerAvatar: "LP",
    date: "2026-03-18", duration: "12 min", sentiment: "positive", satisfactionScore: 4.0,
    keyInsights: ["Works great for small apartments", "Lightweight and easy to carry", "Wish it had a longer cord"],
    topIssues: ["Cord is too short"],
  },
];

export const demoInsights: AggregatedInsight[] = [
  { topic: "Power button placement", mentions: 34, sentiment: "negative", percentage: 72 },
  { topic: "Suction power", mentions: 41, sentiment: "positive", percentage: 87 },
  { topic: "Battery life concerns", mentions: 28, sentiment: "negative", percentage: 60 },
  { topic: "Build quality", mentions: 22, sentiment: "positive", percentage: 75 },
  { topic: "Noise level on turbo", mentions: 19, sentiment: "negative", percentage: 40 },
  { topic: "Easy to clean dustbin", mentions: 31, sentiment: "positive", percentage: 66 },
  { topic: "Filter replacement confusing", mentions: 15, sentiment: "negative", percentage: 32 },
  { topic: "Lightweight design", mentions: 38, sentiment: "positive", percentage: 81 },
];

export const defaultSafetyRules = [
  { id: "sr-1", rule: "Do not ask about personal financial information", enabled: true, isDefault: true },
  { id: "sr-2", rule: "Do not ask about health conditions or medical history", enabled: true, isDefault: true },
  { id: "sr-3", rule: "Do not ask about political opinions or affiliations", enabled: true, isDefault: true },
  { id: "sr-4", rule: "Do not ask about religious beliefs", enabled: true, isDefault: true },
  { id: "sr-5", rule: "Do not make promises about product changes or refunds", enabled: true, isDefault: true },
  { id: "sr-6", rule: "Keep conversation professional and respectful at all times", enabled: true, isDefault: true },
  { id: "sr-7", rule: "Do not ask about competitor products by name", enabled: false, isDefault: false },
  { id: "sr-8", rule: "Avoid discussing pricing or discount information", enabled: false, isDefault: false },
];
