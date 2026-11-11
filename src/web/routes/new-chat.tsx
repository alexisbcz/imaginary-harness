import { useNavigate } from "react-router"

import { Composer } from "@/components/composer"
import { startThread } from "@/lib/chat"

export function NewChat() {
  const navigate = useNavigate()

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-24">
      <h1 className="font-heading text-2xl font-medium">What can I help with?</h1>
      <div className="w-full max-w-2xl">
        <Composer
          autoFocus
          onSend={async (content) => {
            const id = await startThread(content)
            await navigate(`/t/${id}`)
          }}
        />
      </div>
    </div>
  )
}
