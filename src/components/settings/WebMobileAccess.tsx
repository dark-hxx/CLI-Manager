import { useEffect, useState } from "react";
import { Button, Group, Stack, Text } from "@mantine/core";
import { QRCodeSVG } from "qrcode.react";
import { webDeviceApi } from "../../lib/webDevice";
import { useI18n } from "../../lib/i18n";

export function WebMobileAccess({ serverUrl, publicAccessUrl, trustedNetwork, paired }: { serverUrl: string; publicAccessUrl: string; trustedNetwork: boolean; paired: boolean }) {
  const { t } = useI18n();
  const [ticket, setTicket] = useState<{ url: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const reachable = (() => {
    try {
      const url = new URL(publicAccessUrl || serverUrl);
      return (/^(https:|wss:)$/.test(url.protocol) || (trustedNetwork && /^(http:|ws:)$/.test(url.protocol)))
        && !/^(localhost$|127\.|\[?::1\]?$)/i.test(url.hostname);
    } catch { return false; }
  })();
  useEffect(() => { setTicket(null); }, [serverUrl, publicAccessUrl, trustedNetwork, paired]);
  useEffect(() => {
    if (!ticket) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticket]);
  const update = async (revoke: boolean) => {
    setBusy(true);
    setError(false);
    try { setTicket(await webDeviceApi.mobileTicket(revoke)); setNow(Date.now()); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  const remaining = ticket ? Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000)) : 0;
  return <Stack gap="xs">
    <Text fw={600} size="sm">{t("settings.webMobile.title")}</Text>
    <Text size="xs" c="var(--text-muted)">{t(reachable ? "settings.webMobile.hint" : "settings.webMobile.httpsRequired")}</Text>
    <Group gap="xs">
      <Button size="xs" disabled={!paired || !reachable || busy} loading={busy} onClick={() => void update(false)}>{t(ticket ? "settings.webMobile.refresh" : "settings.webMobile.create")}</Button>
      {ticket && <Button size="xs" color="red" variant="light" disabled={busy} onClick={() => void update(true)}>{t("settings.webMobile.stop")}</Button>}
    </Group>
    {ticket && remaining > 0 && <div style={{ background: "white", padding: 12, width: "fit-content" }}><QRCodeSVG value={ticket.url} size={192} title={t("settings.webMobile.title")} /></div>}
    {ticket && <Text size="xs">{remaining > 0 ? t("settings.webMobile.expiry", { seconds: remaining }) : t("settings.webMobile.expired")}</Text>}
    {error && <Text size="xs" c="red" role="alert">{t("settings.webMobile.failed")}</Text>}
  </Stack>;
}
