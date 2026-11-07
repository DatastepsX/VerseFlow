import "server-only";

/**
 * Emails, sent with Resend (https://resend.com — its HTTP API, no package): RESEND_API_KEY, and EMAIL_FROM
 * ("VerseFlow <songs@your-domain>", a domain verified at Resend). Without the key nothing is sent (the app
 * works as before) — `emailConfigured()` says so.
 */
export const emailConfigured = () => !!process.env.RESEND_API_KEY;

export async function sendEmail(m: { to: string; subject: string; text: string; html: string }) {
  if (!emailConfigured()) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM || "VerseFlow <onboarding@resend.dev>", to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    signal: AbortSignal.timeout(10_000),
  }).catch((e: unknown) => {
    console.warn("[email] not sent:", e instanceof Error ? e.message : e);
    return null;
  });
  if (res && !res.ok) console.warn("[email] not sent:", res.status, (await res.text().catch(() => "")).slice(0, 200));
  return !!res?.ok;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** a short email: a title, lines of text, a button */
export function simpleEmail(o: { title: string; lines: string[]; button: { label: string; url: string }; footer: string }) {
  const text = [o.title, "", ...o.lines, "", `${o.button.label}: ${o.button.url}`, "", o.footer].join("\n");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
<p style="font-size:13px;color:#7c5cff;font-weight:700;margin:0 0 8px">VerseFlow</p>
<h1 style="font-size:20px;margin:0 0 14px">${esc(o.title)}</h1>
${o.lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 8px">${esc(l)}</p>`).join("\n")}
<p style="margin:20px 0"><a href="${esc(o.button.url)}" style="background:#7c5cff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px">${esc(o.button.label)}</a></p>
<p style="font-size:12px;color:#888;margin-top:24px">${esc(o.footer)}</p></div>`;
  return { text, html };
}
