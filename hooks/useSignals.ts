import { useMemo } from "react";
import { useStore } from "@/lib/store/session";
import { calcEFD, calcPLB, calcSCI, calcBSS } from "@/lib/engine";
import type { Signals } from "@/lib/types";

export function useSignals(): Signals {
  const session = useStore((s) => s.session);
  const baseline = useStore((s) => s.baseline);
  const trades = session?.trades ?? [];

  return useMemo(() => {
    const efd = calcEFD(trades, baseline);
    const plb = calcPLB(trades);
    const sci = calcSCI(trades, baseline);
    const bss = calcBSS(efd, plb, sci);
    return { efd, plb, sci, bss, trades };
  }, [trades, baseline]);
}
