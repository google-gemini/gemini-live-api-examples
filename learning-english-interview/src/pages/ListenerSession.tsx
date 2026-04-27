import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ArrowLeft, Play, Square, Settings, Video, CheckCircle, AlertTriangle, MessageSquare, BarChart3 } from 'lucide-react'; // Wait, Lucide check icons
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { GeminiLiveClient } from '@/lib/gemini-live';
import { demoSurveys } from '@/lib/demo-data';
import { buildSurveyAgentPrompt } from '@/lib/agent-prompt';
import { AudioCapture } from '@/lib/gemini-live';
import mermaid from 'mermaid';

function MermaidDiagram({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (containerRef.current && code) {
      const render = async () => {
        try {
          const uniqueId = `mermaid-svg-${Math.random().toString(36).substr(2, 9)}`;
          const { svg } = await mermaid.render(uniqueId, code);
          if (containerRef.current) {
            containerRef.current.innerHTML = svg;
          }
        } catch (e) {
          console.error("Mermaid error:", e);
          setError(true);
        }
      };
      render();
    }
  }, [code]);

  return (
    <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700/50 relative min-h-[200px] flex items-center justify-center">
      <div ref={containerRef} className="w-full flex items-center justify-center" />
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-destructive/20 text-destructive text-xs p-4 rounded-lg overflow-hidden">
          <span className="font-semibold mb-2">Syntax Error in Diagram</span>
          <pre className="text-white bg-slate-900/90 p-3 rounded-md max-h-48 overflow-auto w-full text-left font-mono whitespace-pre-wrap text-[10px] border border-slate-700">
            {code}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function ListenerSession() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const apiKey = localStorage.getItem("gemini_api_key");
  
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [mermaidCodes, setMermaidCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const geminiRef = useRef<GeminiLiveClient | null>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const accumulatedTextRef = useRef<string>("");
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const visibleVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [selectedDiagram, setSelectedDiagram] = useState<string | null>(null);
  const [centerWidth, setCenterWidth] = useState<number>(30); // in percentage

  const surveyId = id || "lis-001";
  const survey = demoSurveys.find(s => s.id === surveyId);

  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
  }, []);


  const startSession = async () => {
    if (!apiKey) {
      toast.error("API Key Missing", { description: "Please add your Gemini API key in Settings." });
      return;
    }

    setConnecting(true);
    setError(null);
    setSuggestions([]);
    setMermaidCodes([]);

    try {
      const systemPrompt = buildSurveyAgentPrompt(survey);
      
      const client = new GeminiLiveClient(apiKey, systemPrompt, {
        onConnectionChange: (isConnected) => {
          setConnected(isConnected);
          setConnecting(false);
          if (isConnected) {
            toast.success("Listener active. Logging meeting context.");
          }
        },
        onModelTurn: (text) => {
          accumulatedTextRef.current += text;
          
          const foundCodes: string[] = [];
          const matches = accumulatedTextRef.current.matchAll(/```mermaid([\s\S]*?)```/gi);
          for (const match of matches) {
            foundCodes.push(match[1].trim());
          }
          
          if (foundCodes.length > 0) {
            setMermaidCodes(prev => {
              const next = [...prev];
              for (const code of foundCodes) {
                if (!next.includes(code)) {
                  next.push(code);
                }
              }
              return next;
            });
          }

          // Clean text might be tricky if we remove mermaid blocks that cross chunks
          // But for now we just remove complete ones that fit in this chunk, 
          // or we just let it be. Letting it be is safer for text stream.
          const cleanText = text.replace(/```mermaid[\s\S]*?```/gi, "").trim();
          if (cleanText) {
            setSuggestions(prev => [...prev, cleanText].slice(-10));
          }
        },
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            console.log("Captured transcript from Live API:", text);
            accumulatedTextRef.current += "\n[מפגש]: " + text;
          }
        },
        onAudioResponse: () => {},
        onError: (errMsg) => {
          setError(errMsg);
          setConnecting(false);
          toast.error("Connection error", { description: errMsg });
        },
        onInterrupted: () => {},
      }, true); // Silent mode

      geminiRef.current = client;
      client.connect();

      const capture = new AudioCapture((base64Pcm) => {
        client.sendAudio(base64Pcm);
      });
      capture.start();
      audioCaptureRef.current = capture;

    } catch (err: any) {
      setError(err.message || "Failed to start session");
      setConnecting(false);
      toast.error("Initialization error", { description: err.message });
    }
  };

  const handleQuickPrompt = async (promptText: string) => {
    if (!apiKey) {
      toast.error("API Key Missing", { description: "Please add your Gemini API key in Settings." });
      return;
    }
    
    if (promptText.includes("דיאגרמה") || promptText.includes("סיכום")) {
      toast.info("Generating heavy-model response...", { description: "Running standard HTTP request for graphics." });
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const contextText = accumulatedTextRef.current || "No meeting audio captured yet.";
      
      const payload = {
        contents: [{
          role: "user",
          parts: [{ text: `
Meeting Context:
${contextText}

User Request:
${promptText}

Output a response. If the request calls for a diagram, you MUST output a \`\`\`mermaid code block. DO NOT use standard text descriptions. JUST DRAW IT.
Rule: If you use Hebrew text inside a node, YOU MUST wrap it in double quotes! Example: A(["טקסט בעברית"])
` }]
        }]
      };

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error("HTTP error " + response.statusText);
        
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (text) {
          const matches = text.matchAll(/```mermaid([\s\S]*?)```/gi);
          const foundCodes: string[] = [];
          for (const match of matches) {
            foundCodes.push(match[1].trim());
          }
          
          if (foundCodes.length > 0) {
            setMermaidCodes(prev => {
              const next = [...prev];
              for (const code of foundCodes) {
                if (!next.includes(code)) next.push(code);
              }
              return next;
            });
            toast.success("New diagram generated!", { description: "Added to the Technical Architecture panel." });
          } else {
            // If it's a summary or no diagram found, put it in suggestions
            setSuggestions(prev => [...prev, text].slice(-10));
          }
        }
      } catch (err: any) {
        console.error("HTTP Diagram generation error:", err);
        toast.error("Generation failed", { description: err.message });
      }
      return;
    }

    if (!geminiRef.current || !connected) {
      toast.error("Not connected", { description: "Start the assistant first." });
      return;
    }
    toast.info("Sending request to Live WebSocket...", { description: promptText });
    geminiRef.current.sendText(promptText);
  };

  const stopSession = () => {
    audioCaptureRef.current?.stop();
    geminiRef.current?.disconnect();
    setConnected(false);
    setConnecting(false);
    toast.info("Session stopped.");
  };

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenStreamRef.current = stream;
      setIsScreenSharing(true);
      toast.success("Screen sharing active", { description: "Sending frames to Gemini for emotion analysis." });

      // Set up interval to take snapshots and send to Gemini (every 3 seconds to stay within limits)

      // Set up interval to take snapshots and send to Gemini (every 3 seconds to stay within limits)
      const intervalId = setInterval(() => {
        if (!screenVideoRef.current || !geminiRef.current) return;
        
        const video = screenVideoRef.current;
        if (video.videoWidth && video.videoHeight) {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            // Convert to JPEG base64 (remove data:image/jpeg;base64, prefix)
            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            const base64 = dataUrl.split(",")[1];
            
            console.log("Sending screen frame to Gemini...");
            geminiRef.current.sendVideo(base64);
          }
        }
      }, 3000);

      // Clean up on stream end event
      stream.getVideoTracks()[0].onended = () => {
        clearInterval(intervalId);
        setIsScreenSharing(false);
        screenStreamRef.current = null;
        if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
        toast.info("Screen sharing ended.");
      };

      // Attaching interval cleanup to stream so we can clear it when we stop manually
      (stream as any)._frameInterval = intervalId;

    } catch (err: any) {
      console.error("Screen share error:", err);
      toast.error("Failed to share screen", { description: err.message });
    }
  };

  const stopScreenShare = () => {
    if (screenStreamRef.current) {
      const stream = screenStreamRef.current;
      clearInterval((stream as any)._frameInterval);
      stream.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
      setIsScreenSharing(false);
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    if (isScreenSharing && screenStreamRef.current && visibleVideoRef.current) {
      console.log("Binding screen stream to visible video element...");
      visibleVideoRef.current.srcObject = screenStreamRef.current;
      visibleVideoRef.current.play();
      screenVideoRef.current = visibleVideoRef.current;
    }
  }, [isScreenSharing]);

  useEffect(() => {
    return () => {
      stopScreenShare();
      audioCaptureRef.current?.stop();
      geminiRef.current?.disconnect();
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-screen flex flex-col bg-slate-900 text-slate-100">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} className="text-slate-400 hover:text-slate-100">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-display font-bold text-lg text-white">CE Real-Time Assistant (Listener)</h1>
            <p className="text-xs text-slate-400">Silent observer · Technical guidelines · Diagrams</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-800/50 p-1.5 rounded-lg border border-slate-700">
            <span className="text-xs text-slate-400">Layout:</span>
            <input 
              type="range" 
              min="20" 
              max="60" 
              value={centerWidth} 
              onChange={(e) => setCenterWidth(Number(e.target.value))} 
              className="w-24 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>
          {connected && (
            <Button onClick={isScreenSharing ? stopScreenShare : startScreenShare} variant="outline" size="sm" className="text-white border-slate-700 bg-slate-800/50 hover:bg-slate-700">
              <Square className={`mr-2 h-4 w-4 ${isScreenSharing ? "text-red-500 fill-red-500" : ""}`} /> 
              {isScreenSharing ? "Stop Sharing" : "Share Meeting Screen"}
            </Button>
          )}
          {connected ? (
            <Button onClick={stopSession} variant="destructive" size="sm" className="shadow-lg shadow-destructive/20">
              <Square className="mr-2 h-4 w-4" /> Stop Assistant
            </Button>
          ) : (
            <Button onClick={startSession} disabled={connecting} size="sm" className="bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-700 hover:to-cyan-600 shadow-lg shadow-blue-500/20 text-white font-medium">
              {connecting ? (
                <>
                  <span className="flex h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin mr-2" />
                  Connecting...
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" /> Start Assistant
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 flex gap-6 p-6 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-900 to-blue-900/20">
        <div className="w-1/5 flex flex-col gap-6">
          {/* Always mounted screen share view (or microphone card if not sharing) */}
          <Card className={`p-4 bg-slate-800/40 border-slate-700/50 backdrop-blur-md shadow-xl flex flex-col h-56 overflow-hidden relative group`}>
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-cyan-500/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            
            {!isScreenSharing ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className={`p-4 rounded-full mb-4 ${connected ? 'bg-success/20 text-success' : 'bg-slate-700 text-slate-400'} group-hover:scale-110 transition-transform duration-300`}>
                  <Video className="h-8 w-8" />
                </div>
                <h3 className="font-semibold text-white mb-1">Live Meeting Audio</h3>
                {connected ? (
                  <div className="flex items-center gap-2 text-success text-sm font-medium">
                    <span className="flex h-2 w-2 rounded-full bg-success animate-pulse" />
                    Listening Active
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">Not connected to meeting</p>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col h-full">
                <span className="text-xs font-medium text-white mb-2">מסך משותף (Meeting View)</span>
                <div className="flex-1 bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center relative">
                  <video ref={visibleVideoRef} autoPlay muted className="w-full h-full object-cover" />
                </div>
              </div>
            )}
          </Card>

          <Card className="p-6 bg-slate-800/40 border-slate-700/50 backdrop-blur-md shadow-xl flex-1 flex flex-col">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="h-5 w-5 text-blue-400" />
              <h3 className="font-semibold text-white">Guidelines</h3>
            </div>
            <div className="flex-1 text-xs text-slate-400 space-y-3 overflow-y-auto">
              <p>• האסיסטנט מקשיב בשקט לפגישה.</p>
              <p>• מתמקד ב-Google Cloud (BigQuery, GKE, Anthos).</p>
              <p>• <b>כלל ברזל:</b> אם מדובר ארכיטקטורה, <b>חובה</b> להוציא קוד ```mermaid. אל תכתוב תיאור טקסטואלי, פשוט צייר.</p>
              <p>• הצעות ותשובות בחלונית המרכזית.</p>
            </div>
          </Card>
        </div>

        <div style={{ width: `${centerWidth}%` }} className="flex flex-col gap-6 transition-all duration-200">
          <Card className="flex-1 p-6 bg-slate-800/40 border-slate-700/50 backdrop-blur-md shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="h-5 w-5 text-cyan-400" />
              <h3 className="font-semibold text-white">Real-Time Suggestions</h3>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
              <AnimatePresence>
                {suggestions.map((msg, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="p-3 bg-slate-700/30 border border-slate-600/50 rounded-lg text-sm text-slate-200"
                  >
                    {msg}
                  </motion.div>
                ))}
              </AnimatePresence>
              {suggestions.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 text-sm">
                  <MessageSquare className="h-12 w-12 mb-2 opacity-30" />
                  No suggestions yet. Waiting for meeting audio...
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="flex-1 flex flex-col gap-6">
          <Card className="flex-1 p-6 bg-slate-800/40 border-slate-700/50 backdrop-blur-md shadow-xl flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 mb-4">
              <BarChart3 className="h-5 w-5 text-purple-400" />
              <h3 className="font-semibold text-white">Technical Architecture</h3>
            </div>
            <div className="flex-1 flex flex-col overflow-auto p-4 bg-slate-900/50 rounded-lg border border-slate-700 relative space-y-6">
              {mermaidCodes.map((code, index) => (
                <div key={index} onClick={() => setSelectedDiagram(code)} className="cursor-pointer hover:ring-2 hover:ring-blue-500 rounded-lg transition-all duration-200">
                  <MermaidDiagram code={code} />
                </div>
              ))}
              {mermaidCodes.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-slate-500 text-sm">
                  <BarChart3 className="h-12 w-12 mb-2 opacity-30" />
                  No diagram generated yet.
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {/* Quick Actions Footer */}
      <div className="p-4 border-t border-slate-800 bg-slate-900/50 flex flex-col gap-3 sticky bottom-0 z-50">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 rtl">
          <span className="text-xs text-slate-400 font-medium whitespace-nowrap">פעולות מהירות:</span>
          <Button onClick={() => handleQuickPrompt("תיצור דיאגרמה על בסיס מה שנאמר בפגישה. תשתמש בבלוק קוד ```mermaid")} variant="outline" size="sm" className="text-xs text-slate-300 border-slate-700 hover:bg-slate-800 whitespace-nowrap">
            📊 צור דיאגרמה מהשיחה
          </Button>
          <Button onClick={() => handleQuickPrompt("תסכם את הפגישה עד עכשיו")} variant="outline" size="sm" className="text-xs text-slate-300 border-slate-700 hover:bg-slate-800 whitespace-nowrap">
            📝 סכם פגישה
          </Button>
          <Button onClick={() => handleQuickPrompt("תן לי שאלות המשך לשאול בפגישה")} variant="outline" size="sm" className="text-xs text-slate-300 border-slate-700 hover:bg-slate-800 whitespace-nowrap">
            ❓ שאלות המשך
          </Button>
          <Button onClick={() => handleQuickPrompt("איך נראים הרגשות של המשתמשים בפגישה")} variant="outline" size="sm" className="text-xs text-slate-300 border-slate-700 hover:bg-slate-800 whitespace-nowrap">
            🧠 ניתוח רגשות
          </Button>
        </div>
        <div className="flex items-center gap-3 rtl">
          <input 
            type="text" 
            placeholder="שלח הודעה שקטה לאסיסטנט (למשל: תסביר את המושג האחרון שנאמר)..." 
            className="flex-1 bg-slate-800/50 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleQuickPrompt((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
          <Button onClick={() => {
            const input = document.querySelector('input[placeholder^="שלח הודעה שקטה"]') as HTMLInputElement;
            if (input && input.value) {
              handleQuickPrompt(input.value);
              input.value = '';
            }
          }} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">
            שְׁלַח
          </Button>
        </div>
      </div>

      {/* Enlarged Diagram Modal */}
      {selectedDiagram && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-6">
          <Card className="w-[90vw] h-[90vh] bg-slate-900 border-slate-700 flex flex-col p-6 max-w-7xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Zoomed Drawing</h3>
              <Button variant="ghost" size="icon" onClick={() => setSelectedDiagram(null)} className="text-slate-400 hover:text-slate-100">
                <Square className="h-5 w-5" />
              </Button>
            </div>
            <div className="flex-1 overflow-auto bg-slate-950 rounded-lg p-6 flex items-center justify-center">
              <MermaidDiagram code={selectedDiagram} />
            </div>
          </Card>
        </div>
      )}
    </motion.div>
  );
}
