import { motion } from "framer-motion";
import { useParams, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { demoSurveys, demoSessions } from "@/lib/demo-data";
import { ArrowLeft, Play, Pause, Send, Users, Clock, TrendingUp, MessageSquare, Video, Edit } from "lucide-react";

const SurveyDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const survey = demoSurveys.find(s => s.id === id);

  if (!survey) {
    return <div className="text-center text-muted-foreground py-20">Survey not found</div>;
  }

  const sessions = demoSessions.filter(s => s.surveyId === id);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate("/surveys")} className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> Back to Surveys
          </button>
          <h1 className="font-display text-2xl font-bold text-foreground">{survey.name}</h1>
          <p className="mt-1 text-muted-foreground">{survey.product}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigate(`/surveys/${id}/edit`)} className="border-border text-muted-foreground">
            Edit Survey
          </Button>
          <Button variant="outline" className="border-border text-muted-foreground">
            <Send className="mr-2 h-4 w-4" /> Send Invites
          </Button>
          <Button onClick={() => navigate(`/live?survey=${id}`)} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
            <Play className="mr-2 h-4 w-4" /> Start Live Session
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Responses", value: survey.responsesCount, icon: Users },
          { label: "Avg Duration", value: survey.avgDuration, icon: Clock },
          { label: "Satisfaction", value: survey.avgSatisfaction ? `${survey.avgSatisfaction}/5` : "—", icon: TrendingUp },
          { label: "Flow Mode", value: survey.flowMode, icon: MessageSquare },
        ].map(s => (
          <Card key={s.label} className="bg-gradient-card border-border p-4 shadow-card">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                <s.icon className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="font-display text-lg font-semibold text-foreground capitalize">{s.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Sections */}
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground mb-4">Survey Sections</h2>
        <div className="space-y-4">
          {survey.sections.map((section, i) => (
            <Card key={section.id} className="bg-gradient-card border-border p-5 shadow-card">
              <div className="flex items-center gap-3 mb-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 font-display text-xs font-bold text-primary">{i + 1}</span>
                <div>
                  <h3 className="font-display font-semibold text-foreground">{section.title}</h3>
                  <p className="text-xs text-muted-foreground">{section.description}</p>
                </div>
              </div>
              <div className="ml-10 space-y-2">
                {section.questions.map(q => (
                  <div key={q.id} className="flex items-center justify-between rounded-lg bg-secondary/50 px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-foreground">{q.text}</span>
                      {q.followUp && <Badge variant="outline" className="border-primary/30 text-primary text-xs">+follow-up</Badge>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="border-border text-muted-foreground text-xs">{q.type.replace("_", " ")}</Badge>
                      {q.required && <span className="text-xs text-primary">*</span>}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ))}
          {survey.sections.length === 0 && (
            <Card className="bg-gradient-card border-border border-dashed p-10 text-center shadow-card">
              <p className="text-muted-foreground">No sections yet. Edit this survey to add questions.</p>
              <Button variant="outline" className="mt-4 border-primary/30 text-primary" onClick={() => navigate(`/surveys/new?edit=${survey.id}`)}>
                Edit Survey
              </Button>
            </Card>
          )}
        </div>
      </div>

      {/* Sessions */}
      {sessions.length > 0 && (
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground mb-4">Recent Conversations</h2>
          <Card className="border-border bg-gradient-card shadow-card overflow-hidden">
            <div className="divide-y divide-border">
              {sessions.map(session => (
                <div key={session.id} className="flex items-center gap-4 p-4 hover:bg-secondary/30 transition-colors cursor-pointer"
                     onClick={() => navigate(`/sessions/${session.id}`)}>
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-semibold text-primary">
                    {session.customerAvatar}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium text-foreground">{session.customerName}</p>
                    <p className="text-xs text-muted-foreground">{session.date} · {session.duration}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <Video className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs text-muted-foreground">Live call</span>
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      session.sentiment === "positive" ? "bg-success/10 text-success" :
                      session.sentiment === "negative" ? "bg-destructive/10 text-destructive" :
                      "bg-warning/10 text-warning"
                    }`}>{session.sentiment}</span>
                    <p className="font-display text-sm font-semibold text-foreground">{session.satisfactionScore}/5</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </motion.div>
  );
};

export default SurveyDetail;
