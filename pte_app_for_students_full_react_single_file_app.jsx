import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Mic, Play, Square, Repeat, Sun, Moon, Trash2, Download } from "lucide-react";
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Radar as RechartsRadar } from "recharts";
import WaveSurfer from "wavesurfer.js";

// ---------------------------------------------
// Utility helpers
// ---------------------------------------------
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const uid = () => Math.random().toString(36).slice(2);
const tokenize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function approxPhonetic(word) {
  return word
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/ght/g, "t")
    .replace(/kn/g, "n")
    .replace(/wr/g, "r")
    .replace(/wh/g, "w")
    .replace(/tion\b/g, "shun")
    .replace(/sion\b/g, "zhun")
    .replace(/qu/g, "kw")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/x/g, "ks")
    .replace(/[^a-z]/g, "");
}

function analyzeAlignment(refText, hypText) {
  const ref = tokenize(refText);
  const hyp = tokenize(hypText);
  let matched = 0, missed = 0, extra = 0, approx = 0;
  const details = [];
  const used = new Set();

  ref.forEach((w, i) => {
    if (hyp[i] === w) {
      matched++; used.add(i); details.push({ word: w, status: "correct" });
    } else {
      details.push({ word: w, status: "pending" });
    }
  });

  details.forEach((d, i) => {
    if (d.status !== "pending") return;
    const idx = hyp.findIndex((h, j) => !used.has(j) && h === d.word);
    if (idx !== -1) { matched++; used.add(idx); d.status = "correct"; return; }
    const key = approxPhonetic(d.word);
    const idx2 = hyp.findIndex((h, j) => !used.has(j) && approxPhonetic(h) === key);
    if (idx2 !== -1) { approx++; used.add(idx2); d.status = "approx"; return; }
    const idx3 = hyp.findIndex((h, j) => !used.has(j) && levenshtein(h, d.word) === 1);
    if (idx3 !== -1) { approx++; used.add(idx3); d.status = "approx"; return; }
    missed++; d.status = "missed";
  });

  hyp.forEach((h, j) => { if (!used.has(j)) extra++; });

  const contentAcc = ref.length ? Math.round((matched / ref.length) * 100) : 0;
  return { matched, missed, extra, approx, contentAcc, details, ref, hyp };
}

function estimateFluency(hypText, durationSec) {
  const words = tokenize(hypText).length;
  const wpm = durationSec > 0 ? (words / durationSec) * 60 : 0;
  let score = 0;
  if (wpm <= 60) score = 50;
  else if (wpm <= 80) score = 65;
  else if (wpm <= 95) score = 78;
  else if (wpm <= 125) score = 90;
  else if (wpm <= 150) score = 80;
  else score = 65;
  return { wpm: Math.round(wpm), fluencyScore: score };
}

function estimatePronunciation(alignment) {
  const { matched, approx, ref } = alignment;
  const base = ref.length ? (matched + 0.6 * approx) / ref.length : 0;
  let score = Math.round(base * 95);
  const hard = ["th", "r", "l", "v", "w", "tion", "sion", "ed ", "tch"];
  const refText = alignment.ref.join(" ");
  const hardHits = hard.reduce((acc, h) => acc + (refText.includes(h) ? 1 : 0), 0);
  score -= Math.min(10, hardHits * 1.5);
  return clamp(score, 20, 95);
}

function scoreOverall(content, pron, flu) {
  return Math.round(content * 0.5 + pron * 0.25 + flu * 0.25);
}

// Speech utilities
const getRecognizer = () => {
  if (typeof window === 'undefined') return null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  try {
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  } catch (e) {
    console.warn('getRecognizer failed', e);
    return null;
  }
};

