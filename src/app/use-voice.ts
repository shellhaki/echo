"use client";

// Voice input. Uses the browser's Web Speech API when available (free, live
// transcript). Otherwise records with MediaRecorder and sends the audio to
// /api/transcribe. Either way the caller gets text it can show and edit.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type Status = "idle" | "listening" | "transcribing";

function getRecognitionCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone permission was denied. Allow it in your browser's site settings.",
  "service-not-allowed": "Speech recognition is blocked in this browser.",
  "no-speech": "I didn't hear anything. Try again a bit closer to the mic.",
  "audio-capture": "No microphone found.",
  network: "Speech recognition needs a network connection.",
};

const noopSubscribe = () => () => {};

// Errors meaning the browser's speech service itself is unavailable.
const BROKEN_SPEECH_API = new Set(["network", "service-not-allowed", "language-not-supported"]);
const BROKEN_KEY = "wb_speech_api_broken";

function speechApiBroken(): boolean {
  try {
    return localStorage.getItem(BROKEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSpeechApiBroken() {
  try {
    localStorage.setItem(BROKEN_KEY, "1");
  } catch {}
}

function detectSupport(): boolean {
  return (
    !!getRecognitionCtor() ||
    (typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined")
  );
}

export function useVoice(onText: (text: string, final: boolean) => void) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // "browser" = live Web Speech transcript, "server" = record then /api/transcribe.
  const [engine, setEngine] = useState<"browser" | "server">("browser");
  const supported = useSyncExternalStore(noopSubscribe, detectSupport, () => true);
  const recRef = useRef<Recognition | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const onTextRef = useRef(onText);
  useLayoutEffect(() => {
    onTextRef.current = onText;
  });

  const startRecorder = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(ERRORS["not-allowed"]);
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 1000) {
        setStatus("idle");
        setError(ERRORS["no-speech"]);
        return;
      }
      setStatus("transcribing");
      try {
        const form = new FormData();
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        form.append("audio", blob, `recording.${ext}`);
        const res = await fetch("/api/transcribe", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Transcription failed.");
        onTextRef.current(data.text, true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed.");
      } finally {
        setStatus("idle");
      }
    };
    mediaRef.current = rec;
    rec.start();
    setStatus("listening");
  }, []);

  const startSpeechApi = useCallback((Ctor: new () => Recognition) => {
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let finalText = "";
    let fallback = false;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onTextRef.current((finalText + interim).trim(), false);
    };
    rec.onerror = (e) => {
      if (BROKEN_SPEECH_API.has(e.error)) {
        // This browser ships the API without a working backend (Brave, Arc, ...).
        // Switch to recording + server transcription for good.
        markSpeechApiBroken();
        fallback = true;
      } else if (e.error !== "aborted") {
        setError(ERRORS[e.error] ?? `Speech recognition error: ${e.error}`);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      if (fallback) {
        setEngine("server");
        void startRecorder();
        return;
      }
      setStatus("idle");
      onTextRef.current(finalText.trim(), true);
      recRef.current = null;
    };
    recRef.current = rec;
    rec.start();
    setStatus("listening");
  }, [startRecorder]);

  const start = useCallback(() => {
    setError(null);
    const Ctor = speechApiBroken() ? null : getRecognitionCtor();
    setEngine(Ctor ? "browser" : "server");
    if (Ctor) startSpeechApi(Ctor);
    else if (navigator.mediaDevices && typeof MediaRecorder !== "undefined") void startRecorder();
    else setError("Voice input isn't supported in this browser. Try Chrome, Edge or Safari.");
  }, [startSpeechApi, startRecorder]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    if (mediaRef.current?.state === "recording") mediaRef.current.stop();
  }, []);

  useEffect(() => () => recRef.current?.abort(), []);

  return { status, engine, error, supported, start, stop, clearError: () => setError(null) };
}

export function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[*_`#>]/g, "");
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(clean));
}

export function stopSpeaking() {
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}
