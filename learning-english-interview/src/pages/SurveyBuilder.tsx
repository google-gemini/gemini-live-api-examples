import { motion } from "framer-motion";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, GripVertical, Trash2, MessageSquare, Star, CheckSquare, Type, Sliders, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import { QuestionType, SurveySection, SurveyQuestion } from "@/lib/demo-data";
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

let idCounter = 100;
const genId = () => `gen-${idCounter++}`;

const SurveyBuilder = () => {
  const navigate = useNavigate();
  const [surveyName, setSurveyName] = useState("");
  const [productName, setProductName] = useState("");
  const [flowMode, setFlowMode] = useState<"structured" | "flexible">("flexible");
  const [aiPrompt, setAiPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [sections, setSections] = useState<SurveySection[]>([
    {
      id: genId(),
      title: "General Satisfaction",
      description: "Overall experience with the product",
      questions: [
        { id: genId(), text: "How satisfied are you with the product overall?", type: "rating", required: true },
      ],
    },
  ]);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(sections.map(s => s.id)));

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addSection = () => {
    const id = genId();
    const newSection: SurveySection = { id, title: "New Section", description: "", questions: [] };
    setSections([...sections, newSection]);
    setExpandedSections(prev => new Set(prev).add(id));
  };

  const removeSection = (id: string) => {
    setSections(sections.filter(s => s.id !== id));
  };

  const updateSection = (id: string, field: keyof SurveySection, value: string) => {
    setSections(sections.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  const addQuestion = (sectionId: string, type: QuestionType) => {
    setSections(sections.map(s => {
      if (s.id !== sectionId) return s;
      return {
        ...s,
        questions: [...s.questions, {
          id: genId(),
          text: "",
          type,
          required: true,
          options: type === "multiple_choice" ? ["Option 1", "Option 2"] : undefined,
        }],
      };
    }));
  };

  const updateQuestion = (sectionId: string, qId: string, updates: Partial<SurveyQuestion>) => {
    setSections(sections.map(s => {
      if (s.id !== sectionId) return s;
      return { ...s, questions: s.questions.map(q => q.id === qId ? { ...q, ...updates } : q) };
    }));
  };

  const removeQuestion = (sectionId: string, qId: string) => {
    setSections(sections.map(s => {
      if (s.id !== sectionId) return s;
      return { ...s, questions: s.questions.filter(q => q.id !== qId) };
    }));
  };

  const moveSectionUp = (index: number) => {
    if (index === 0) return;
    const next = [...sections];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setSections(next);
  };

  const moveSectionDown = (index: number) => {
    if (index === sections.length - 1) return;
    const next = [...sections];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setSections(next);
  };

  const handleSave = () => {
    toast.success("Survey saved successfully!", { description: "Your survey is ready to be activated." });
    navigate("/surveys");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-4xl">
      <div>
        <button onClick={() => navigate("/surveys")} className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to Surveys
        </button>
        <h1 className="font-display text-3xl font-bold text-foreground">Create New Survey</h1>
        <p className="mt-1 text-muted-foreground">Build your AI-powered conversational survey</p>
      </div>

      {/* Basic Info */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <h2 className="font-display text-lg font-semibold text-foreground">Survey Details</h2>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Survey Name</Label>
            <Input value={surveyName} onChange={e => setSurveyName(e.target.value)} placeholder="e.g., TurboClean User Experience" className="bg-secondary border-border" />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">Product Name</Label>
            <Input value={productName} onChange={e => setProductName(e.target.value)} placeholder="e.g., TurboClean Pro 3000" className="bg-secondary border-border" />
          </div>
        </div>

        {/* Flow Mode */}
        <div className="space-y-3">
          <Label className="text-muted-foreground">Conversation Flow</Label>
          <div className="grid grid-cols-2 gap-3">
            {(["structured", "flexible"] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setFlowMode(mode)}
                className={`rounded-lg border p-4 text-left transition-all ${
                  flowMode === mode
                    ? "border-primary bg-primary/5 shadow-md"
                    : "border-border bg-secondary/50 hover:border-muted-foreground/30"
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`h-3 w-3 rounded-full ${flowMode === mode ? "bg-primary" : "bg-muted"}`} />
                  <span className="font-display font-semibold text-foreground capitalize">{mode}</span>
                  {mode === "flexible" && <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">Recommended</Badge>}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {mode === "structured"
                    ? "Follow questions in order. Best for standardized data collection."
                    : "AI adapts questions based on responses. Feels like a real conversation."}
                </p>
              </button>
            ))}
          </div>
        </div>
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
            {/* Section Header */}
            <div className="flex items-center gap-3 border-b border-border p-4">
              <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 font-display text-xs font-bold text-primary">{sIdx + 1}</span>
              <div className="flex-1 space-y-1">
                <Input
                  value={section.title}
                  onChange={e => updateSection(section.id, "title", e.target.value)}
                  className="h-8 border-0 bg-transparent p-0 font-display font-semibold text-foreground focus-visible:ring-0"
                  placeholder="Section title"
                />
                <Input
                  value={section.description}
                  onChange={e => updateSection(section.id, "description", e.target.value)}
                  className="h-6 border-0 bg-transparent p-0 text-xs text-muted-foreground focus-visible:ring-0"
                  placeholder="Section description"
                />
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => moveSectionUp(sIdx)} className="p-1 text-muted-foreground hover:text-foreground"><ChevronUp className="h-4 w-4" /></button>
                <button onClick={() => moveSectionDown(sIdx)} className="p-1 text-muted-foreground hover:text-foreground"><ChevronDown className="h-4 w-4" /></button>
                <button onClick={() => toggleSection(section.id)} className="p-1 text-muted-foreground hover:text-foreground">
                  {expandedSections.has(section.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                <button onClick={() => removeSection(section.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>

            {/* Questions */}
            {expandedSections.has(section.id) && (
              <div className="p-4 space-y-3">
                {section.questions.map(q => {
                  const Icon = questionTypeIcons[q.type];
                  return (
                    <div key={q.id} className="rounded-lg bg-secondary/50 p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <GripVertical className="mt-2 h-4 w-4 text-muted-foreground cursor-grab" />
                        <div className="flex-1 space-y-2">
                          <Textarea
                            value={q.text}
                            onChange={e => updateQuestion(section.id, q.id, { text: e.target.value })}
                            placeholder="Enter your question..."
                            className="min-h-[40px] resize-none border-0 bg-transparent p-0 text-sm text-foreground focus-visible:ring-0"
                          />
                          {q.type === "multiple_choice" && q.options && (
                            <div className="space-y-1.5 ml-1">
                              {q.options.map((opt, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <div className="h-3 w-3 rounded-sm border border-muted-foreground/30" />
                                  <Input
                                    value={opt}
                                    onChange={e => {
                                      const newOpts = [...q.options!];
                                      newOpts[i] = e.target.value;
                                      updateQuestion(section.id, q.id, { options: newOpts });
                                    }}
                                    className="h-7 border-0 bg-transparent p-0 text-xs text-muted-foreground focus-visible:ring-0"
                                  />
                                </div>
                              ))}
                              <button
                                onClick={() => updateQuestion(section.id, q.id, { options: [...(q.options || []), `Option ${(q.options?.length || 0) + 1}`] })}
                                className="ml-5 text-xs text-primary hover:underline"
                              >+ Add option</button>
                            </div>
                          )}
                          {/* Follow-up */}
                          <div className="flex items-center gap-2">
                            <Input
                              value={q.followUp || ""}
                              onChange={e => updateQuestion(section.id, q.id, { followUp: e.target.value || undefined })}
                              placeholder="AI follow-up prompt (optional)"
                              className="h-7 border-0 bg-transparent p-0 text-xs text-primary/60 focus-visible:ring-0"
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="border-border text-muted-foreground text-xs gap-1">
                            <Icon className="h-3 w-3" />
                            {questionTypeLabels[q.type]}
                          </Badge>
                          <div className="flex items-center gap-1.5">
                            <Switch
                              checked={q.required}
                              onCheckedChange={checked => updateQuestion(section.id, q.id, { required: checked })}
                              className="scale-75"
                            />
                            <span className="text-xs text-muted-foreground">Req</span>
                          </div>
                          <button onClick={() => removeQuestion(section.id, q.id)} className="p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Add Question Buttons */}
                <div className="flex flex-wrap gap-2 pt-2">
                  {(Object.keys(questionTypeIcons) as QuestionType[]).map(type => {
                    const Icon = questionTypeIcons[type];
                    return (
                      <button
                        key={type}
                        onClick={() => addQuestion(section.id, type)}
                        className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
                      >
                        <Icon className="h-3 w-3" />
                        {questionTypeLabels[type]}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      {/* AI Generation */}
      <Card className="border-primary/20 bg-primary/5 p-5 shadow-sm space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="font-display font-semibold text-foreground">AI-Powered Survey Generation</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe what you want to learn and the AI will generate sections and questions for you.
            </p>
          </div>
        </div>
        <Textarea
          value={aiPrompt}
          onChange={e => setAiPrompt(e.target.value)}
          placeholder={`Example: I want to understand how customers feel about the ${productName || "TurboClean Pro 3000"} vacuum cleaner. I want to know if they find it easy to use, if the suction power is good enough, if the battery life meets their needs, and what design improvements they'd suggest. Ask them to show the product on camera if they mention any physical issues.`}
          className="min-h-[100px] bg-secondary/50 border-border"
        />
        <Button
          onClick={() => {
            setIsGenerating(true);
            setTimeout(() => {
              const product = productName || "the product";
              const generated: SurveySection[] = [
                {
                  id: genId(), title: "First Impressions & Unboxing", description: "Initial experience when receiving the product",
                  questions: [
                    { id: genId(), text: `How was your unboxing experience with the ${product}?`, type: "rating", required: true },
                    { id: genId(), text: "Was the product packaging easy to open?", type: "yes_no", required: true, followUp: "What specifically was difficult about the packaging?" },
                    { id: genId(), text: "How clear were the setup instructions?", type: "scale", required: true },
                  ],
                },
                {
                  id: genId(), title: "Ease of Use", description: "How intuitive and easy the product is to operate daily",
                  questions: [
                    { id: genId(), text: `How easy is it to operate the ${product} on a daily basis?`, type: "scale", required: true },
                    { id: genId(), text: "Which features do you use most frequently?", type: "open_ended", required: true },
                    { id: genId(), text: "Have you found any features confusing or hard to find?", type: "yes_no", required: true, followUp: "Can you show me which part you find confusing?" },
                    { id: genId(), text: "How easy is it to find the power button?", type: "scale", required: true },
                  ],
                },
                {
                  id: genId(), title: "Performance & Quality", description: "Product performance and build quality assessment",
                  questions: [
                    { id: genId(), text: `How would you rate the overall performance of the ${product}?`, type: "rating", required: true },
                    { id: genId(), text: "How would you rate the suction power?", type: "rating", required: true },
                    { id: genId(), text: "How long does the battery last on a single charge?", type: "multiple_choice", options: ["Less than 30 min", "30-60 min", "1-2 hours", "More than 2 hours"], required: true },
                    { id: genId(), text: "Have you experienced any breakage or defects?", type: "yes_no", required: true, followUp: "Can you show me the damage on camera?" },
                  ],
                },
                {
                  id: genId(), title: "Suggestions & Improvements", description: "Areas for improvement and feature requests",
                  questions: [
                    { id: genId(), text: "What is the #1 thing you would improve about this product?", type: "open_ended", required: true },
                    { id: genId(), text: "Would you recommend this product to a friend or family member?", type: "yes_no", required: true },
                    { id: genId(), text: "What features are missing that you wish it had?", type: "open_ended", required: false },
                    { id: genId(), text: `Overall, how satisfied are you with the ${product}?`, type: "rating", required: true },
                  ],
                },
              ];
              setSections(prev => [...prev, ...generated]);
              setExpandedSections(prev => {
                const next = new Set(prev);
                generated.forEach(s => next.add(s.id));
                return next;
              });
              setIsGenerating(false);
              toast.success("AI generated 4 sections with questions!", { description: "Review and customize them as needed." });
            }, 2000);
          }}
          disabled={isGenerating}
          className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm"
        >
          {isGenerating ? (
            <><span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent inline-block" /> Generating...</>
          ) : (
            <><Sparkles className="mr-2 h-4 w-4" /> Generate Questions with AI</>
          )}
        </Button>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border pt-6">
        <Button variant="outline" onClick={() => navigate("/surveys")} className="border-border text-muted-foreground">Cancel</Button>
        <div className="flex gap-3">
          <Button variant="outline" onClick={handleSave} className="border-border text-foreground">Save as Draft</Button>
          <Button onClick={handleSave} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
            Save & Activate
          </Button>
        </div>
      </div>
    </motion.div>
  );
};

export default SurveyBuilder;
