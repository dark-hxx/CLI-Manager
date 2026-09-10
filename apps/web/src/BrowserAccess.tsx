import { useEffect, useState } from "react";
import type { BrowserSession } from "./domain";
import type { TranslationKey } from "./i18n";
import { webClient } from "./webClient";
import { QRCodeSVG } from "qrcode.react";

type T = (key: TranslationKey) => string;

export function MobileQr({ t, deviceId }: { t: T; deviceId: string }) {
  const [ticket, setTicket] = useState<{ token: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const reachable = location.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname.toLowerCase()) && !location.hostname.endsWith(".localhost");
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const refresh = async () => {
    setBusy(true); setFailed(false); setTicket(null);
    try { setTicket(await webClient.mobileTicket(deviceId)); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const expired = ticket && ticket.expiresAt <= now;
  return <section className="mobile-qr">
    <p>{t(reachable ? "mobileQrHint" : "mobileLoopback")}</p>
    {failed && <p className="form-error" role="alert">{t("requestFailed")}</p>}
    {ticket && !expired && <><QRCodeSVG value={`${location.origin}/#mobileToken=${encodeURIComponent(ticket.token)}`} size={240} marginSize={4} title={t("mobileQr")} /><p>{t("mobileQrExpires")} {new Intl.DateTimeFormat(document.documentElement.lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ticket.expiresAt)}</p></>}
    {expired && <p role="status">{t("mobileQrExpired")}</p>}
    <button className="primary-button" disabled={!reachable || busy} onClick={() => void refresh()}>{t(ticket ? "refresh" : "mobileQr")}</button>
    {ticket && <button className="secondary-button" disabled={busy} onClick={() => { setBusy(true); setFailed(false); void webClient.stopMobileTicket(deviceId).then(() => setTicket(null)).catch(() => setFailed(true)).finally(() => setBusy(false)); }}>{t("mobileQrStop")}</button>}
  </section>;
}

export function MobileAccess({ t, onRedeem, onCancel }: { t: T; onRedeem: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <main className="auth-page"><section className="auth-card"><h1>{t("mobileAccess")}</h1><p>{t("mobileAccessHint")}</p>
    <form onSubmit={(event) => { event.preventDefault(); if (busy) return; setBusy(true); setFailed(false); void onRedeem(name).catch(() => setFailed(true)).finally(() => setBusy(false)); }}>
      <label htmlFor="browser-name">{t("browserName")}</label><input id="browser-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      {failed && <p role="alert" className="form-error">{t("mobileAccessFailed")}</p>}
      <button className="primary-button" disabled={busy}>{t("authorizeBrowser")}</button>
      <button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>{t("cancel")}</button>
    </form></section></main>;
}

export function BrowserAccess({ t }: { t: T }) {
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => { void webClient.browserSessions().then((result) => setSessions(result.sessions)).catch(() => setError(true)).finally(() => setBusy(false)); }, []);
  return <section className="browser-access"><h2>{t("browserAccess")}</h2><p>{t("browserAccessHint")}</p>
    {busy && <p role="status">{t("loadingWorkspace")}</p>}{error && <p role="alert">{t("requestFailed")}</p>}
    {!busy && !error && !sessions.length && <p>{t("noBrowsers")}</p>}
    {sessions.map((session) => <article key={session.id}><div><strong>{session.name || session.id}</strong><p>{session.deviceId} · {new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "short", timeStyle: "short", hour12: false }).format(new Date(session.lastSeenAt < 1e10 ? session.lastSeenAt * 1000 : session.lastSeenAt))}</p></div>
      <button className="secondary-button" type="button" disabled={busy} onClick={() => { setBusy(true); setError(false); void webClient.revokeBrowser(session.id).then(() => setSessions((current) => current.filter((item) => item.id !== session.id))).catch(() => setError(true)).finally(() => setBusy(false)); }}>{t("revokeBrowser")}</button>
    </article>)}
  </section>;
}
