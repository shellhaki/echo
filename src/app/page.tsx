"use client";

import dynamic from "next/dynamic";

// Client-only: the chat restores history and settings from localStorage.
const Chat = dynamic(() => import("./chat"), { ssr: false });

export default function Page() {
  return <Chat />;
}
