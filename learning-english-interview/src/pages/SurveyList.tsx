import { motion } from "framer-motion";
import { Plus, Search, Filter } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { demoSurveys } from "@/lib/demo-data";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { Users, Clock, TrendingUp } from "lucide-react";

const statusColors: Record<string, string> = {
  active: "bg-success/10 text-success border-success/20",
  draft: "bg-muted text-muted-foreground border-border",
  completed: "bg-info/10 text-info border-info/20",
  paused: "bg-warning/10 text-warning border-warning/20",
};

const SurveyList = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");

  const filtered = demoSurveys.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.product.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-foreground">Surveys</h1>
          <p className="mt-1 text-muted-foreground">Create and manage your customer surveys</p>
        </div>
        <Button onClick={() => navigate("/surveys/new")} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
          <Plus className="mr-2 h-4 w-4" /> New Survey
        </Button>
      </div>

      <div className="flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search surveys..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-secondary border-border pl-10"
          />
        </div>
        <Button variant="outline" className="border-border text-muted-foreground">
          <Filter className="mr-2 h-4 w-4" /> Filter
        </Button>
      </div>

      <div className="grid gap-4">
        {filtered.map((survey, i) => (
          <motion.div
            key={survey.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <Card
              className="cursor-pointer border-border bg-card p-5 shadow-sm transition-all hover:border-primary/30 hover:shadow-md"
              onClick={() => navigate(`/surveys/${survey.id}`)}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h3 className="font-display text-lg font-semibold text-foreground">{survey.name}</h3>
                    <Badge variant="outline" className={statusColors[survey.status]}>
                      {survey.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{survey.product}</p>
                  <div className="mt-3 flex items-center gap-6 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />{survey.responsesCount} responses</span>
                    <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" />Avg {survey.avgDuration}</span>
                    {survey.avgSatisfaction && (
                      <span className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5" />{survey.avgSatisfaction}/5</span>
                    )}
                    <span>Flow: {survey.flowMode}</span>
                    <span>Created: {survey.createdAt}</span>
                  </div>
                </div>
              </div>
            </Card>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
};

export default SurveyList;
