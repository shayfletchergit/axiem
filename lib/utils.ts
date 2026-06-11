import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function stateColor(state: string): string {
  return state === "critical" ? "#E8724A"
       : state === "warning"  ? "#D4A84B"
       : state === "ok"       ? "#2CC4A4"
       : "rgb(80 78 74)";
}

export function stateLabel(state: string): string {
  return state === "critical" ? "Critical"
       : state === "warning"  ? "Elevated"
       : state === "ok"       ? "Stable"
       : "—";
}

export function scoreClass(score: number | null): string {
  if (score === null) return "text-t3";
  if (score >= 70) return "text-[#2CC4A4]";
  if (score >= 50) return "text-[#D4A84B]";
  return "text-[#E8724A]";
}
