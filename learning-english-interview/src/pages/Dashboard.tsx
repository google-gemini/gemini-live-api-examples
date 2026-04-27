import { motion } from "framer-motion";
import { BarChart3, ClipboardList, MessageSquare, Users, TrendingUp, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { demoSurveys, demoSessions } from "@/lib/demo-data";
import { useNavigate } from "react-router-dom";
import { useProductMode } from "@/hooks/use-product-mode";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35 } },
};

const Dashboard = () => {
  const navigate = useNavigate();
  const [mode] = useProductMode();

  const getStats = () => {
    if (mode === "interviews") {
      return [
        { label: "Active Tracks", value: "2", icon: ClipboardList, change: "+1 this week" },
        { label: "Mock Interviews", value: "45", icon: MessageSquare, change: "+5 today" },
        { label: "Avg. Duration", value: "35 min", icon: Clock, change: "↑ 5 min" },
        { label: "Score Avg", value: "4.6", icon: TrendingUp, change: "+0.2 vs last month" },
      ];
    } else if (mode === "kids") {
      return [
        { label: "Learning Modules", value: "1", icon: ClipboardList, change: "Ready" },
        { label: "Play Sessions", value: "124", icon: MessageSquare, change: "+12 today" },
        { label: "Learning Time", value: "15 min", icon: Clock, change: "Optimal" },
        { label: "Engagement", value: "99%", icon: TrendingUp, change: "High" },
      ];
    }
    return [
      { label: "Active Surveys", value: "3", icon: ClipboardList, change: "+2 this week" },
      { label: "Total Conversations", value: "159", icon: MessageSquare, change: "+23 today" },
      { label: "Avg. Session Duration", value: "12 min", icon: Clock, change: "↑ 2 min" },
      { label: "Satisfaction Score", value: "4.1", icon: TrendingUp, change: "+0.3 vs last month" },
    ];
  };

  const currentStats = getStats();
  const title = mode === "surveys" ? "Surveys Dashboard" : mode === "interviews" ? "AI Interview Prep" : "Kids Learning Hub";
  const subtitle = mode === "surveys" ? "Welcome back. Here's what's happening with your surveys." : mode === "interviews" ? "Master your technical and communication skills." : "Fun and educational tools for children.";

  return (
    <motion.div variants={container} initial="hidden" animate="show" className="space-y-8">
      {/* Header */}
      <motion.div variants={item}>
        <h1 className="font-display text-3xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 text-muted-foreground">{subtitle}</p>
      </motion.div>

      {/* Stats */}
      <motion.div variants={item} className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {currentStats.map((s) => (
          <Card key={s.label} className="bg-gradient-card border-border p-5 shadow-card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{s.label}</p>
                <p className="mt-1 font-display text-2xl font-bold text-foreground">{s.value}</p>
                <p className="mt-1 text-xs text-primary">{s.change}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <s.icon className="h-5 w-5 text-primary" />
              </div>
            </div>
          </Card>
        ))}
      </motion.div>

      {/* Active Items */}
      <motion.div variants={item}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold text-foreground">
            {mode === "surveys" ? "Active Surveys" : mode === "interviews" ? "Interview Tracks" : "Learning Activities"}
          </h2>
          <button onClick={() => navigate("/surveys")} className="text-sm text-primary hover:underline">View all →</button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {demoSurveys.filter(s => {
            if (mode === "interviews") return s.id.startsWith("int-") && s.status === "active";
            if (mode === "kids") return s.id.startsWith("kid-") && s.status === "active";
            return s.id.startsWith("srv-") && s.status === "active";
          }).map(survey => (
            <Card
              key={survey.id}
              className="cursor-pointer border-border bg-gradient-card p-5 shadow-card transition-all hover:border-primary/30 hover:shadow-glow"
              onClick={() => navigate(`/surveys/${survey.id}`)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-display font-semibold text-foreground">{survey.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{survey.product}</p>
                </div>
                <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                  Active
                </span>
              </div>
              <div className="mt-4 flex items-center gap-6 text-sm text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  {survey.responsesCount} responses
                </div>
                <div className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Avg {survey.avgDuration}
                </div>
                {survey.avgSatisfaction && (
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5" />
                    {survey.avgSatisfaction}/5
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </motion.div>

      {/* Recent Sessions */}
      <motion.div variants={item}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold text-foreground">Recent Conversations</h2>
          <button onClick={() => navigate("/insights")} className="text-sm text-primary hover:underline">View insights →</button>
        </div>
        <Card className="border-border bg-gradient-card shadow-card overflow-hidden">
          <div className="divide-y divide-border">
            {demoSessions.slice(0, 4).map(session => (
              <div key={session.id} className="flex items-center gap-4 p-4 transition-colors hover:bg-secondary/30 cursor-pointer" onClick={() => navigate(`/sessions/${session.id}`)}>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 font-display text-sm font-semibold text-primary">
                  {session.customerAvatar}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">{session.customerName}</p>
                  <p className="text-xs text-muted-foreground">{session.date} · {session.duration}</p>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  session.sentiment === "positive" ? "bg-success/10 text-success" :
                  session.sentiment === "negative" ? "bg-destructive/10 text-destructive" :
                  "bg-warning/10 text-warning"
                }`}>
                  {session.sentiment}
                </span>
                <div className="text-right">
                  <p className="font-display text-sm font-semibold text-foreground">{session.satisfactionScore}/5</p>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </motion.div>
    </motion.div>
  );
};

export default Dashboard;
