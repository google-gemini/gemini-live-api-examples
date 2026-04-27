import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, ClipboardList, BarChart3, Settings, Shield, Plus, MessageSquare, Briefcase, Smile } from "lucide-react";
import { cn } from "@/lib/utils";
import { useProductMode, ProductMode } from "@/hooks/use-product-mode";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/surveys", icon: ClipboardList, label: "Surveys" },
  { to: "/insights", icon: BarChart3, label: "Insights" },
  { to: "/safety", icon: Shield, label: "Safety Rules" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

const AppSidebar = () => {
  const location = useLocation();
  const [mode, setMode] = useProductMode();

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-border bg-sidebar">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2.5 border-b border-border px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
          <MessageSquare className="h-4 w-4 text-primary" />
        </div>
        <div>
          <span className="font-display text-lg font-bold text-foreground">GoogLive</span>
          <span className="text-xs font-medium text-muted-foreground">.ai</span>
        </div>
      </div>

      {/* App Switcher */}
      <div className="px-4 py-3 border-b border-border">
        <Select value={mode} onValueChange={(v) => setMode(v as ProductMode)}>
          <SelectTrigger className="w-full bg-background/50 border-input">
            <SelectValue placeholder="Select Product" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="surveys">
              <div className="flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-primary" />
                <span>Surveys</span>
              </div>
            </SelectItem>
            <SelectItem value="interviews">
              <div className="flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-success" />
                <span>Interviews</span>
              </div>
            </SelectItem>
            <SelectItem value="kids">
              <div className="flex items-center gap-2">
                <Smile className="h-4 w-4 text-warning" />
                <span>Kids Learning</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map(({ to, icon: Icon, label }) => {
          const isActive = to === "/" ? location.pathname === "/" : location.pathname.startsWith(to);
          return (
            <NavLink
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          );
        })}
      </nav>

      {/* Create CTA */}
      <div className="border-t border-border p-4">
        <NavLink
          to={mode === "surveys" ? "/surveys/new" : "/live"}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90 shadow-sm"
        >
          <Plus className="h-4 w-4" />
          {mode === "surveys" ? "New Survey" : mode === "interviews" ? "Start Interview" : "Start Lesson"}
        </NavLink>
      </div>
    </aside>
  );
};

export default AppSidebar;
