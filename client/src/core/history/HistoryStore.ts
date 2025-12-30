import { HistoryEntry } from "@/core/types";

export class HistoryStore {
  private static instance: HistoryStore;
  private cache: HistoryEntry[] = [];
  private lastFetch: number = 0;
  private CACHE_TTL = 30000;

  private constructor() {}

  static getInstance(): HistoryStore {
    if (!HistoryStore.instance) {
      HistoryStore.instance = new HistoryStore();
    }
    return HistoryStore.instance;
  }

  async fetchHistory(playerId: string): Promise<HistoryEntry[]> {
    const now = Date.now();
    if (this.cache.length > 0 && now - this.lastFetch < this.CACHE_TTL) {
      return this.cache;
    }

    try {
      const response = await fetch(`/api/history/${encodeURIComponent(playerId)}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch history: ${response.status}`);
      }
      const data = await response.json();
      this.cache = data;
      this.lastFetch = now;
      return data;
    } catch (err) {
      console.error("[HistoryStore] failed to fetch history:", err);
      return this.cache;
    }
  }

  getHistory(): HistoryEntry[] {
    return this.cache;
  }

  invalidateCache() {
    this.lastFetch = 0;
  }
}

export const historyStore = HistoryStore.getInstance();
