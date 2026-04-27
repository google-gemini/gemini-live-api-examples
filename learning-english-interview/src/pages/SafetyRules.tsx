import { motion } from "framer-motion";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Shield, Plus, Trash2, Lock, Unlock } from "lucide-react";
import { defaultSafetyRules } from "@/lib/demo-data";
import { toast } from "sonner";

const SafetyRules = () => {
  const [rules, setRules] = useState(defaultSafetyRules);
  const [newRule, setNewRule] = useState("");

  const toggleRule = (id: string) => {
    setRules(rules.map(r => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const addRule = () => {
    if (!newRule.trim()) return;
    setRules([...rules, { id: `sr-${Date.now()}`, rule: newRule.trim(), enabled: true, isDefault: false }]);
    setNewRule("");
    toast.success("Safety rule added");
  };

  const removeRule = (id: string) => {
    setRules(rules.filter(r => r.id !== id));
    toast.success("Safety rule removed");
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-display text-3xl font-bold text-foreground">Safety Rules</h1>
        <p className="mt-1 text-muted-foreground">Configure guardrails for AI conversations with your customers</p>
      </div>

      {/* Info */}
      <Card className="border-primary/20 bg-primary/5 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Shield className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-foreground">AI Safety Guardrails</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              These rules define boundaries for the AI agent during live conversations. 
              Default rules provide baseline protection. You can add custom rules specific to your product or industry.
            </p>
          </div>
        </div>
      </Card>

      {/* Default Rules */}
      <div>
        <h2 className="font-display text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" /> Default Rules
        </h2>
        <Card className="bg-gradient-card border-border shadow-card divide-y divide-border">
          {rules.filter(r => r.isDefault).map(rule => (
            <div key={rule.id} className="flex items-center gap-4 p-4">
              <Switch checked={rule.enabled} onCheckedChange={() => toggleRule(rule.id)} />
              <span className={`flex-1 text-sm ${rule.enabled ? "text-foreground" : "text-muted-foreground line-through"}`}>
                {rule.rule}
              </span>
              <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">Default</span>
            </div>
          ))}
        </Card>
      </div>

      {/* Custom Rules */}
      <div>
        <h2 className="font-display text-lg font-semibold text-foreground mb-3 flex items-center gap-2">
          <Unlock className="h-4 w-4 text-muted-foreground" /> Custom Rules
        </h2>
        <Card className="bg-gradient-card border-border shadow-card divide-y divide-border">
          {rules.filter(r => !r.isDefault).map(rule => (
            <div key={rule.id} className="flex items-center gap-4 p-4">
              <Switch checked={rule.enabled} onCheckedChange={() => toggleRule(rule.id)} />
              <span className={`flex-1 text-sm ${rule.enabled ? "text-foreground" : "text-muted-foreground line-through"}`}>
                {rule.rule}
              </span>
              <button onClick={() => removeRule(rule.id)} className="p-1 text-muted-foreground hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {rules.filter(r => !r.isDefault).length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No custom rules yet</div>
          )}
        </Card>

        {/* Add Rule */}
        <div className="mt-4 flex gap-3">
          <Input
            value={newRule}
            onChange={e => setNewRule(e.target.value)}
            placeholder="e.g., Do not discuss competitor pricing strategies"
            className="bg-secondary border-border"
            onKeyDown={e => e.key === "Enter" && addRule()}
          />
          <Button onClick={addRule} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm shrink-0">
            <Plus className="mr-2 h-4 w-4" /> Add Rule
          </Button>
        </div>
      </div>

      {/* Save */}
      <div className="flex justify-end border-t border-border pt-6">
        <Button onClick={() => toast.success("Safety rules saved")} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
          Save Changes
        </Button>
      </div>
    </motion.div>
  );
};

export default SafetyRules;
