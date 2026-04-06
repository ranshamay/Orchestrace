import type { SharedFact, SharedContextStore } from './types.js';

let nextId = 1;

function generateFactId(): string {
  return `fact_${Date.now()}_${nextId++}`;
}

export class InMemorySharedContextStore implements SharedContextStore {
  private readonly sessionFacts = new Map<string, SharedFact>();
  private readonly graphFacts = new Map<string, Map<string, SharedFact>>();

  add(input: Omit<SharedFact, 'id' | 'createdAt'>, graphId?: string): SharedFact {
    const fact: SharedFact = {
      ...input,
      id: generateFactId(),
      createdAt: Date.now(),
    };

    if (graphId) {
      let bucket = this.graphFacts.get(graphId);
      if (!bucket) {
        bucket = new Map();
        this.graphFacts.set(graphId, bucket);
      }
      bucket.set(fact.id, fact);
    } else {
      this.sessionFacts.set(fact.id, fact);
    }

    return fact;
  }

  query(tags: string[], graphId?: string): SharedFact[] {
    const lowerTags = new Set(tags.map((t) => t.toLowerCase()));
    const results: SharedFact[] = [];

    for (const fact of this.sessionFacts.values()) {
      if (fact.tags.some((t) => lowerTags.has(t.toLowerCase()))) {
        results.push(fact);
      }
    }

    if (graphId) {
      const bucket = this.graphFacts.get(graphId);
      if (bucket) {
        for (const fact of bucket.values()) {
          if (fact.tags.some((t) => lowerTags.has(t.toLowerCase()))) {
            results.push(fact);
          }
        }
      }
    }

    return results;
  }

  readById(id: string): SharedFact | undefined {
    return this.sessionFacts.get(id) ?? this.findInGraphs(id);
  }

  list(graphId?: string): SharedFact[] {
    const results = [...this.sessionFacts.values()];
    if (graphId) {
      const bucket = this.graphFacts.get(graphId);
      if (bucket) {
        results.push(...bucket.values());
      }
    }
    return results.sort((a, b) => a.createdAt - b.createdAt);
  }

  remove(id: string): boolean {
    if (this.sessionFacts.delete(id)) return true;
    for (const bucket of this.graphFacts.values()) {
      if (bucket.delete(id)) return true;
    }
    return false;
  }

  buildIndex(graphId?: string): string {
    const facts = this.list(graphId);
    if (facts.length === 0) return '';

    const lines = facts.map(
      (f) => `- [${f.id}] (${f.tags.join(', ')}) by ${f.author}: ${f.content.length > 120 ? f.content.slice(0, 120) + '...' : f.content}`,
    );

    return `Shared context (${facts.length} facts):\n${lines.join('\n')}`;
  }

  clear(graphId?: string): void {
    if (graphId) {
      this.graphFacts.delete(graphId);
    } else {
      this.sessionFacts.clear();
      this.graphFacts.clear();
    }
  }

  private findInGraphs(id: string): SharedFact | undefined {
    for (const bucket of this.graphFacts.values()) {
      const fact = bucket.get(id);
      if (fact) return fact;
    }
    return undefined;
  }
}
