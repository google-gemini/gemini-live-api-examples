import { motion } from "framer-motion";
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, GripVertical, Trash2, MessageSquare, Star, CheckSquare, Type, Sliders, ChevronDown, ChevronUp, Sparkles, Send, Link2, Loader2 } from "lucide-react";
import { QuestionType, SurveySection, SurveyQuestion, demoSurveys } from "@/lib/demo-data";
import { toast } from "sonner";

const questionTypeIcons: Record<QuestionType, typeof Star> = {
  rating: Star,
  multiple_choice: CheckSquare,
  open_ended: Type,
  yes_no: MessageSquare,
  scale: Sliders,
};

const questionTypeLabels: Record<QuestionType, string> = {
  rating: "Rating (1-5)",
  multiple_choice: "Multiple Choice",
  open_ended: "Open Ended",
  yes_no: "Yes / No",
  scale: "Scale (1-10)",
};

let idCounter = 200;
const genId = () => `edit-${idCounter++}`;

const SurveyEdit = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const survey = demoSurveys.find(s => s.id === id);

  const [surveyName, setSurveyName] = useState(survey?.name || "");
  const [productName, setProductName] = useState(survey?.product || "");
  const [flowMode, setFlowMode] = useState<"structured" | "flexible">(survey?.flowMode || "flexible");
  const [sections, setSections] = useState<SurveySection[]>(survey?.sections || []);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(sections.map(s => s.id)));
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");

  if (!survey) {
    return <div className="text-center text-muted-foreground py-20">Survey not found</div>;
  }

  const toggleSection = (secId: string) => {
    setExpandedSections(prev => { const next = new Set(prev); next.has(secId) ? next.delete(secId) : next.add(secId); return next; });
  };

  const addSection = () => {
    const secId = genId();
    setSections([...sections, { id: secId, title: "New Section", description: "", questions: [] }]);
    setExpandedSections(prev => new Set(prev).add(secId));
  };

  const removeSection = (secId: string) => setSections(sections.filter(s => s.id !== secId));
  const updateSection = (secId: string, field: keyof SurveySection, value: string) =>
    setSections(sections.map(s => s.id === secId ? { ...s, [field]: value } : s));

  const addQuestion = (sectionId: string, type: QuestionType) => {
    setSections(sections.map(s => {
      if (s.id !== sectionId) return s;
      return { ...s, questions: [...s.questions, { id: genId(), text: "", type, required: true, options: type === "multiple_choice" ? ["Option 1", "Option 2"] : undefined }] };
    }));
  };

  const updateQuestion = (sectionId: string, qId: string, updates: Partial<SurveyQuestion>) => {
    setSections(sections.map(s => {
      if (s.id !== sectionId) return s;
      return { ...s, questions: s.questions.map(q => q.id === qId ? { ...q, ...updates } : q) };
    }));
  };

  const removeQuestion = (sectionId: string, qId: string) =>
    setSections(sections.map(s => s.id !== sectionId ? s : { ...s, questions: s.questions.filter(q => q.id !== qId) }));

  const handleSave = () => {
    toast.success("Survey updated!", { description: "Changes have been saved." });
    navigate(`/surveys/${id}`);
  };

  const handleSendInvite = () => {
    if (!inviteEmail) return;
    toast.success(`Invitation sent to ${inviteEmail}`, { description: "They will receive a link to start the live session." });
    setInviteEmail("");
    setShowInvite(false);
  };

  const liveLink = `${window.location.origin}/live?survey=${id}`;
  const copyLink = () => {
    navigator.clipboard.writeText(liveLink);
    toast.success("Live session link copied!");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-4xl">
      <div>
        <button onClick={() => navigate(`/surveys/${id}`)} className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to Survey
        </button>
        <h1 className="font-display text-2xl font-bold text-foreground">Edit Survey</h1>
        <p className="mt-1 text-muted-foreground">Modify questions, sections, and settings</p>
      </div>

      {/* Basic Info */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <h2 className="font-display text-lg font-semibold text-foreground">Survey Details</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Survey Name</Label>
            <Input value={surveyName} onChange={e => setSurveyName(e.target.value)} className="bg-secondary border-border" />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">Product Name</Label>
            <Input value={productName} onChange={e => setProductName(e.target.value)} className="bg-secondary border-border" />
          </div>
        </div>
        <div className="space-y-3">
          <Label className="text-muted-foreground">Conversation Flow</Label>
          <div className="grid grid-cols-2 gap-3">
            {(["structured", "flexible"] as const).map(mode => (
              <button key={mode} onClick={() => setFlowMode(mode)} className={`rounded-lg border p-4 text-left transition-all ${flowMode === mode ? "border-primary bg-primary/5 shadow-md" : "border-border bg-secondary/50 hover:border-muted-foreground/30"}`}>
                <div className="flex items-center gap-2">
                  <div className={`h-3 w-3 rounded-full ${flowMode === mode ? "bg-primary" : "bg-muted"}`} />
                  <span className="font-display font-semibold text-foreground capitalize">{mode}</span>
                  {mode === "flexible" && <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">Recommended</Badge>}
                </div>
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Invite & Live Link */}
      <Card className="bg-gradient-card border-border p-5 shadow-card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-foreground">Invitations & Live Link</h2>
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyLink} className="border-border text-muted-foreground">
              <Link2 className="mr-2 h-4 w-4" /> Copy Live Link
            </Button>
            <Button onClick={() => setShowInvite(!showInvite)} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
              <Send className="mr-2 h-4 w-4" /> Send Invite
            </Button>
          </div>
        </div>
        <div className="rounded-lg bg-secondary/50 px-4 py-2.5 flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <code className="text-xs text-primary flex-1">{liveLink}</code>
        </div>
        {showInvite && (
          <div className="flex gap-3">
            <Input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="customer@example.com" className="bg-secondary border-border" />
            <Button onClick={handleSendInvite} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">Send</Button>
          </div>
        )}
      </Card>

      {/* Sections */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-foreground">Sections & Questions</h2>
          <Button variant="outline" onClick={addSection} className="border-border text-muted-foreground">
            <Plus className="mr-2 h-4 w-4" /> Add Section
          </Button>
        </div>

        {sections.map((section, sIdx) => (
          <Card key={section.id} className="bg-gradient-card border-border shadow-card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-border p-4">
              <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 font-display text-xs font-bold text-primary">{sIdx + 1}</span>
              <div className="flex-1 space-y-1">
                <Input value={section.title} onChange={e => updateSection(section.id, "title", e.target.value)} className="h-8 border-0 bg-transparent p-0 font-display font-semibold text-foreground focus-visible:ring-0" />
                <Input value={section.description} onChange={e => updateSection(section.id, "description", e.target.value)} className="h-6 border-0 bg-transparent p-0 text-xs text-muted-foreground focus-visible:ring-0" />
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => toggleSection(section.id)} className="p-1 text-muted-foreground hover:text-foreground">
                  {expandedSections.has(section.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <button onClick={() => removeSection(section.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {expandedSections.has(section.id) && (
              <div className="p-4 space-y-3">
                {section.questions.map(q => {
                  const Icon = questionTypeIcons[q.type];
                  return (
                    <div key={q.id} className="rounded-lg bg-secondary/50 p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <GripVertical className="mt-2 h-4 w-4 text-muted-foreground cursor-grab" />
                        <div className="flex-1 space-y-2">
                          <Textarea value={q.text} onChange={e => updateQuestion(section.id, q.id, { text: e.target.value })} placeholder="Enter your question..." className="min-h-[40px] resize-none border-0 bg-transparent p-0 text-sm text-foreground focus-visible:ring-0" />
                          {q.type === "multiple_choice" && q.options && (
                            <div className="space-y-1.5 ml-1">
                              {q.options.map((opt, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <div className="h-3 w-3 rounded-sm border border-muted-foreground/30" />
                                  <Input value={opt} onChange={e => { const newOpts = [...q.options!]; newOpts[i] = e.target.value; updateQuestion(section.id, q.id, { options: newOpts }); }} className="h-7 border-0 bg-transparent p-0 text-xs text-muted-foreground focus-visible:ring-0" />
                                </div>
                              ))}
                              <button onClick={() => updateQuestion(section.id, q.id, { options: [...(q.options || []), `Option ${(q.options?.length || 0) + 1}`] })} className="ml-5 text-xs text-primary hover:underline">+ Add option</button>
                            </div>
                          )}
                          <Input value={q.followUp || ""} onChange={e => updateQuestion(section.id, q.id, { followUp: e.target.value || undefined })} placeholder="AI follow-up prompt (optional)" className="h-7 border-0 bg-transparent p-0 text-xs text-primary/60 focus-visible:ring-0" />
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="border-border text-muted-foreground text-xs gap-1"><Icon className="h-3 w-3" />{questionTypeLabels[q.type]}</Badge>
                          <div className="flex items-center gap-1.5">
                            <Switch checked={q.required} onCheckedChange={checked => updateQuestion(section.id, q.id, { required: checked })} className="scale-75" />
                            <span className="text-xs text-muted-foreground">Req</span>
                          </div>
                          <button onClick={() => removeQuestion(section.id, q.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-wrap gap-2 pt-2">
                  {(Object.keys(questionTypeIcons) as QuestionType[]).map(type => {
                    const Icon = questionTypeIcons[type];
                    return (
                      <button key={type} onClick={() => addQuestion(section.id, type)} className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground">
                        <Icon className="h-3 w-3" />{questionTypeLabels[type]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>
        ))}

        {sections.length === 0 && (
          <Card className="bg-gradient-card border-border border-dashed p-10 text-center shadow-card">
            <p className="text-muted-foreground">No sections yet. Add a section to start building your survey.</p>
            <Button variant="outline" className="mt-4 border-primary/30 text-primary" onClick={addSection}>
              <Plus className="mr-2 h-4 w-4" /> Add Section
            </Button>
          </Card>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-6">
        <Button variant="outline" onClick={() => navigate(`/surveys/${id}`)} className="border-border text-muted-foreground">Cancel</Button>
        <Button onClick={handleSave} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">Save Changes</Button>
      </div>
    </motion.div>
  );
};

export default SurveyEdit;
