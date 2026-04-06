import { Type } from '@mariozechner/pi-ai';
import type { SharedContextStore } from '@orchestrace/context';
import type { RegisteredAgentTool } from './types.js';

export interface SharedContextToolsOptions {
  store: SharedContextStore;
  graphId?: string;
  agentId: string;
}

export function createSharedContextTools(options: SharedContextToolsOptions): RegisteredAgentTool[] {
  const { store, graphId, agentId } = options;

  return [
    {
      tool: {
        name: 'context_share_add',
        description:
          'Add a fact to the shared context that all agents in this session can access. ' +
          'Use this to share discoveries, decisions, conventions, or important findings with other agents. ' +
          'Tag facts with relevant topics so they can be found easily.',
        parameters: Type.Object({
          content: Type.String({ description: 'The fact content to share. Be concise but complete.' }),
          tags: Type.Array(Type.String(), {
            description: 'Topic tags for this fact (e.g. ["architecture", "database", "convention"]). Use lowercase.',
          }),
        }),
      },
      execute: async (args) => {
        const content = args.content as string;
        const tags = args.tags as string[];

        if (!content?.trim()) {
          return { content: 'Error: content cannot be empty', isError: true };
        }
        if (!tags?.length) {
          return { content: 'Error: at least one tag is required', isError: true };
        }

        const fact = store.add({ content: content.trim(), tags, author: agentId }, graphId);

        return {
          content: JSON.stringify({
            id: fact.id,
            tags: fact.tags,
            message: 'Fact added to shared context. All agents can now query it.',
          }),
        };
      },
    },
    {
      tool: {
        name: 'context_share_query',
        description:
          'Search the shared context by tags. Returns matching facts from all agents. ' +
          'Use this to check what other agents have discovered or decided.',
        parameters: Type.Object({
          tags: Type.Array(Type.String(), {
            description: 'Tags to search for. Facts matching ANY of these tags will be returned.',
          }),
        }),
      },
      execute: async (args) => {
        const tags = args.tags as string[];
        if (!tags?.length) {
          return { content: 'Error: at least one tag is required', isError: true };
        }

        const facts = store.query(tags, graphId);

        if (facts.length === 0) {
          return { content: `No shared facts found matching tags: ${tags.join(', ')}` };
        }

        const result = facts.map((f) => ({
          id: f.id,
          tags: f.tags,
          author: f.author,
          content: f.content,
        }));

        return { content: JSON.stringify(result, null, 2) };
      },
    },
    {
      tool: {
        name: 'context_share_read',
        description: 'Read a specific shared context fact by its ID. Use when you see a fact ID in the shared context index.',
        parameters: Type.Object({
          id: Type.String({ description: 'The fact ID to read (e.g. "fact_1234567890_1").' }),
        }),
      },
      execute: async (args) => {
        const id = args.id as string;
        const fact = store.readById(id);

        if (!fact) {
          return { content: `No fact found with ID: ${id}`, isError: true };
        }

        return {
          content: JSON.stringify({
            id: fact.id,
            tags: fact.tags,
            author: fact.author,
            content: fact.content,
            createdAt: new Date(fact.createdAt).toISOString(),
          }, null, 2),
        };
      },
    },
    {
      tool: {
        name: 'context_share_list',
        description: 'List all facts in the shared context. Returns a summary of all shared knowledge.',
        parameters: Type.Object({}),
      },
      execute: async () => {
        const facts = store.list(graphId);

        if (facts.length === 0) {
          return { content: 'No shared facts yet. Use context_share_add to share discoveries with other agents.' };
        }

        const result = facts.map((f) => ({
          id: f.id,
          tags: f.tags,
          author: f.author,
          preview: f.content.length > 150 ? f.content.slice(0, 150) + '...' : f.content,
        }));

        return { content: JSON.stringify(result, null, 2) };
      },
    },
    {
      tool: {
        name: 'context_share_remove',
        description: 'Remove a fact from the shared context by ID. Only remove facts you authored or that are outdated.',
        parameters: Type.Object({
          id: Type.String({ description: 'The fact ID to remove.' }),
        }),
      },
      execute: async (args) => {
        const id = args.id as string;
        const removed = store.remove(id);

        return {
          content: removed
            ? `Fact ${id} removed from shared context.`
            : `No fact found with ID: ${id}`,
          isError: !removed,
        };
      },
    },
  ];
}
