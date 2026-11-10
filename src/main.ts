import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(anthropicProvider());

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry: createRegistry() },
  context,
);

const root = await harness.root(context, {
  agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } },
});

const submission = await root.submit(
  { type: "input", content: "What is the capital of France?" },
  context,
);

const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit(
    (tx) => tx.entry(AssistantEntry, settled.answer),
    context,
  );
  const content = answer?.model?.[0]?.content ?? "";
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("");
  console.log(text);
} else {
  console.error("Unanswered:", settled);
}

await harness.close(context);
