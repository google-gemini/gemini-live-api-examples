import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Building2, Mail, Video, Sparkles, Key } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

const Settings = () => {
  const [geminiKey, setGeminiKey] = useState(localStorage.getItem("gemini_api_key") || "");
  const [showKey, setShowKey] = useState(false);
  const [agentName, setAgentName] = useState(localStorage.getItem("gemini_agent_name") || "GoogLive");
  const [agentVoice, setAgentVoice] = useState(localStorage.getItem("gemini_agent_voice") || "female");

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-display text-3xl font-bold text-foreground">Settings</h1>
        <p className="mt-1 text-muted-foreground">Configure your organization and survey defaults</p>
      </div>

      {/* Organization */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Building2 className="h-4 w-4 text-primary" /></div>
          <h2 className="font-display text-lg font-semibold text-foreground">Organization</h2>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Company Name</Label>
            <Input defaultValue="CleanTech Industries" className="bg-secondary border-border" />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">Industry</Label>
            <Input defaultValue="Consumer Electronics" className="bg-secondary border-border" />
          </div>
        </div>
      </Card>

      {/* Gemini API Key */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Key className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Gemini API Key</h2>
            <p className="text-xs text-muted-foreground">Required to power live AI conversations via Gemini Live</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">API Key</Label>
          <div className="flex gap-3">
            <Input
              type={showKey ? "text" : "password"}
              value={geminiKey}
              onChange={e => setGeminiKey(e.target.value)}
              placeholder="AIza..."
              className="bg-secondary border-border font-mono text-sm"
            />
            <Button variant="outline" onClick={() => setShowKey(!showKey)} className="border-border text-muted-foreground shrink-0">
              {showKey ? "Hide" : "Show"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Get your API key from{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              Google AI Studio
            </a>
          </p>
        </div>
      </Card>

      {/* Email Template */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10"><Mail className="h-4 w-4 text-primary" /></div>
          <h2 className="font-display text-lg font-semibold text-foreground">Invitation Email Template</h2>
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">Subject Line</Label>
          <Input defaultValue="We'd love your feedback on {{product_name}}" className="bg-secondary border-border" />
        </div>
        <div className="space-y-2">
          <Label className="text-muted-foreground">Email Body</Label>
          <Textarea
            defaultValue={`Hi {{customer_name}},\n\nThank you for purchasing the {{product_name}}. We'd love to hear about your experience in a quick conversation with our AI assistant.\n\nClick below to start your personalized feedback session:\n{{survey_link}}\n\nBest regards,\n{{company_name}} Team`}
            className="min-h-[160px] bg-secondary border-border"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Available variables: {"{{customer_name}}"}, {"{{product_name}}"}, {"{{survey_link}}"}, {"{{company_name}}"}
        </p>
      </Card>

      {/* AI Settings */}
      <Card className="bg-gradient-card border-border p-6 shadow-card space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <h2 className="font-display text-lg font-semibold text-foreground">AI Agent Settings</h2>
        </div>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 border-b border-border pb-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Agent Name</Label>
              <Input value={agentName} onChange={e => setAgentName(e.target.value)} className="bg-secondary border-border" />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Agent Voice</Label>
              <select 
                value={agentVoice} 
                onChange={e => setAgentVoice(e.target.value)}
                className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                <option value="female">Female (Aoede)</option>
                <option value="male">Male (Puck)</option>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Enable Camera Analysis</p>
              <p className="text-xs text-muted-foreground">AI will analyze visual cues from customer's camera</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Sentiment Detection</p>
              <p className="text-xs text-muted-foreground">Detect customer emotions during conversation</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Auto Follow-up Questions</p>
              <p className="text-xs text-muted-foreground">AI generates follow-up questions based on responses</p>
            </div>
            <Switch defaultChecked />
          </div>
          <div className="space-y-2">
            <Label className="text-muted-foreground">Max Session Duration (minutes)</Label>
            <Input type="number" defaultValue="20" className="bg-secondary border-border w-32" />
          </div>
        </div>
      </Card>

      <div className="flex justify-end border-t border-border pt-6">
        <Button onClick={() => { 
          localStorage.setItem("gemini_api_key", geminiKey); 
          localStorage.setItem("gemini_agent_name", agentName);
          localStorage.setItem("gemini_agent_voice", agentVoice);
          toast.success("Settings saved"); 
        }} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
          Save Settings
        </Button>
      </div>
    </motion.div>
  );
};

export default Settings;
