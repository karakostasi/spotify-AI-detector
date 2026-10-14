import type { Signal } from "../types.js";

export const wikipedia: Signal = (p) => {
  const w = p.web?.wikipedia;
  if (!w) return { id: "wikipedia", score: null, weight: 0, reason: "Wikipedia not checked yet" };
  if (!w.found) {
    // Plenty of real small artists have no article, so absence says nothing.
    return { id: "wikipedia", score: null, weight: 0, reason: "No Wikipedia article found for this artist" };
  }
  if (w.aiMentioned) {
    const quote = w.description ? `: "${w.description}"` : "";
    // Wikipedia's own one-line description calling the act AI is as close to proof as metadata gets.
    if (w.ownArticle && w.aiDescribed) {
      return { id: "wikipedia", score: 0.95, weight: 4, decisive: true, reason: `Wikipedia describes this act as AI-generated${quote}` };
    }
    return {
      id: "wikipedia",
      score: w.ownArticle ? 0.9 : 0.85,
      weight: w.ownArticle ? 3 : 4,
      reason: w.ownArticle ? `Wikipedia's article says this act is AI-generated` : `Wikipedia covers this act only inside an article about AI music${quote}`,
    };
  }
  return { id: "wikipedia", score: 0.1, weight: 1, reason: `Has a Wikipedia article${w.description ? ` ("${w.description}")` : ""}` };
};
