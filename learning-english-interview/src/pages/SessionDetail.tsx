import { motion } from "framer-motion";
import { useParams, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { demoSessions, demoSurveys } from "@/lib/demo-data";
import { ArrowLeft, Video, Play, ThumbsUp, AlertTriangle, Clock, User, Camera, MessageSquare } from "lucide-react";

const SessionDetail = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const session = demoSessions.find(s => s.id === sessionId);

  if (!session) {
    return <div className="text-center text-muted-foreground py-20">Session not found</div>;
  }

  const survey = demoSurveys.find(s => s.id === session.surveyId);

  const sentimentColor = session.sentiment === "positive" ? "bg-success/10 text-success" :
    session.sentiment === "negative" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning";

  const isDemoSession = session.id.startsWith("ses-0");
  const transcript = session.transcript || (isDemoSession ? [
    { role: "ai" as const, text: `Hi ${session.customerName.split(" ")[0]}! Thanks for joining. I'd love to hear about your experience with the ${survey?.product || "product"}.`, time: "0:00" },
    { role: "user" as const, text: session.keyInsights[0] || "It's been a good experience overall.", time: "0:45" },
    { role: "ai" as const, text: "That's great to hear! Can you tell me more about that?", time: "1:12" },
    { role: "user" as const, text: session.keyInsights[1] || "There are some things that could be improved.", time: "2:30" },
    ...(session.topIssues.length > 0 ? [
      { role: "ai" as const, text: "I noticed you mentioned some challenges. Could you show me what you mean?", time: "3:45" },
      { role: "user" as const, text: session.topIssues[0], time: "4:20" },
    ] : []),
    { role: "ai" as const, text: "Thank you so much for sharing your feedback. This has been really helpful!", time: session.duration.includes("min") ? session.duration.replace(" min", ":00") : "3:00" },
  ] : []);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div>
        <button onClick={() => navigate(-1)} className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      <div className="flex items-start justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-foreground">Session with {session.customerName}</h1>
            <p className="mt-1 text-muted-foreground">{survey?.name} · {session.date} · {session.duration}</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${sentimentColor}`}>{session.sentiment}</span>
        </div>
      </div>

      {/* AI Summary */}
      {session.summary && (
        <Card className="bg-gradient-card border-primary/20 border p-5 shadow-glow relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-10">
            <MessageSquare className="h-24 w-24 text-primary" />
          </div>
          <div className="relative z-10 space-y-2">
            <h2 className="font-display text-sm font-bold text-primary uppercase tracking-wider">AI Summary</h2>
            <p className="text-base text-foreground leading-relaxed max-w-4xl">{session.summary}</p>
          </div>
        </Card>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Satisfaction", value: `${session.satisfactionScore}/5`, icon: ThumbsUp },
          { label: "Duration", value: session.duration, icon: Clock },
          { label: "Issues Found", value: session.topIssues.length, icon: AlertTriangle },
          { label: "Key Insights", value: session.keyInsights.length, icon: MessageSquare },
        ].map(s => (
          <Card key={s.label} className="bg-gradient-card border-border p-4 shadow-card">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <s.icon className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="font-display text-lg font-semibold text-foreground">{s.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Video Recording */}
        <div className="col-span-2 space-y-6">
          <div className="space-y-4">
            <h2 className="font-display text-lg font-semibold text-foreground">Session Recording</h2>
            <Card className="bg-gradient-card border-border shadow-card overflow-hidden">
              {session.videoUrl ? (
                <video src={session.videoUrl} controls className="w-full aspect-video bg-black object-contain" />
              ) : (
                <div className="aspect-video bg-secondary/50 flex items-center justify-center relative">
                  <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent" />
                  <div className="text-center space-y-3 z-10">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/20 backdrop-blur-sm">
                      <Play className="h-6 w-6 text-primary ml-1" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Video Recording</p>
                      <p className="text-xs text-muted-foreground">{session.duration} · Recorded {session.date}</p>
                    </div>
                  </div>
                  {/* Mini camera preview */}
                  <div className="absolute bottom-4 right-4 w-32 h-24 rounded-lg bg-secondary border border-border flex items-center justify-center">
                    <div className="text-center">
                      <Camera className="h-4 w-4 text-muted-foreground mx-auto" />
                      <p className="text-[10px] text-muted-foreground mt-1">Customer cam</p>
                    </div>
                  </div>
                </div>
              )}
              <div className="p-4 flex items-center justify-between border-t border-border">
              <div className="flex items-center gap-2">
                <Video className="h-4 w-4 text-primary" />
                <span className="text-sm text-muted-foreground">Live AI conversation with camera analysis</span>
              </div>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground">
                <Play className="h-3 w-3 mr-1" /> Replay
              </Button>
            </div>
          </Card>
          </div>

          {/* Captured Images */}
          {session.pictures && session.pictures.length > 0 && (
            <div className="space-y-4">
              <h2 className="font-display text-lg font-semibold text-foreground">Captured Images</h2>
              <div className="grid grid-cols-2 gap-4">
                {session.pictures.map((pic, i) => (
                  <Card key={i} className="bg-gradient-card border-border shadow-card overflow-hidden">
                    <img src={pic} alt={`Captured ${i+1}`} className="w-full h-auto aspect-video object-cover" />
                    <div className="p-3 bg-secondary/30 border-t border-border">
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Camera className="h-3 w-3" /> Captured by AI
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Q&A Mapping */}
          {session.qaMapping && session.qaMapping.length > 0 && (
            <div className="space-y-4">
              <h2 className="font-display text-lg font-semibold text-foreground">Survey Execution</h2>
              <div className="space-y-3">
                {session.qaMapping.map((qa, i) => (
                  <Card key={i} className="bg-gradient-card border-border p-4 shadow-card">
                    <p className="text-xs font-semibold text-primary mb-1">Q: {qa.question}</p>
                    <p className="text-sm text-foreground">A: {qa.answer}</p>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Transcript */}
          <div className="space-y-4">
            <h2 className="font-display text-lg font-semibold text-foreground">Conversation Transcript</h2>
            <Card className="bg-gradient-card border-border p-5 shadow-card space-y-4 max-h-[600px] overflow-y-auto">
            {transcript.map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === "ai" ? "" : "flex-row-reverse"}`}>
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  msg.role === "ai" ? "bg-primary/10 text-primary" : "bg-secondary text-foreground"
                }`}>
                  {msg.role === "ai" ? "AI" : session.customerAvatar}
                </div>
                <div className={`max-w-[75%] rounded-xl px-4 py-2.5 ${
                  msg.role === "ai" ? "bg-secondary/70" : "bg-primary/10"
                }`}>
                  <p className="text-sm text-foreground">{msg.text}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{msg.time}</p>
                </div>
              </div>
            ))}
            </Card>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <h2 className="font-display text-lg font-semibold text-foreground">Key Insights</h2>
          <Card className="bg-gradient-card border-border p-5 shadow-card space-y-3">
            {session.keyInsights.map((insight, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg bg-success/5 px-3 py-2.5">
                <ThumbsUp className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
                <p className="text-sm text-foreground">{insight}</p>
              </div>
            ))}
          </Card>

          {session.topIssues.length > 0 && (
            <>
              <h2 className="font-display text-lg font-semibold text-foreground">Issues Reported</h2>
              <Card className="bg-gradient-card border-border p-5 shadow-card space-y-3">
                {session.topIssues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
                    <p className="text-sm text-foreground">{issue}</p>
                  </div>
                ))}
              </Card>
            </>
          )}

          <h2 className="font-display text-lg font-semibold text-foreground">Customer</h2>
          <Card className="bg-gradient-card border-border p-5 shadow-card">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-semibold text-primary">
                {session.customerAvatar}
              </div>
              <div>
                <p className="font-medium text-foreground">{session.customerName}</p>
                <p className="text-xs text-muted-foreground">Session {session.date}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </motion.div>
  );
};

export default SessionDetail;
