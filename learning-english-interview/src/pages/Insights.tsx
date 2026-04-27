import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { demoSessions, demoInsights } from "@/lib/demo-data";
import { TrendingUp, TrendingDown, Minus, BarChart3, Users, AlertTriangle, ThumbsUp } from "lucide-react";

const sentimentIcon = {
  positive: ThumbsUp,
  negative: AlertTriangle,
  neutral: Minus,
};

const sentimentColor = {
  positive: "text-success",
  negative: "text-destructive",
  neutral: "text-warning",
};

const barColor = {
  positive: "bg-success",
  negative: "bg-destructive",
  neutral: "bg-warning",
};

const Insights = () => {
  const navigate = useNavigate();
  const positiveCount = demoSessions.filter(s => s.sentiment === "positive").length;
  const negativeCount = demoSessions.filter(s => s.sentiment === "negative").length;
  const avgScore = (demoSessions.reduce((a, s) => a + s.satisfactionScore, 0) / demoSessions.length).toFixed(1);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold text-foreground">Insights</h1>
        <p className="mt-1 text-muted-foreground">Aggregated analysis across all conversations for TurboClean Pro 3000</p>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Sessions", value: demoSessions.length, icon: Users, color: "text-primary" },
          { label: "Avg. Score", value: `${avgScore}/5`, icon: BarChart3, color: "text-primary" },
          { label: "Positive", value: positiveCount, icon: ThumbsUp, color: "text-success" },
          { label: "Issues Found", value: negativeCount, icon: AlertTriangle, color: "text-destructive" },
        ].map(s => (
          <Card key={s.label} className="bg-gradient-card border-border p-5 shadow-card">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <s.icon className={`h-5 w-5 ${s.color}`} />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="font-display text-2xl font-bold text-foreground">{s.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Topic Analysis */}
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground mb-4">Topic Analysis</h2>
        <Card className="bg-gradient-card border-border p-6 shadow-card">
          <div className="space-y-4">
            {demoInsights.sort((a, b) => b.mentions - a.mentions).map(insight => {
              const Icon = sentimentIcon[insight.sentiment];
              return (
                <div key={insight.topic} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${sentimentColor[insight.sentiment]}`} />
                      <span className="text-sm font-medium text-foreground">{insight.topic}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{insight.mentions} mentions</span>
                      <span>{insight.percentage}%</span>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-secondary">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${insight.percentage}%` }}
                      transition={{ duration: 0.8, delay: 0.2 }}
                      className={`h-full rounded-full ${barColor[insight.sentiment]}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Key Findings */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-gradient-card border-border p-6 shadow-card">
          <h3 className="font-display font-semibold text-foreground flex items-center gap-2 mb-4">
            <ThumbsUp className="h-4 w-4 text-success" /> Top Strengths
          </h3>
          <div className="space-y-3">
            {demoInsights.filter(i => i.sentiment === "positive").sort((a, b) => b.mentions - a.mentions).slice(0, 4).map(i => (
              <div key={i.topic} className="flex items-center justify-between rounded-lg bg-success/5 px-4 py-2.5">
                <span className="text-sm text-foreground">{i.topic}</span>
                <span className="text-xs text-success font-medium">{i.mentions} mentions</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="bg-gradient-card border-border p-6 shadow-card">
          <h3 className="font-display font-semibold text-foreground flex items-center gap-2 mb-4">
            <AlertTriangle className="h-4 w-4 text-destructive" /> Top Issues
          </h3>
          <div className="space-y-3">
            {demoInsights.filter(i => i.sentiment === "negative").sort((a, b) => b.mentions - a.mentions).slice(0, 4).map(i => (
              <div key={i.topic} className="flex items-center justify-between rounded-lg bg-destructive/5 px-4 py-2.5">
                <span className="text-sm text-foreground">{i.topic}</span>
                <span className="text-xs text-destructive font-medium">{i.mentions} mentions</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Session-level details */}
      <div>
        <h2 className="font-display text-xl font-semibold text-foreground mb-4">Individual Sessions</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {demoSessions.map(session => (
            <Card key={session.id} className="bg-card border-border p-5 shadow-sm hover:border-primary/30 hover:shadow-md transition-all cursor-pointer" onClick={() => navigate(`/sessions/${session.id}`)}>
              <div className="flex items-center gap-3 mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-semibold text-primary">
                  {session.customerAvatar}
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{session.customerName}</p>
                  <p className="text-xs text-muted-foreground">{session.date} · {session.duration}</p>
                </div>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${
                  session.sentiment === "positive" ? "bg-success/10 text-success" :
                  session.sentiment === "negative" ? "bg-destructive/10 text-destructive" :
                  "bg-warning/10 text-warning"
                }`}>{session.satisfactionScore}/5</span>
              </div>
              <div className="space-y-1.5">
                {session.keyInsights.map((insight, i) => (
                  <p key={i} className="text-xs text-muted-foreground">• {insight}</p>
                ))}
              </div>
              {session.topIssues.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {session.topIssues.map((issue, i) => (
                    <span key={i} className="rounded-md bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{issue}</span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>
    </motion.div>
  );
};

export default Insights;
