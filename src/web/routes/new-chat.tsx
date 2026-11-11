import { useState } from "react";
import { useNavigate } from "react-router";

import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Composer } from "@/components/composer";
import { startThread } from "@/lib/chat";

const SUGGESTIONS = [
  "Write a README for a new project",
  "Explain a tricky piece of code",
  "Draft a plan for a weekend trip",
  "Summarize the key ideas of a book",
];

export function NewChat() {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  async function start(content: string) {
    const id = await startThread(content);
    await navigate(`/t/${id}`);
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-24">
      <h1 className="font-heading text-2xl font-medium">
        What can I help with?
      </h1>
      <div className="flex w-full max-w-2xl flex-col gap-3">
        <Composer autoFocus disabled={starting} onSend={start} />
        <Suggestions className="justify-center">
          {SUGGESTIONS.map((suggestion) => (
            <Suggestion
              key={suggestion}
              suggestion={suggestion}
              disabled={starting}
              onClick={async (content) => {
                setStarting(true);
                try {
                  await start(content);
                } catch {
                  setStarting(false);
                }
              }}
            />
          ))}
        </Suggestions>
      </div>
    </div>
  );
}
