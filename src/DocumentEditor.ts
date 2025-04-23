import consola from "consola";
import { ofetch } from "ofetch";

interface DocumentEditor {
  load(): Promise<string>;
  save(contents: string): Promise<void>;
}

export function getDocumentEditor(pageToEdit: string): DocumentEditor {
  // Handle file paths (both Unix and Windows style)
  if (
    pageToEdit.startsWith("/") ||
    pageToEdit.startsWith("./") ||
    pageToEdit.startsWith("../") ||
    pageToEdit.match(/^[A-Za-z]:\\/)
  ) {
    return createFilesystemEditor(pageToEdit);
  }

  // Handle Creatorsgarten wiki URLs and references
  const wikiUrlPattern = /^https:\/\/creatorsgarten\.org\/wiki\/(.+)$/;
  const eventUrlPattern = /^https:\/\/creatorsgarten\.org\/event\/(.+)$/;

  let pageRef = "";
  if (pageToEdit.match(/^[\w-]+\/[\w-]+$/)) {
    // Direct pageRef format (namespace/page)
    pageRef = pageToEdit;
  } else {
    const wikiMatch = pageToEdit.match(wikiUrlPattern);
    if (wikiMatch) {
      // Wiki URL format (https://creatorsgarten.org/wiki/OnsenJS)
      pageRef = wikiMatch[1]!;
    } else {
      const eventMatch = pageToEdit.match(eventUrlPattern);
      if (eventMatch) {
        // Event URL format (https://creatorsgarten.org/event/bkkjs22)
        pageRef = `Events/${eventMatch[1]!}`;
      }
    }
  }

  if (pageRef) {
    return createCreatorsgartenWikiEditor(pageRef);
  }

  // Handle GitHub issues
  if (
    pageToEdit.match(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+$/)
  ) {
    return createGithubIssueEditor(pageToEdit);
  }

  // If none of the above, throw an error
  throw new Error(
    `Unsupported page reference: ${pageToEdit}. Please provide a file path, a Creatorsgarten wiki page or URL, or a GitHub issue URL.`
  );
}

function createFilesystemEditor(filePath: string): DocumentEditor {
  return {
    load: async () => {
      const text = await Bun.file(filePath).text();
      consola.info(`Loaded text from ${filePath}`);
      return text;
    },
    save: async (contents: string) => {
      await Bun.write(filePath, contents);
      consola.success("File saved successfully.");
    },
  };
}

function createCreatorsgartenWikiEditor(pageRef: string): DocumentEditor {
  let receivedRevision = "";
  return {
    load: async () => {
      const data = await ofetch(
        "https://wiki.creatorsgarten.org/api/contentsgarten/view",
        {
          query: {
            input: JSON.stringify({
              pageRef: pageRef,
              withFile: true,
              revalidate: true,
              render: false,
            }),
          },
          headers: {
            Authorization: `Bearer ${Bun.env.WIKIGARTEN_AUTH}`,
          },
        }
      );
      receivedRevision = data.result.data.file.revision;
      consola.info(
        `Loaded text from ${pageRef} with revision ${receivedRevision}`
      );
      return data.result.data.file.content;
    },
    save: async (contents: string) => {
      if (!receivedRevision) {
        throw new Error("Cannot save: no revision received");
      }
      await ofetch("https://wiki.creatorsgarten.org/api/contentsgarten/save", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Bun.env.WIKIGARTEN_AUTH}`,
        },
        body: {
          pageRef: pageRef,
          newContent: contents,
          oldRevision: receivedRevision,
        },
      });
      consola.success("File saved successfully.");
    },
  };
}

function createGithubIssueEditor(issueUrl: string): DocumentEditor {
  return {
    load: async () => {
      const data =
        await Bun.$`gh issue view ${issueUrl} --json 'body' --template '{{ .body }}'`.text();
      consola.info(`Loaded text from GitHub issue ${issueUrl}`);
      return data;
    },
    save: async (contents: string) => {
      await Bun.$`gh issue edit ${issueUrl} --body ${contents}`;
      consola.success("Issue edited successfully.");
    },
  };
}
