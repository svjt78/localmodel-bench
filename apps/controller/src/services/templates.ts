import type { PromptTemplate } from "@ollama-local/shared";

export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  {
    id: "summarize-workspace",
    name: "Summarize this workspace",
    description: "High-level orientation to an attached codebase or folder.",
    body: "Use your tools to explore the attached workspace and summarize its purpose, structure, and key files. Focus on {{focus_area}}.",
    variables: ["focus_area"],
    builtIn: true,
  },
  {
    id: "compare-documents",
    name: "Compare these attached documents",
    description: "Side-by-side comparison of attached files.",
    body: "Compare the attached documents and summarize the key differences in {{comparison_topic}}.",
    variables: ["comparison_topic"],
    builtIn: true,
  },
  {
    id: "step-by-step-reasoning",
    name: "Reason through this problem step by step",
    description: "Ask the model to think out loud before answering.",
    body: "Think through the following problem step by step, showing your reasoning before giving a final answer: {{problem}}",
    variables: ["problem"],
    builtIn: true,
  },
  {
    id: "find-relevant-code",
    name: "Find code relevant to a topic",
    description: "Search an attached workspace for code related to a topic.",
    body: "Search the attached workspace for code related to {{topic}} and explain what you find.",
    variables: ["topic"],
    builtIn: true,
  },
];
