export async function summarizeSession(apiKey: string, transcript: string, survey: any) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  
  const prompt = `
You are an expert product researcher. Analyze the following transcript of an AI-led customer interview about a product ("${survey?.product || "the product"}").
The survey contained the following questions that the AI was supposed to ask:
${JSON.stringify(survey?.sections?.flatMap((s: any) => s.questions.map((q: any) => q.text)) || [])}

Conversation Transcript:
${transcript}

Output a JSON object perfectly matching this schema:
{
  "summary": "A 2-3 line summarization of the entire conversation.",
  "sentiment": "positive" | "neutral" | "negative",
  "satisfactionScore": 4, // A number from 1 to 5
  "keyInsights": ["Array of 1-3 key insights"],
  "topIssues": ["Array of 0-3 top issues reported, leave empty if none"],
  "qaMapping": [
    { "question": "The question asked from the survey", "answer": "The user's synthesized answer based on the transcript. Be concise." }
  ]
}
`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No summary generated");
    
    return JSON.parse(text);
  } catch (err: any) {
    console.error("Summarization error:", err);
    // Save error to localStorage for debugging
    localStorage.setItem("debug_summarize_error", err.message || JSON.stringify(err));
    localStorage.setItem("debug_summarize_transcript", transcript);
    localStorage.setItem("debug_summarize_survey", JSON.stringify(survey));
    // Return a fallback so the app continues gracefully if quota runs out
    return {
      summary: "The session was successfully captured, but AI summarization failed to process the transcript.",
      sentiment: "neutral",
      satisfactionScore: 3,
      keyInsights: ["Real-time insights generation failed"],
      topIssues: [],
      qaMapping: []
    };
  }
}