// Utility: safely stop recorder and stream without throwing
function safeStopMedia({ mediaRef, streamRef, setStatus, isMountedRef }) {
  try {
    if (mediaRef && mediaRef.current) {
      const state = mediaRef.current.state;
      if (state && state !== 'inactive') {
        try { mediaRef.current.stop(); } catch (err) { console.warn('Error stopping MediaRecorder:', err); }
      }
      try { mediaRef.current = null; } catch(e){}
    }
  } catch (err) {
    console.warn('safeStopMedia mediaRef error', err);
  }

  try {
    if (streamRef && streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
      } catch (err) { console.warn('Error stopping tracks', err); }
      try { streamRef.current = null; } catch(e){}
    }
  } catch (err) {
    console.warn('safeStopMedia streamRef error', err);
  }

  // call setStatus only if it's a function and component is still mounted
  try {
    if (typeof setStatus === 'function' && (!isMountedRef || isMountedRef.current)) {
      setStatus('Stopped.');
    }
  } catch (err) { console.warn('safeStopMedia setStatus error', err); }
}

// WaveSurfer init
function useWaveSurfer(containerRef, audioUrl) {
  const wsRef = useRef(null);
  useEffect(() => {
    if (!containerRef || !containerRef.current) return;
    if (wsRef.current) { try { wsRef.current.destroy(); } catch(e){} wsRef.current = null; }
    if (!audioUrl) return;
    let ws;
    try {
      ws = WaveSurfer.create({
        container: containerRef.current,
        height: 64,
        cursorWidth: 1,
        barWidth: 2,
        normalize: true,
        responsive: true,
      });
      ws.load(audioUrl);
      wsRef.current = ws;
    } catch (e) {
      console.warn('WaveSurfer init failed', e);
    }
    return () => { try { if (wsRef.current) wsRef.current.destroy(); } catch (e) {} };
  }, [containerRef, audioUrl]);
  return wsRef;
}

// ---------------------------------------------
// Main App
// ---------------------------------------------
export default function PTEApp() {
  const [dark, setDark] = useState(false);
  useEffect(() => { if (typeof document !== 'undefined') document.documentElement.classList.toggle("dark", dark); }, [dark]);

  return (
    <div className={`min-h-screen ${dark ? "bg-neutral-900 text-neutral-100" : "bg-neutral-50 text-neutral-900"}`}>
      <header className="max-w-6xl mx-auto px-4 py-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">PTE App for Students</h1>
          <p className="text-sm md:text-base opacity-80">Read Aloud • Listen & Repeat • Listening Comprehension • Progress Tracking</p>
        </div>
        <div className="flex items-center gap-3">
          <Label className="flex items-center gap-2 text-sm"><Sun size={16}/> Light</Label>
          <Switch checked={dark} onCheckedChange={setDark} />
          <Label className="flex items-center gap-2 text-sm"><Moon size={16}/> Dark</Label>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        <Tabs defaultValue="readaloud" className="w-full">
          <TabsList className="grid grid-cols-3 md:grid-cols-4 gap-2">
            <TabsTrigger value="readaloud">Read Aloud</TabsTrigger>
            <TabsTrigger value="listenrepeat">Listen & Repeat</TabsTrigger>
            <TabsTrigger value="listening">Listening</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="readaloud"><ReadAloudCard/></TabsContent>
          <TabsContent value="listenrepeat"><ListenRepeatCard/></TabsContent>
          <TabsContent value="listening"><ListeningCard/></TabsContent>
          <TabsContent value="history"><HistoryCard/></TabsContent>
        </Tabs>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-10 text-center opacity-70 text-sm">
        Built for practice & learning. Runs fully in your browser. No audio leaves your device.
      </footer>
    </div>
  );
}

