import { tool, type ToolResultPart, type ToolSet } from "ai";
import { z } from "zod";

export const tools = {
  edit: tool({
    description: "Replaces text in the page.",
    parameters: z.object({
      search: z
        .string()
        .describe(
          "The text to search for. This must be an exact match (must match exactly, including whitespace and indentation) with the exact number of occurrences."
        ),
      replace: z.string().describe("The text to replace with."),
      occurrences: z
        .number()
        .describe(
          "The number of occurrences to replace. The document must contain exactly this number of occurrences. Please provide more context to make a unique match."
        )
        .default(1),
    }),
  }),
  read: tool({
    description:
      "Read the wiki page. Returns the content of the page. You don't need to use this tool to read the page, as you already have the content in the <wiki_page> tag. It can be useful for reading the whole page after editing it.",
    parameters: z.object({}),
  }),
} satisfies ToolSet;

export type ToolResult = Pick<ToolResultPart, "isError" | "result">;

export type ToolImplementation<TOOLS extends ToolSet> = {
  [K in keyof TOOLS]?: (
    args: z.infer<TOOLS[K]["parameters"]>
  ) => Promise<ToolResult>;
};
