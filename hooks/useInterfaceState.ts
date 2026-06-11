import { useEffect } from "react";
import { useSignals } from "./useSignals";

export function useInterfaceState() {
  const { bss, efd, plb, trades } = useSignals();

  useEffect(() => {
    const body = document.body;
    const breaches = trades.filter(t => t.rules?.some(r => r.broken)).length;
    const isBreached   = breaches > 0;
    const isDisciplined = !isBreached && (bss.score ?? 0) >= 68 && trades.length >= 3;
    const isVolatile   = !isDisciplined && (efd.state === "critical" || plb.state === "critical");

    body.classList.toggle("axiem-breached",    isBreached);
    body.classList.toggle("axiem-disciplined", isDisciplined);
    body.classList.toggle("axiem-volatile",    isVolatile);
  }, [bss, efd, plb, trades]);
}
