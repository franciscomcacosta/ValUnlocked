// Fetch versioned tool snippets. Enforces the sub-tier floor.
import { db } from "./supabase";
import type { SubTier } from "./pricing";

export interface Tool {
  name: string;
  display_name: string;
  description: string | null;
  min_tier: SubTier;
  script: string;
  bookmarklet: string | null;
  instructions: string | null;
  target_site: string | null;
  version: number;
}

const TIER_RANK: Record<SubTier, number> = { standard: 1, premium: 2, ultra: 3 };

export function tierMeets(userTier: SubTier | null, floor: SubTier): boolean {
  if (!userTier) return false;
  return TIER_RANK[userTier] >= TIER_RANK[floor];
}

export async function getTool(name: string): Promise<Tool | null> {
  const { data, error } = await db.from("tools").select("*").eq("name", name).single();
  if (error || !data) return null;
  return data as Tool;
}

export async function listTools(userTier: SubTier | null): Promise<Tool[]> {
  if (!userTier) return [];
  const { data } = await db.from("tools").select("*").order("display_name");
  return (data ?? []).filter((t) => tierMeets(userTier, t.min_tier as SubTier)) as Tool[];
}
