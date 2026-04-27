import { motion } from "framer-motion";
import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { demoSurveys, addSession } from "@/lib/demo-data";
import { GeminiLiveClient, AudioCapture } from "@/lib/gemini-live";
import { queryRAG } from "@/lib/rag-service";
import { summarizeSession } from "@/lib/summarize-session";
import { buildSurveyAgentPrompt } from "@/lib/agent-prompt";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, MessageSquare, Video, AlertTriangle, Settings, Loader2, ImageIcon, Expand, X } from "lucide-react";
import { toast } from "sonner";

interface ChatMessage {
  role: "ai" | "user" | "system";
  text: string;
  timestamp: Date;
}

const LiveSession = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const surveyId = searchParams.get("survey");
  const survey = demoSurveys.find(s => s.id === surveyId);

  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [capturedImages, setCapturedImages] = useState<string[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [currentDiagramCode, setCurrentDiagramCode] = useState<string>("");
  const [showDiagramPanel, setShowDiagramPanel] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const geminiRef = useRef<GeminiLiveClient | null>(null);
  const audioCaptureRef = useRef<AudioCapture | null>(null);
  const recognitionRef = useRef<any>(null);
  const connectedRef = useRef(connected);
  const diagramRef = useRef<HTMLDivElement>(null);

  // Keep connectedRef up to date
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // Heartbeat to keep connection alive during silence (Guitar only)
  useEffect(() => {
    let intervalId: any;
    const isGuitar = survey?.id?.startsWith("gui-");

    if (connected && isGuitar) {
      intervalId = setInterval(() => {
        if (geminiRef.current) {
          console.log("Sending heartbeat context update to Gemini Live...");
          geminiRef.current.sendContent([
            { text: "[User is continuing activity (e.g. playing guitar / practicing). Keep listening for audio.]" }
          ]);
        }
      }, 30000); // 30 seconds
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [connected, survey]);

  // Render Mermaid diagrams in persistent side-panel
  useEffect(() => {
    if (diagramRef.current && currentDiagramCode && showDiagramPanel) {
      const renderDiagram = async () => {
        try {
          if (diagramRef.current) diagramRef.current.innerHTML = '<div class="flex items-center justify-center h-full"><span class="animate-pulse text-muted-foreground">Rendering...</span></div>';
          
          const uniqueId = `mermaid-svg-${Date.now()}`;
          const { svg } = await mermaid.render(uniqueId, currentDiagramCode);
          if (diagramRef.current) {
            diagramRef.current.innerHTML = svg;
          }
        } catch (e) {
          console.error("Mermaid parse error:", e);
          if (diagramRef.current) {
            diagramRef.current.innerHTML = `<div class="p-4 text-destructive bg-destructive/10 rounded-lg text-sm">Diagram syntax error eller parsing failed...</div>`;
          }
        }
      };
      renderDiagram();
    }
  }, [currentDiagramCode, showDiagramPanel]);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Accumulator for model text chunks
  const modelTextRef = useRef<string>("");

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);


  const apiKey = localStorage.getItem("gemini_api_key") || "";

  const addMessage = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: new Date() }]);
  }, []);

  // Ensure video stream is attached to the video DOM element once it's rendered
  useEffect(() => {
    if (connected && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [connected, cameraOn]);

  // Periodically send video frames to Gemini so it can see the user
  useEffect(() => {
    if (!connected || !cameraOn || !videoRef.current || !geminiRef.current) return;
    
    const interval = setInterval(() => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return;
      
      const canvas = document.createElement("canvas");
      // Scale down to a max width of 640 to save bandwidth
      const scale = Math.min(640 / video.videoWidth, 1);
      canvas.width = video.videoWidth * scale;
      canvas.height = video.videoHeight * scale;
      
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6); // 60% quality jpeg
        const base64 = dataUrl.split(",")[1];
        if (base64) {
          geminiRef.current?.sendVideo(base64);
        }
      }
    }, 1000); // 1 frame per second
    
    return () => clearInterval(interval);
  }, [connected, cameraOn]);

  const startSession = async () => {
    if (!apiKey) {
      toast.error("Gemini API key is required", {
        description: "Go to Settings to add your Gemini API key.",
        action: { label: "Settings", onClick: () => navigate("/settings") },
      });
      return;
    }

    if (!survey) {
      toast.error("No survey selected");
      return;
    }

    setConnecting(true);
    setError(null);

    try {
      // Request camera and mic
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraOn,
        audio: true,
      });
      streamRef.current = stream;

      recordedChunksRef.current = [];
      try {
        let mrOptions = {};
        if (MediaRecorder.isTypeSupported('video/webm')) {
          mrOptions = { mimeType: 'video/webm' };
        }
        const mr = new MediaRecorder(stream, mrOptions);
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) recordedChunksRef.current.push(e.data);
        };
        mr.start(1000);
        mediaRecorderRef.current = mr;
      } catch (err) {
        console.warn("MediaRecorder failed:", err);
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Build system prompt from survey
      const systemPrompt = buildSurveyAgentPrompt(survey);

      // Reset accumulator
      modelTextRef.current = "";

      // Create Gemini client
      const client = new GeminiLiveClient(apiKey, systemPrompt, {
        onConnectionChange: (isConnected) => {
          setConnected(isConnected);
          setConnecting(false);
          if (isConnected) {
            setStartTime(Date.now());
            addMessage("system", "Connected to Gemini Live. Session started.");
            toast.success("Connected! The AI interviewer is ready.");

            // Trigger auto-greet (agent speaks first)
            const isInterview = survey?.id.startsWith("int-");
            const isKids = survey?.id.startsWith("kid-");
            let greeting = `Hello! Please tell me your thoughts about ${survey?.product || "the product"}.`;
            if (isInterview) {
              greeting = `Hello! I am ready to start your mock interview for the position related to ${survey?.product}. Let's begin!`;
            } else if (isKids) {
              greeting = `Hi there! I am your AI tutor. Let's play a fun game with ${survey?.product}!`;
            }

            setTimeout(() => {
              geminiRef.current?.sendText(greeting);
            }, 1500);

            // Start audio capture
            const capture = new AudioCapture((base64Pcm) => {
              geminiRef.current?.sendAudio(base64Pcm);
            });
            capture.start().catch(err => {
              console.error("Audio capture failed:", err);
            });
            audioCaptureRef.current = capture;

            // Start user transcription (Web Speech API)
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
            if (SpeechRecognition) {
              const recognition = new SpeechRecognition();
              recognition.continuous = true;
              recognition.interimResults = true;
              recognition.lang = "en-US";

              recognition.onresult = (event: any) => {
                let finalTranscript = "";
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                  if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                  }
                }
                if (finalTranscript) {
                  const trimmedText = finalTranscript.trim();
                  addMessage("user", trimmedText);
                  
                  // Query GCP RAG in background (Temporarily disabled to isolate loop bug)
                  /*
                  queryRAG(trimmedText).then((result) => {
                    if (result.snippets.length > 0) {
                      const context = result.snippets.join("\n");
                      geminiRef.current?.sendContent([
                        { text: `GCP RAG Documentation Context for user query '${trimmedText}':\n${context}\n\nPlease use this information to answer if applicable.` }
                      ]);
                      addMessage("system", "GCP RAG context injected into session.");
                    }
                  });
                  */
                }
              };

              recognition.onerror = (event: any) => {
                console.error("Speech recognition error:", event.error);
              };

              recognition.onend = () => {
                if (connectedRef.current) {
                  try { recognition.start(); } catch {}
                }
              };

              recognition.start();
              recognitionRef.current = recognition;
            }

            // MIX AUDIO FOR RECORDING
            try {
              const audioContext = new (window.AudioContext || window.webkitAudioContext)();
              const destination = audioContext.createMediaStreamDestination();

              // User's microphone
              const micSource = audioContext.createMediaStreamSource(stream);
              micSource.connect(destination);

              // Gemini's audio
              const geminiStream = client.getAudioStream();
              if (geminiStream) {
                const geminiSource = audioContext.createMediaStreamSource(geminiStream);
                geminiSource.connect(destination);
              } else {
                console.warn("Gemini audio stream not available");
              }

              // Combine video from user stream and mixed audio
              const mixedStream = new MediaStream([
                ...stream.getVideoTracks(),
                ...destination.stream.getAudioTracks()
              ]);

              // Update MediaRecorder to use the mixed stream
              if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
                mediaRecorderRef.current.stop(); // Stop the old one if it was running (should be none or inactive)
              }

              let mrOptions = {};
              if (MediaRecorder.isTypeSupported('video/webm')) {
                mrOptions = { mimeType: 'video/webm' };
              }
              const mr = new MediaRecorder(mixedStream, mrOptions);
              mr.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunksRef.current.push(e.data);
              };
              mr.start(1000);
              mediaRecorderRef.current = mr;
              console.log("MediaRecorder started with mixed audio.");
            } catch (err) {
              console.error("Failed to setup mixed audio recording:", err);
            }
          }
        },
        onModelTurn: (text) => {
          modelTextRef.current += text;
          // Update the last AI message or create a new one
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last?.role === "ai") {
              return prev.map((m, i) =>
                i === prev.length - 1 ? { ...m, text: modelTextRef.current } : m
              );
            }
            return [...prev, { role: "ai", text: modelTextRef.current, timestamp: new Date() }];
          });
        },
        onTranscript: (text, isFinal) => {
          if (isFinal) {
            addMessage("user", text);
          }
        },
        onAudioResponse: () => {
          // Audio playback is handled internally by GeminiLiveClient
        },
        onError: (errMsg) => {
          setError(errMsg);
          setConnecting(false);
          toast.error("Connection error", { description: errMsg });
        },
        onInterrupted: () => {
          // Reset accumulator on interruption
          modelTextRef.current = "";
        },
        onToolCall: (toolCall) => {
          if (toolCall.name === "take_picture") {
            const video = videoRef.current;
            if (video && video.videoWidth) {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
                setCapturedImages(prev => [...prev, dataUrl]);
                
                geminiRef.current?.sendToolResponse([{
                  id: toolCall.id,
                  name: "take_picture",
                  response: { success: true, message: "Picture taken successfully and saved to record." }
                }]);
                
                toast.success("AI took a picture", { description: "The image has been saved to the session record." });
              }
            } else if (toolCall.name === "draw_diagram") {
              const args = toolCall.args as { code: string };
              if (args.code) {
                setCurrentDiagramCode(args.code);
                setShowDiagramPanel(true);
                
                geminiRef.current?.sendToolResponse([{
                  id: toolCall.id,
                  name: "draw_diagram",
                  response: { success: true, message: "Diagram drawn successfully on screen." }
                }]);
                
                toast.success("AI drew a diagram", { description: "The architecture view has been updated." });
              }
            }
          }
        },
      });

      geminiRef.current = client;
      client.connect();
    } catch (err: any) {
      setConnecting(false);
      const msg = err.message || "Failed to access camera/microphone";
      setError(msg);
      toast.error("Permission denied", { description: msg });
    }
  };

  const endSession = async () => {
    audioCaptureRef.current?.stop();
    geminiRef.current?.disconnect();
    
    setConnected(false);
    setConnecting(true); // "Analyzing session..."
    addMessage("system", "Session ended. Analyzing results...");
    toast.info("Analyzing session insights...", { duration: 5000 });
    modelTextRef.current = "";

    const finishUp = async (videoBlob?: Blob) => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      let videoUrl = undefined;
      // We pass the raw recorded chunks into a single Blob
      if (videoBlob || recordedChunksRef.current.length > 0) {
        const finalBlob = videoBlob || new Blob(recordedChunksRef.current, { type: 'video/webm' });
        videoUrl = URL.createObjectURL(finalBlob);
      }

      // Format transcript
      const transcriptList = messages.filter(m => m.role !== "system").map(m => ({ 
        role: m.role as "ai" | "user", 
        text: m.text, 
        time: m.timestamp.toLocaleTimeString([], {minute: '2-digit', second:'2-digit'})
      }));
      
      let summaryData: any = {};
      if (survey && apiKey && transcriptList.length > 0) {
        const rawTranscript = transcriptList.map(m => `${m.role.toUpperCase()}: ${m.text}`).join("\n");
        // Using our new utility to get summary & Q&A mapping
        summaryData = await summarizeSession(apiKey, rawTranscript, survey);
      }

      if (survey && startTime) {
        const durationMs = Date.now() - startTime;
        const durationMin = Math.max(1, Math.round(durationMs / 60000));
        const sessionId = "ses-" + Math.random().toString(36).substring(2, 9);
        
        const sessionResult = {
          id: sessionId,
          surveyId: survey.id,
          customerName: "You (Live User)",
          customerAvatar: "U",
          date: new Date().toISOString().split('T')[0],
          duration: `${durationMin} min`,
          sentiment: summaryData?.sentiment || "positive" as any,
          satisfactionScore: summaryData?.satisfactionScore || 4.0,
          keyInsights: summaryData?.keyInsights?.length ? summaryData.keyInsights : ["User completed a real-time live interview"],
          topIssues: summaryData?.topIssues || [],
          pictures: capturedImages,
          transcript: transcriptList,
          videoUrl,
          summary: summaryData?.summary || "Live interactive session.",
          qaMapping: summaryData?.qaMapping || []
        };
        
        addSession(sessionResult);
        setConnecting(false);
        navigate(`/sessions/${sessionId}`);
      } else {
        setConnecting(false);
        navigate("/");
      }
    };

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = () => finishUp();
      mediaRecorderRef.current.stop();
    } else {
      finishUp();
    }
  };

  const captureAndSendSnapshot = () => {
    const video = videoRef.current;
    if (video && video.videoWidth) {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        setCapturedImages(prev => [...prev, dataUrl]);
        
        const base64 = dataUrl.split(",")[1];
        geminiRef.current?.sendContent([
          { text: "User captured this viewpoint from their camera. Please analyze it." },
          { inlineData: { mimeType: "image/jpeg", data: base64 } }
        ]);
        
        toast.success("Snapshot sent to AI");
      }
    }
  };

  const toggleCamera = () => {
    if (streamRef.current) {
      const videoTrack = streamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setCameraOn(videoTrack.enabled);
      }
    } else {
      setCameraOn(!cameraOn);
    }
  };

  const toggleMic = () => {
    if (streamRef.current) {
      const audioTrack = streamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setMicOn(audioTrack.enabled);
      }
    } else {
      setMicOn(!micOn);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      audioCaptureRef.current?.stop();
      geminiRef.current?.disconnect();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Video className="h-4 w-4 text-primary" />
          </div>
          <div>
            <p className="font-display font-semibold text-foreground text-sm">
              {survey?.name || "Live Session"}
            </p>
            <p className="text-xs text-muted-foreground">{survey?.product} · Gemini Live</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {connected && (
            <div className="flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-success animate-pulse" />
              <span className="text-xs text-success font-medium">Live</span>
            </div>
          )}
          {!apiKey && (
            <Button variant="outline" size="sm" onClick={() => navigate("/settings")} className="border-border text-muted-foreground">
              <Settings className="mr-1 h-3 w-3" /> Set API Key
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 flex gap-4 p-4 overflow-hidden">
        {/* Video area */}
        <div className="flex-1 flex flex-col gap-4">
          <Card className="flex-1 bg-secondary/30 border-border relative overflow-hidden flex items-center justify-center">
            {!connected && !connecting ? (
              <div className="text-center space-y-4 max-w-md">
                {!apiKey ? (
                  <>
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-warning/10">
                      <AlertTriangle className="h-7 w-7 text-warning" />
                    </div>
                    <div>
                      <h2 className="font-display text-xl font-semibold text-foreground">API Key Required</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        Add your Gemini API key in Settings to start a live AI interview session.
                      </p>
                    </div>
                    <Button onClick={() => navigate("/settings")} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
                      <Settings className="mr-2 h-4 w-4" /> Go to Settings
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-primary/10">
                      <Camera className="h-8 w-8 text-primary" />
                    </div>
                    <div>
                      <h2 className="font-display text-xl font-semibold text-foreground">Ready to start?</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        The AI will interview you about <strong className="text-foreground">{survey?.product}</strong> using Gemini Live.
                        It will ask questions from the survey, listen to your answers, and follow up naturally.
                      </p>
                      <p className="text-xs text-muted-foreground mt-2">
                        Your camera and microphone will be accessed.
                      </p>
                    </div>
                    <Button onClick={startSession} className="bg-primary text-primary-foreground hover:opacity-90 shadow-sm">
                      <Video className="mr-2 h-4 w-4" /> Start Live Interview
                    </Button>
                  </>
                )}
                {error && (
                  <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}
              </div>
            ) : connecting ? (
              <div className="text-center space-y-3">
                <Loader2 className="h-10 w-10 text-primary animate-spin mx-auto" />
                <p className="text-sm text-foreground font-medium">Processing...</p>
                <p className="text-xs text-muted-foreground">Communicating with Gemini...</p>
              </div>
            ) : (
              <>
                {/* Self-view video */}
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className={`absolute inset-0 w-full h-full object-cover ${!cameraOn ? "hidden" : ""}`}
                  style={{ transform: "scaleX(-1)" }}
                />
                {!cameraOn && (
                  <div className="text-center space-y-2">
                    <CameraOff className="h-10 w-10 text-muted-foreground mx-auto" />
                    <p className="text-sm text-muted-foreground">Camera off</p>
                  </div>
                )}
                {/* Recording indicator */}
                <div className="absolute top-4 left-4 flex items-center gap-2 bg-background/80 backdrop-blur-sm rounded-full px-3 py-1.5">
                  <span className="flex h-2 w-2 rounded-full bg-destructive animate-pulse" />
                  <span className="text-xs text-destructive font-medium">Recording</span>
                </div>
                {/* AI listening indicator */}
                {micOn && (
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-primary/20 backdrop-blur-sm rounded-full px-4 py-2">
                    <div className="flex gap-0.5 items-end h-4">
                      {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="w-1 bg-primary rounded-full animate-pulse" style={{
                          height: `${8 + Math.random() * 12}px`,
                          animationDelay: `${i * 0.1}s`
                        }} />
                      ))}
                    </div>
                    <span className="text-xs text-primary font-medium">AI is listening</span>
                  </div>
                )}
              </>
            )}
          </Card>

          {capturedImages.length > 0 && (
            <Card className="bg-gradient-card border-border p-3 shadow-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4 text-primary" />
                  <span className="font-display text-sm font-semibold text-foreground">Captured Snapshots</span>
                </div>
                <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary" style={{ cursor: "default" }}>
                  {capturedImages.length}
                </Badge>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2">
                {capturedImages.map((img, i) => (
                  <motion.div
                    key={i}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.2, delay: i * 0.05 }}
                    className="flex-shrink-0 relative group"
                  >
                    <img 
                      src={img} 
                      alt={`Captured ${i + 1}`} 
                      className="h-20 w-32 object-cover rounded-md border border-border shadow-sm hover:scale-105 transition-all cursor-pointer"
                      onClick={() => setSelectedImage(img)}
                    />
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none rounded-md">
                      <Expand className="h-5 w-5 text-white" />
                    </div>
                  </motion.div>
                ))}
              </div>
            </Card>
          )}

          {/* Controls */}
          {(connected || connecting) && (
            <div className="flex items-center justify-center gap-4">
              <Button
                variant="outline"
                size="icon"
                onClick={captureAndSendSnapshot}
                className="rounded-full h-12 w-12 border-border text-muted-foreground hover:bg-primary/10 hover:text-primary"
                title="Snapshot & Analyze"
              >
                <ImageIcon className="h-5 w-5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={toggleCamera}
                className={`rounded-full h-12 w-12 ${!cameraOn ? "bg-destructive/10 border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}
              >
                {cameraOn ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={toggleMic}
                className={`rounded-full h-12 w-12 ${!micOn ? "bg-destructive/10 border-destructive/30 text-destructive" : "border-border text-muted-foreground"}`}
              >
                {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
              </Button>
              <Button
                size="icon"
                onClick={endSession}
                className="rounded-full h-12 w-12 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                <PhoneOff className="h-5 w-5" />
              </Button>
            </div>
          )}
        </div>

        {/* Chat panel */}
        <Card className="w-96 bg-gradient-card border-border shadow-card flex flex-col">
          <div className="p-3 border-b border-border flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            <span className="font-display text-sm font-semibold text-foreground">Live Transcript</span>
            {connected && <span className="ml-auto text-[10px] text-success font-medium">● Connected</span>}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {messages.length === 0 && !connected && (
              <div className="text-center py-8">
                <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Conversation transcript will appear here</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                {msg.role === "system" ? (
                  <div className="w-full text-center">
                    <span className="text-[10px] text-muted-foreground bg-secondary/50 rounded-full px-3 py-1">
                      {msg.text}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                      msg.role === "ai" ? "bg-primary/10 text-primary" : "bg-secondary text-foreground"
                    }`}>
                      {msg.role === "ai" ? "AI" : "You"}
                    </div>
                    <div className={`rounded-lg px-3 py-2 text-xs max-w-[85%] ${
                      msg.role === "ai" ? "bg-secondary/70 text-foreground" : "bg-primary/10 text-foreground"
                    }`}>
                      {msg.text}
                    </div>
                  </>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* Survey info footer */}
          <div className="p-3 border-t border-border bg-secondary/30">
            <p className="text-[10px] text-muted-foreground">
              <strong className="text-foreground">Survey:</strong> {survey?.name}
            </p>
            <p className="text-[10px] text-muted-foreground">
              <strong className="text-foreground">Product:</strong> {survey?.product} · {survey?.sections.length} sections · {survey?.flowMode} flow
            </p>
          </div>
        </Card>

        {/* Diagram panel */}
        {showDiagramPanel && (
          <Card className="w-96 bg-gradient-card border-border shadow-card flex flex-col overflow-hidden">
            <div className="p-3 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-purple-400" />
                <span className="font-display text-sm font-semibold text-foreground">Technical Diagram</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setShowDiagramPanel(false)} className="h-6 w-6 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 flex items-center justify-center p-4 bg-secondary/30 rounded-b-lg overflow-auto">
              <div ref={diagramRef} className="w-full h-full flex items-center justify-center">
                {!currentDiagramCode && (
                  <div className="text-center text-xs text-muted-foreground">Generating diagram...</div>
                )}
              </div>
            </div>
          </Card>
        )}
      </div>
      {/* Photo View Dialog */}
      <Dialog open={!!selectedImage} onOpenChange={(open) => !open && setSelectedImage(null)}>
        <DialogContent className="max-w-4xl border-none bg-transparent p-0 shadow-none">
          <DialogHeader className="sr-only">
            <DialogTitle>View Image</DialogTitle>
          </DialogHeader>
          <div className="relative flex items-center justify-center h-[80vh] w-full" onClick={() => setSelectedImage(null)}>
            <img src={selectedImage || ""} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default LiveSession;
