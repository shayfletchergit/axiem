"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: "rgb(25,24,22)" }}>
      <div className="w-full max-w-[340px]">
        <div className="text-center mb-8">
          <div className="font-display text-t1 text-[22px] tracking-[-0.02em] mb-1">Axiem</div>
          <div className="text-xs text-t4">Sign in to your account</div>
        </div>

        <form onSubmit={handleLogin}
          className="rounded-lg overflow-hidden"
          style={{ background: "rgba(29,27,25,0.92)", border: "1px solid rgba(255,255,255,0.08)" }}>
          <div className="px-6 py-5 space-y-3">
            {error && (
              <div className="text-2xs px-3 py-2 rounded-[2px]"
                style={{ background: "rgba(232,114,74,0.08)", border: "1px solid rgba(232,114,74,0.15)", color: "#E8724A" }}>
                {error}
              </div>
            )}
            <div>
              <div className="text-2xs text-t4 mb-1.5">Email</div>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                required autoFocus
                className="w-full h-9 px-3 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                style={{ border: "1px solid rgba(255,255,255,0.07)" }}
              />
            </div>
            <div>
              <div className="text-2xs text-t4 mb-1.5">Password</div>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                required
                className="w-full h-9 px-3 text-xs text-t1 rounded-[2px] outline-none bg-s3 placeholder:text-t4"
                style={{ border: "1px solid rgba(255,255,255,0.07)" }}
              />
            </div>
          </div>
          <div className="px-6 pb-5">
            <button type="submit" disabled={loading}
              className="w-full h-9 text-xs font-medium rounded-[2px] transition-all disabled:opacity-50"
              style={{ background: "rgba(232,228,220,0.92)", color: "rgb(25,24,22)" }}>
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>

        <p className="text-center text-2xs text-t4 mt-5">
          No account?{" "}
          <a href="/signup" className="text-t2 underline underline-offset-2">Sign up</a>
        </p>
      </div>
    </div>
  );
}
