import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { intro, isCancel, text } from "@clack/prompts";
import { streamText, type CoreMessage, type ToolResultPart } from "ai";
import chalk from "chalk";
import consola from "consola";
import { createTwoFilesPatch } from "diff";
import { getDocumentEditor } from "./DocumentEditor";
import { tools, type ToolImplementation } from "./tools";

const model =
  (Bun.env["PROVIDER"] || "openai") === "openai"
    ? openai("gpt-4.1")
    : google("gemini-2.5-flash-preview-04-17");

consola.info("Using model:", model.modelId);

function normalizeLineEndings(s: string) {
  return s.replace(/[ ]*\r?\n/g, "\n");
}

async function main() {
  intro("ai-secretary");

  const documentEditor = getDocumentEditor(Bun.argv[2] as string);
  const buffer = new DocumentBuffer(await documentEditor.load());
  console.log("=".repeat(80));
  console.log("Original contents");
  console.log("-".repeat(80));
  console.log(buffer.contents);
  console.log("=".repeat(80));
  consola.info("Document loaded successfully.");

  const initialRequest = await text({ message: "What do you want to do?" });
  if (isCancel(initialRequest) || !initialRequest) {
    consola.error("No request.");
    return;
  }

  let previousText = buffer.contents;
  const secretary = new AiSecretary(buffer, initialRequest);
  await secretary.run();

  for (;;) {
    if (buffer.contents !== previousText) {
      showDiff(buffer.originalContents, buffer.contents);
      previousText = buffer.contents;
    }
    const nextRequest = await text({
      message: "Any feedback? (Leave empty to finish)",
    });
    if (isCancel(nextRequest)) {
      consola.error("Canceled.");
      return;
    }
    if (!nextRequest) {
      break;
    }
    await secretary.feedback(nextRequest);
  }

  if (buffer.contents === buffer.originalContents) {
    consola.warn(
      "No changes made to the page. Please check your request and try again."
    );
  } else {
    await documentEditor.save(buffer.contents);
  }
}

function showDiff(original: string, modified: string) {
  if (original === modified) {
    consola.info("No changes made to the document.");
    return;
  }

  // Generate diff patch
  const patch = createTwoFilesPatch(
    "Original",
    "Modified",
    original,
    modified,
    "",
    "",
    { context: 5 }
  );

  // Skip the first two lines (header)
  const lines = patch.split("\n").slice(2);

  // Display diff with colors
  for (const line of lines) {
    if (line.startsWith("+")) {
      // Added lines in green
      console.log(chalk.green(line));
    } else if (line.startsWith("-")) {
      // Removed lines in red
      console.log(chalk.red(line));
    } else if (line.startsWith("@")) {
      // Line indicators in cyan
      console.log(chalk.cyan(line));
    } else {
      // Context lines in normal color
      console.log(line);
    }
  }

  // Print a summary
  const addedLines = lines.filter((line) => line.startsWith("+")).length;
  const removedLines = lines.filter((line) => line.startsWith("-")).length;
  consola.info(`Changes: ${addedLines} additions, ${removedLines} deletions`);
}

class AiSecretary {
  private editor?: EditorAgent;
  constructor(public buffer: DocumentBuffer, private request: string) {}

  getPrompt() {
    const prompt = `<system_instructions>
You are an AI secretary.
You will be given a wiki page in Markdown format inside the <wiki_page></wiki_page> tag.
Your task is to edit the page according to the user's request. Use the "edit" tool to do so.
However, if it is clear that the user merely asking for information, you don't need to edit the page - just answer the question.
Keep using the "edit" tool until the page is edited according to the user's request, then use the "finish" tool to finish the task.
You don't have to write exactly the same text as the user (unless specifically requested), but you should keep the meaning and intent of the user's request.
You can use multiple "edit" tool calls in parallel.
Before editing the page, plan and think what you are going to do, then let the user know before using the "edit" tool.
You can check if you made the correct edits by using the "read" tool after making the edits.
Before ending the task and yielding back to the user, use the "read" tool once more to check if the page is edited correctly.
To ensure accurate edits, carefully analyze the user's request to understand the precise text to be changed and its location.
When in doubt, feel free to ask the user for clarification.
When using the 'edit' tool:
- Ensure the 'search' parameter is an exact match for the text to be replaced, including whitespace and indentation.
- Verify the 'replace' parameter accurately reflects the desired new text and formatting.
- Consider using the 'read' tool after each individual edit in a sequence to verify the change before proceeding.
</system_instructions>

<context>
Current date: ${new Date().toString()}
</context>

<wiki_page>
${this.buffer.contents.trim()}
</wiki_page>

${this.request}
`.trim();
    return prompt;
  }