// ---------------------------------------------
// Read Aloud
// ---------------------------------------------
function ReadAloudCard() {
  const [text, setText] = useState(samplePassage);
  const [recognizing, setRecognizing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [prepSec, setPrepSec] = useState(40);
  const [recSec, setRecSec] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [hypText, setHypText] = useState("");
  const [scores, setScores] = useState(null);
  const [status, setStatus] = useState("Paste or edit the passage, then Prepare ➜ Record.");

  const mediaRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const recTimerRef = useRef(null);
  const recStartRef = useRef(0);
  const autoStopRef = useRef(null);
  const wsContainer = useRef(null);
  const isMountedRef = useRef(true);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  useWaveSurfer(wsContainer, audioUrl);

  const recognizerRef = useRef(null);
  useEffect(() => { recognizerRef.current = getRecognizer(); }, []);

  function startPrep() {
    clearInterval(timerRef.current);
    setPrepSec(40);
    setStatus("Preparation started. Recording will auto-start when time ends.");
    timerRef.current = setInterval(() => {
      setPrepSec((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current);
          startRecording();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function startRecording() {
    try {
      clearInterval(timerRef.current);
      setPrepSec(0);

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported in this browser');
      }

      // request microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!stream) throw new Error('No audio stream');
      streamRef.current = stream;

      // create recorder
      const mr = new MediaRecorder(stream);
      mediaRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => chunksRef.current.push(e.data);

      mr.onstop = () => {
        try {
          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          const url = URL.createObjectURL(blob);
          try { if (audioUrl) URL.revokeObjectURL(audioUrl); } catch(e){}
          if (isMountedRef.current) setAudioUrl(url);
        } catch (err) { console.warn('onstop error', err); }
        try { if (streamRef.current) { streamRef.current.getTracks().forEach(t => { try{ t.stop(); }catch(e){} }); streamRef.current = null; } } catch(e){}
      };

      mr.start();
      if (isMountedRef.current) setRecording(true);
      if (isMountedRef.current) setStatus("Recording... Speak clearly and steadily.");
      recStartRef.current = Date.now();
      clearInterval(recTimerRef.current);
      if (isMountedRef.current) setRecSec(0);
      recTimerRef.current = setInterval(() => { if (isMountedRef.current) setRecSec((s)=> (s >= 60 ? 60 : s + 1)); }, 1000);

      // speech recognition (optional)
      const rec = recognizerRef.current;
      if (rec) {
        let interim = ""; let final = "";
        rec.onresult = (e) => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const res = e.results[i];
            if (res.isFinal) final += res[0].transcript + " ";
            else interim = res[0].transcript;
          }
          if (isMountedRef.current) setHypText((final + " " + interim).trim());
        };
        rec.onend = () => { if (isMountedRef.current) setRecognizing(false); };
        rec.onerror = (err) => { console.warn('Recognizer error', err); if (isMountedRef.current) setRecognizing(false); };
        try { rec.start(); if (isMountedRef.current) setRecognizing(true); } catch (e) { console.warn('Recognizer start failed', e); }
      }

      // schedule auto-stop after 60s
      clearTimeout(autoStopRef.current);
      autoStopRef.current = setTimeout(() => {
        try { stopRecording(); } catch(e){ console.warn('auto-stop failed', e); }
      }, 60000);

    } catch (e) {
      // Provide clear user-facing messages for common errors and avoid rethrowing
      console.error('startRecording error', e);
      const name = e && e.name ? e.name : 'UnknownError';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        if (isMountedRef.current) setStatus('Microphone access denied. Please allow microphone permissions in your browser settings.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        if (isMountedRef.current) setStatus('No microphone found. Please connect a microphone and try again.');
      } else if (e.message && e.message.includes('getUserMedia not supported')) {
        if (isMountedRef.current) setStatus('Your browser does not support getUserMedia. Use Chrome/Edge/Firefox on desktop for best results.');
      } else {
        if (isMountedRef.current) setStatus('Microphone permission denied or unavailable.');
      }

      // Only attempt safe cleanup if we have something to clean
      if ((mediaRef && mediaRef.current) || (streamRef && streamRef.current)) {
        safeStopMedia({ mediaRef, streamRef, setStatus, isMountedRef });
      }

      if (isMountedRef.current) { try { setRecording(false); } catch(e){} }
      if (isMountedRef.current) { try { setRecognizing(false); } catch(e){} }
    }
  }

  function stopRecording() {
    // clear any auto-stop
    clearTimeout(autoStopRef.current);
    clearInterval(recTimerRef.current);

    // stop recognizer
    const rec = recognizerRef.current;
    try { if (rec && recognizing) { try { rec.stop(); } catch(e){}; if (isMountedRef.current) setRecognizing(false); } } catch(e){console.warn(e);}    

    // safely stop media recorder and stream
    try {
      if (mediaRef.current && mediaRef.current.state && mediaRef.current.state !== 'inactive') {
        try { mediaRef.current.stop(); } catch (err) { console.warn('stop error', err); }
      }
    } catch(e) { console.warn('stopRecording mediaRef error', e); }

    try { if (streamRef.current) { streamRef.current.getTracks().forEach(t => { try{ t.stop(); }catch(e){} }); streamRef.current = null; } } catch(e){console.warn(e);} 

    if (isMountedRef.current) setRecording(false);
    const dur = (Date.now() - recStartRef.current) / 1000;
    if (isMountedRef.current) setStatus(`Recording stopped. Duration ${Math.round(dur)}s. Analyze to see scores.`);
  }

  function analyze() {
    const align = analyzeAlignment(text, hypText);
    const { wpm, fluencyScore } = estimateFluency(hypText, recSec || 1);
    const pronScore = estimatePronunciation(align);
    const content = align.contentAcc;
    const overall = scoreOverall(content, pronScore, fluencyScore);
    const result = { content, pronScore, fluencyScore, overall, wpm, align, when: new Date().toISOString(), id: uid(), type: "ReadAloud" };
    if (isMountedRef.current) setScores(result);
    saveHistory(result, text, hypText, audioUrl);
    if (isMountedRef.current) setStatus("Analysis complete. Review feedback below.");
  }

  function resetAll() {
    clearInterval(timerRef.current);
    clearInterval(recTimerRef.current);
    clearTimeout(autoStopRef.current);
    safeStopMedia({ mediaRef, streamRef, setStatus, isMountedRef });
    if (isMountedRef.current) { setPrepSec(40); setRecSec(0); setHypText(""); setScores(null); }
    try { if (audioUrl) { URL.revokeObjectURL(audioUrl); } } catch(e){}
    if (isMountedRef.current) setAudioUrl("");
    if (isMountedRef.current) setRecording(false);
    if (isMountedRef.current) setStatus("Ready. Start Preparation when you are.");
  }

  return (
    <Card className="rounded-2xl shadow-md">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span>Read Aloud</span>
          <div className="flex items-center gap-2 text-xs md:text-sm">
            <Button variant="outline" onClick={() => setText(samplePassage)}>Load Sample</Button>
            <Button variant="ghost" onClick={() => setText("")}>Clear</Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Passage</Label>
            <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the passage here"/>
            <div className="flex items-center gap-3 text-sm opacity-80">
              <span>Prep: {String(Math.floor(prepSec/60)).padStart(2,'0')}:{String(prepSec%60).padStart(2,'0')}</span>
              <div className="h-2 flex-1 rounded bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                <div className="h-full bg-blue-600" style={{ width: `${(prepSec/40)*100}%` }} />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button onClick={startPrep} disabled={!text.trim() || recording}>Prepare</Button>
              {!recording ? (
                <Button onClick={startRecording} disabled={!text.trim()}><Mic className="mr-2 h-4 w-4"/> Record</Button>
              ) : (
                <Button variant="destructive" onClick={stopRecording}><Square className="mr-2 h-4 w-4"/> Stop</Button>
              )}
              <Button variant="outline" onClick={() => { try{ const u = new Audio(audioUrl); u.play(); } catch(e){ if (isMountedRef.current) setStatus('No audio to play.'); } }} disabled={!audioUrl}><Play className="mr-2 h-4 w-4"/> Play</Button>
              <Button variant="outline" onClick={() => { try{ const u = new Audio(audioUrl); u.loop = true; u.play(); } catch(e){ if (isMountedRef.current) setStatus('No audio to loop.'); } }} disabled={!audioUrl}><Repeat className="mr-2 h-4 w-4"/> Loop</Button>
              <Button variant="secondary" onClick={analyze} disabled={!hypText}><Download className="mr-2 h-4 w-4"/> Analyze</Button>
              <Button variant="ghost" onClick={resetAll}><Trash2 className="mr-2 h-4 w-4"/> Reset</Button>
            </div>
            <div className="text-sm opacity-80">{status}</div>
            <div className="flex items-center gap-3 text-sm opacity-80">
              <span>Recording: {String(Math.floor(recSec/60)).padStart(2,'0')}:{String(recSec%60).padStart(2,'0')}</span>
              <div className="h-2 flex-1 rounded bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                <div className="h-full bg-emerald-600" style={{ width: `${Math.min((recSec/60)*100,100)}%` }} />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <Label>Your Recording (waveform)</Label>
            <div ref={wsContainer} className="rounded-xl border h-24 flex items-center"/>
            <Label>Live / Final Transcript</Label>
            <Textarea rows={8} value={hypText} onChange={(e) => setHypText(e.target.value)} placeholder="Live speech-to-text will appear here if your browser supports it."/>
          </div>
        </div>

        {scores && (
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="rounded-xl">
              <CardHeader><CardTitle>Scores</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3 text-center">
                  <ScoreBox label="Content" value={scores.content}/>
                  <ScoreBox label="Pronunciation" value={scores.pronScore}/>
                  <ScoreBox label="Fluency" value={scores.fluencyScore}/>
                  <ScoreBox label="Overall" value={scores.overall}/>
                </div>
                <div className="mt-4 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={[
                      { metric: "Content", score: scores.content },
                      { metric: "Pronunciation", score: scores.pronScore },
                      { metric: "Fluency", score: scores.fluencyScore },
                    ]}>
                      <PolarGrid />
                      <PolarAngleAxis dataKey="metric" />
                      <PolarRadiusAxis angle={30} domain={[0, 100]} />
                      <RechartsRadar name="You" dataKey="score" stroke="#2563eb" fill="#3b82f6" fillOpacity={0.4} />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
                <div className="text-sm mt-2 opacity-80">WPM: {scores.wpm} (Aim 95–125 for natural pacing)</div>
              </CardContent>
            </Card>

            <Card className="rounded-xl">
              <CardHeader><CardTitle>Word-by-word Feedback</CardTitle></CardHeader>
              <CardContent>
                <p className="text-sm mb-2 opacity-80">Green = correct, Amber = approximate/unclear, Red = missed.</p>
                <div className="leading-8">
                  {scores.align.details.map((d, i) => (
                    <span key={i} className={
                      d.status === "correct" ? "bg-emerald-500/20 px-1 rounded" :
                      d.status === "approx" ? "bg-amber-500/20 px-1 rounded" :
                      d.status === "missed" ? "bg-rose-500/20 px-1 rounded" :
                      ""
                    }> {d.word} </span>
                  ))}
                </div>
                <div className="text-sm mt-3 opacity-80">Extras in your speech: {scores.align.hyp.filter(h=>!scores.align.ref.includes(h)).length}</div>
                <h4 className="mt-4 font-semibold">Tips</h4>
                <ul className="list-disc pl-5 text-sm opacity-90 space-y-1">
                  <li>Hold vowels fully; avoid dropping word endings like <em>-ed</em> and <em>-s</em>.</li>
                  <li>For <strong>th</strong>, place tongue between teeth: voiced in <em>this</em>, voiceless in <em>think</em>.</li>
                  <li>Keep pace steady; aim for natural phrasing every 4–7 words.</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ScoreBox({ label, value }) {
  return (
    <div className="rounded-xl bg-neutral-100 dark:bg-neutral-800 p-4 shadow-sm">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-xs opacity-70 mt-1">{label}</div>
    </div>
  );
}

// ---------------------------------------------
// Listen & Repeat (uses Speech Synthesis to play the reference sentence)
// ---------------------------------------------
function ListenRepeatCard() {
  const [bank, setBank] = useState(listenRepeatBank);
  const [idx, setIdx] = useState(0);
  const [target, setTarget] = useState(bank[0].text);
  const [hyp, setHyp] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [recSec, setRecSec] = useState(0);
  const wsContainer = useRef(null);
  useWaveSurfer(wsContainer, audioUrl);
  const mediaRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const autoStopRef = useRef(null);
  const isMountedRef = useRef(true);
  useEffect(() => { isMountedRef.current = true; return () => { isMountedRef.current = false; }; }, []);

  const speak = () => {
    const u = new SpeechSynthesisUtterance(target);
    u.lang = "en-US";
    u.rate = 0.9;
    u.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  async function startRec() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia not supported');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      mediaRef.current = mr; chunksRef.current = [];
      mr.ondataavailable = (e) => chunksRef.current.push(e.data);
      mr.onstop = () => { try { const blob = new Blob(chunksRef.current, { type: "audio/webm" }); const url = URL.createObjectURL(blob); try{ if (audioUrl) URL.revokeObjectURL(audioUrl);}catch(e){} if (isMountedRef.current) setAudioUrl(url); } catch(e){console.warn(e);} try { if (streamRef.current) { streamRef.current.getTracks().forEach(t=>{try{t.stop();}catch(e){}}); streamRef.current = null; } } catch(e){} };
      mr.start(); if (isMountedRef.current) setRecSec(0);
      clearInterval(recTimerRef.current);
      recTimerRef.current = setInterval(()=> { if (isMountedRef.current) setRecSec((s)=> s>=20?20:s+1); }, 1000);

      clearTimeout(autoStopRef.current);
      autoStopRef.current = setTimeout(()=> { try{ stopRec(); } catch(e){ console.warn(e); } }, 30000);
    } catch (e) {
      console.error('startRec error', e);
      if (isMountedRef.current) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) setStatusIfMounted('Microphone access denied.');
      }
    }
  }
  function stopRec() { clearTimeout(autoStopRef.current); clearInterval(recTimerRef.current); try { if (mediaRef.current && mediaRef.current.state && mediaRef.current.state !== 'inactive') { try { mediaRef.current.stop(); } catch(e) { console.warn(e); } } } catch(e){console.warn(e);} try{ if (streamRef.current) { streamRef.current.getTracks().forEach(t=>{try{t.stop();}catch(e){}}); streamRef.current = null; } } catch(e){} }

  // small helper to set status if available in parent component (not available here), noop for now
  function setStatusIfMounted(msg) { try{ if (isMountedRef.current) { /* TODO: bubble this up if you wire a status handler */ console.info('[ListenRepeat] status:', msg); } } catch(e){} }

  const analyzeObj = useMemo(() => analyzeAlignment(target, hyp), [target, hyp]);
  const flu = useMemo(() => estimateFluency(hyp, recSec||1), [hyp, recSec]);
  const pron = useMemo(() => estimatePronunciation(analyzeObj), [analyzeObj]);
  const overall = scoreOverall(analyzeObj.contentAcc, pron, flu.fluencyScore);

  const recognizeOnce = () => {
    const r = getRecognizer();
    if (!r) { alert("Speech Recognition not supported in this browser."); return; }
    let final = ""; r.interimResults = false; r.onresult = (e)=>{ final = e.results[0][0].transcript; setHyp(final); }; try{ r.start(); } catch(e){ console.warn('Recognizer start failed', e); }
  };

  return (
    <Card className="rounded-2xl shadow-md">
      <CardHeader><CardTitle>Listen & Repeat</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 space-y-2">
            <Label>Sentence</Label>
            <div className="rounded-xl border p-3 text-sm md:text-base bg-neutral-50 dark:bg-neutral-900">{target}</div>
            <div className="flex gap-2 flex-wrap">
              <Button onClick={speak}><Play className="mr-2 h-4 w-4"/> Play Sentence</Button>
              <Button variant="outline" onClick={startRec}><Mic className="mr-2 h-4 w-4"/> Record</Button>
              <Button variant="destructive" onClick={stopRec}><Square className="mr-2 h-4 w-4"/> Stop</Button>
              <Button variant="secondary" onClick={recognizeOnce}>Transcribe</Button>
              <Button variant="ghost" onClick={()=>{ const n=(idx+1)%bank.length; setIdx(n); setTarget(bank[n].text); setHyp(""); }}>Next</Button>
            </div>
            <div className="text-sm opacity-70">Recording: {String(Math.floor(recSec/60)).padStart(2,'0')}:{String(recSec%60).padStart(2,'0')}</div>
            <div ref={wsContainer} className="rounded-xl border h-24 flex items-center"/>
          </div>
          <div className="flex-1 space-y-2">
            <Label>Your Transcript</Label>
            <Textarea rows={8} value={hyp} onChange={(e)=>setHyp(e.target.value)} placeholder="Click Transcribe or type what you said"/>
            <div className="grid grid-cols-2 gap-3">
              <ScoreBox label="Content" value={analyzeObj.contentAcc}/>
              <ScoreBox label="Pronunciation" value={pron}/>
              <ScoreBox label="Fluency" value={flu.fluencyScore}/>
            </div>
            <div className="rounded-xl border p-3 text-sm">
              {analyzeObj.details.map((d,i)=> (
                <span key={i} className={d.status === 'correct' ? 'bg-emerald-500/20 px-1 rounded' : d.status === 'approx' ? 'bg-amber-500/20 px-1 rounded' : d.status === 'missed' ? 'bg-rose-500/20 px-1 rounded' : ''}> {d.word} </span>
              ))}
            </div>
            <div className="text-sm">Overall: <strong>{overall}</strong></div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------
// Listening Comprehension (MCQ demo with timer)
// ---------------------------------------------
function ListeningCard() {
  const [qIdx, setQIdx] = useState(0);
  const [time, setTime] = useState(25);
  const [choice, setChoice] = useState(null);
  const [answered, setAnswered] = useState(false);
  const q = listeningBank[qIdx];

  useEffect(() => {
    setTime(25); setChoice(null); setAnswered(false);
    const t = setInterval(() => setTime((s)=> s<=1 ? 0 : s-1), 1000);
    return () => clearInterval(t);
  }, [qIdx]);

  const playAudio = () => {
    const u = new SpeechSynthesisUtterance(q.audioText);
    u.lang = "en-US"; u.rate = 0.95; u.pitch = 1;
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
  };

  const submit = () => { setAnswered(true); const isCorrect = q.options[choice]?.correct; const result = {
    id: uid(), type: "Listening", when: new Date().toISOString(), correct: !!isCorrect, question: q.prompt
  }; saveHistory(result); };

  return (
    <Card className="rounded-2xl shadow-md">
      <CardHeader><CardTitle>Listening — Multiple Choice (Single Answer)</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm opacity-80">Time: {String(Math.floor(time/60)).padStart(2,'0')}:{String(time%60).padStart(2,'0')}</div>
          <div className="flex gap-2">
            <Button onClick={playAudio}><Play className="mr-2 h-4 w-4"/> Play Audio</Button>
            <Button variant="ghost" onClick={()=> setQIdx((qIdx+1)%listeningBank.length)}>Next</Button>
          </div>
        </div>
        <div className="rounded-xl border p-3 text-sm md:text-base bg-neutral-50 dark:bg-neutral-900">
          <strong>Prompt:</strong> {q.prompt}
        </div>
        <div className="space-y-2">
          {q.options.map((opt, i) => (
            <label key={i} className={`flex items-center gap-3 rounded-xl border p-3 cursor-pointer ${answered ? (opt.correct ? 'border-emerald-500 bg-emerald-500/10' : (choice===i ? 'border-rose-500 bg-rose-500/10' : '')) : (choice===i ? 'border-blue-500 bg-blue-500/10' : '')}`}>
              <input type="radio" name="opt" checked={choice===i} onChange={()=> setChoice(i)} disabled={answered}/>
              <span>{opt.text}</span>
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button onClick={submit} disabled={choice===null || answered}>Submit</Button>
          {answered && (
            <div className="text-sm">{q.explain}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------
// History (localStorage)
// ---------------------------------------------
function saveHistory(entry, refText, hypText, audioUrl) {
  const key = "pte-history";
  const prev = JSON.parse(localStorage.getItem(key) || "[]");
  const full = { ...entry, refText, hypText, audioUrl };
  prev.unshift(full);
  localStorage.setItem(key, JSON.stringify(prev.slice(0, 100)));
}

function HistoryCard() {
  const [items, setItems] = useState([]);
  useEffect(() => { const arr = JSON.parse(localStorage.getItem("pte-history") || "[]"); setItems(arr); }, []);
  const clearAll = () => { localStorage.removeItem("pte-history"); setItems([]); };

  return (
    <Card className="rounded-2xl shadow-md">
      <CardHeader className="flex items-center justify-between"><CardTitle>Practice History</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center"><div className="text-sm opacity-70">Saved attempts: {items.length}</div><Button variant="ghost" onClick={clearAll}><Trash2 className="mr-2 h-4 w-4"/> Clear</Button></div>
        <div className="space-y-3">
          {items.length === 0 && <div className="opacity-70 text-sm">No history yet. Do a practice and analyze to save.</div>}
          {items.map((it) => (
            <div key={it.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-3 text-sm justify-between">
                <div>
                  <span className="font-semibold">{it.type}</span>
                  <span className="opacity-70 ml-2">{new Date(it.when).toLocaleString()}</span>
                </div>
                {typeof it.overall === 'number' && (
                  <div className="rounded-lg px-3 py-1 bg-neutral-100 dark:bg-neutral-800">Overall: {it.overall}</div>
                )}
              </div>
              {it.refText && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm">Show texts</summary>
                  <div className="mt-2 grid md:grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="font-semibold mb-1">Reference</div>
                      <div className="rounded bg-neutral-50 dark:bg-neutral-900 p-2">{it.refText}</div>
                    </div>
                    <div>
                      <div className="font-semibold mb-1">Your Transcript</div>
                      <div className="rounded bg-neutral-50 dark:bg-neutral-900 p-2">{it.hypText}</div>
                    </div>
                  </div>
                </details>
              )}
              {it.audioUrl && (
                <audio className="mt-2 w-full" controls src={it.audioUrl}/>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------
// Sample data
// ---------------------------------------------
const samplePassage = `The Industrial Revolution was a period of profound change during the late eighteenth and early nineteenth centuries. It marked a shift from agrarian economies to industrialized production powered by new technologies, transforming work, transport, and society.`;

const listenRepeatBank = [
  { text: "Technology enables collaboration across continents in real time." },
  { text: "Sustainable practices reduce waste and protect resources." },
  { text: "Researchers observed a significant decline in emissions." },
  { text: "Urban planning balances growth with livability." },
  { text: "Education opens doors to new opportunities and critical thinking." },
];

const listeningBank = [
  {
    prompt: "After listening, choose the main idea of the talk.",
    audioText: "The speaker explains how remote work technologies have changed team communication, highlighting benefits and challenges such as flexibility, time zones, and collaboration tools.",
    options: [
      { text: "Remote work improves communication in every case.", correct: false },
      { text: "Remote work changes communication with pros and cons.", correct: true },
      { text: "Remote work eliminates time-zone issues.", correct: false },
    ],
    explain: "The talk mentions both benefits and challenges, so the balanced statement is correct.",
  },
  {
    prompt: "Select the best summary of the announcement.",
    audioText: "The museum will extend weekend hours and introduce guided tours for the new exhibition starting next month.",
    options: [
      { text: "The museum is closing for renovations.", correct: false },
      { text: "New tours and longer weekend hours begin next month.", correct: true },
      { text: "The museum will reduce services on weekends.", correct: false },
    ],
    explain: "The summary with extended hours and guided tours matches the audio.",
  },
];

// ---------------------------------------------
// Small dev tests (run by adding ?runTests=1 to URL)
// ---------------------------------------------
function runDevTests() {
  try {
    console.group('PTE App — Dev tests');
    const a1 = analyzeAlignment('The quick brown fox', 'The quick brown fox');
    console.log('alignment same', a1);
    const a2 = analyzeAlignment('The quick brown fox', 'quick fox');
    console.log('alignment missing words', a2);
    const lev = levenshtein('kitten','sitting');
    console.log('levenshtein kitten->sitting', lev);
    const flu = estimateFluency('This is a short sentence for testing', 3);
    console.log('fluency', flu);
    console.groupEnd();
  } catch (e) { console.warn('Dev tests failed', e); }
}

try { if (typeof window !== 'undefined' && window.location && window.location.search && window.location.search.indexOf('runTests=1') !== -1) { runDevTests(); } } catch(e){}
