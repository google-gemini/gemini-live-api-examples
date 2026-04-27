import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/layout/AppLayout";
import Dashboard from "@/pages/Dashboard";
import SurveyList from "@/pages/SurveyList";
import SurveyDetail from "@/pages/SurveyDetail";
import SurveyBuilder from "@/pages/SurveyBuilder";
import SurveyEdit from "@/pages/SurveyEdit";
import SessionDetail from "@/pages/SessionDetail";
import LiveSession from "@/pages/LiveSession";
import ListenerSession from "@/pages/ListenerSession";
import Insights from "@/pages/Insights";
import SafetyRules from "@/pages/SafetyRules";
import Settings from "@/pages/Settings";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/surveys" element={<SurveyList />} />
            <Route path="/surveys/new" element={<SurveyBuilder />} />
            <Route path="/surveys/:id" element={<SurveyDetail />} />
            <Route path="/surveys/:id/edit" element={<SurveyEdit />} />
            <Route path="/sessions/:sessionId" element={<SessionDetail />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="/safety" element={<SafetyRules />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
          <Route path="/live" element={<LiveSession />} />
          <Route path="/listener" element={<ListenerSession />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