  async run() {
    this.editor = new EditorAgent(
      this.getPrompt(),
      createToolImplementation(this.buffer)
    );
    await this.editor.run();
  }

  async feedback(feedbackText: string) {
    if (!this.editor) {
      throw new Error("Editor not initialized.");
    }
    await this.editor.feedback(feedbackText);
  }
}

class DocumentBuffer {
  public originalContents: string;
  public contents: string;

  constructor(originalContents: string) {
    originalContents = normalizeLineEndings(originalContents);
    this.originalContents = originalContents;
    this.contents = originalContents;
  }
}

function createToolImplementation(
  buffer: DocumentBuffer
): ToolImplementation<typeof tools> {
  return {
    edit: async (args) => {
      const splitted = buffer.contents.split(args.search);
      const matches = splitted.length - 1;
      if (matches === 0) {
        return {
          isError: true,
          result: `Error: No match found for replacement. Please check your text and try again.`,
        };
      }
      if (matches !== args.occurrences) {
        return {
          isError: true,
          result: `Error: The document contains ${matches} occurrences of the search string. Please provide more context to make a unique match.`,
        };
      }
      const replaced = splitted.join(args.replace);
      buffer.contents = replaced;
      return {
        isError: false,
        result: `Edited successfully.`,
      };
    },
    read: async (args) => {
      return {
        isError: false,
        result: `<wiki_page>\n${buffer.contents}\n</wiki_page>`,
      };
    },
  };
}

class EditorAgent {
  messages: CoreMessage[] = [];
  constructor(
    prompt: string,
    private toolImplementation: ToolImplementation<typeof tools>
  ) {
    this.messages.push({
      role: "user",
      content: prompt,
    });
  }
  async run() {
    for (;;) {
      const shouldContinue = await this.iteration();
      if (!shouldContinue) {
        break;
      }
    }
  }
  async feedback(feedbackText: string) {
    this.messages.push({
      role: "user",
      content: feedbackText,
    });
    await this.run();
  }
  async iteration() {
    const stream = streamText({
      model,
      messages: this.messages,
      tools,
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
    });

    type Mode = "text" | "info";
    let currentMode = "info";
    const mode = (value: Mode) => {
      if (currentMode === "text" && value === "info") {
        process.stdout.write("\n");
      } else if (currentMode === "info" && value === "text") {
        process.stdout.write(">>> ");
      }
      currentMode = value;
    };

    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") {
        mode("text");
        process.stdout.write(part.textDelta);
      } else if (part.type === "tool-call") {
        mode("info");
        consola.start(`${part.toolName} ${JSON.stringify(part.args)}`);
      } else {
        mode("info");
        consola.trace(`[${part.type}]`);
      }
    }
    const response = await stream.response;
    for (const message of response.messages) {
      this.messages.push(message);
    }
    const toolResultParts: ToolResultPart[] = [];
    for (const toolCall of await stream.toolCalls) {
      const toolName = toolCall.toolName as keyof typeof tools;
      try {
        const result = await this.toolImplementation[toolName]!(
          toolCall.args as any
        );
        if (result.isError) {
          consola.fail(`${toolName}:`, result.result);
        } else {
          consola.success(`${toolName}`);
        }
        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          ...result,
        });
      } catch (error) {
        consola.error(
          `Error calling ${toolName} with args ${JSON.stringify(
            toolCall.args
          )}:`,
          error
        );
        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          isError: true,
          result: `Internal error: ${error}`,
        });
      }
    }
    if (toolResultParts.length > 0) {
      this.messages.push({
        role: "tool",
        content: toolResultParts,
      });
      return true;
    }
    return false;
  }
}

await main();
