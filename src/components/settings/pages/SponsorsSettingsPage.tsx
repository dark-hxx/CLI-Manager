import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Card, Group, Image, Stack, Text, ThemeIcon } from "@mantine/core";
import { ExternalLink, Gift, Sparkles } from "lucide-react";
import { toast } from "sonner";
import fluxionBanner from "../../../../docs/img2/fluxion.png";
import fluxionLogo from "../../../../docs/img2/fluxion-logo.png";
import { useI18n } from "../../../lib/i18n";
import { FLUXION_REGISTER_URL } from "../../../lib/sponsors";

export function SponsorsSettingsPage() {
  const { t } = useI18n();

  const openRegistration = () => {
    void openUrl(FLUXION_REGISTER_URL).catch(() => {
      toast.error(t("sponsors.fluxion.openFailed"));
    });
  };

  return (
    <Stack gap="lg" maw={1040} mx="auto" pb="xl">
      <Card withBorder radius="lg" p={0} className="sponsor-card overflow-hidden">
        <div className="sponsor-card__banner-wrap">
          <Image
            src={fluxionBanner}
            alt={t("sponsors.fluxion.bannerAlt")}
            fit="cover"
            className="sponsor-card__banner"
          />
        </div>
        <Stack gap="xl" p={{ base: "md", sm: "xl" }}>
          <Group align="center" wrap="nowrap" gap="md">
            <div className="sponsor-card__logo-shell shrink-0">
              <Image src={fluxionLogo} alt={t("sponsors.fluxion.logoAlt")} fit="contain" className="sponsor-card__logo" />
            </div>
            <Stack gap={4}>
              <Text size="xs" fw={700} c="indigo" className="sponsor-card__category">
                {t("sponsors.fluxion.category")}
              </Text>
              <Text component="h2" m={0} size="xl" fw={800} lh={1.25} className="sponsor-card__title">
                {t("sponsors.fluxion.title")}
              </Text>
              <Text size="sm" c="dimmed" lh={1.7} className="sponsor-card__brand-name">
                {t("sponsors.fluxion.name")}
              </Text>
            </Stack>
          </Group>

          <Text size="sm" lh={1.8} className="sponsor-card__description">
            {t("sponsors.fluxion.description")}
          </Text>

          <div className="sponsor-card__actions">
            <Card withBorder radius="md" p="md" className="sponsor-card__benefit bg-surface-container-low">
              <Group gap="sm" align="flex-start" wrap="nowrap">
                <ThemeIcon size={32} radius="md" variant="light" color="orange">
                  <Gift size={16} aria-hidden="true" />
                </ThemeIcon>
                <Stack gap={2}>
                  <Text size="xs" fw={700} c="dimmed">
                    {t("sponsors.fluxion.benefitLabel")}
                  </Text>
                  <Text size="sm" fw={700} className="sponsor-card__benefit-copy">
                    {t("sponsors.fluxion.benefitPrefix")}
                    <code className="sponsor-card__coupon">CLIMANAGER</code>
                    {t("sponsors.fluxion.benefitSuffix")}
                  </Text>
                </Stack>
              </Group>
            </Card>
            <Button
              className="sponsor-card__cta"
              color="indigo"
              size="md"
              rightSection={<ExternalLink size={15} aria-hidden="true" />}
              leftSection={<Sparkles size={16} aria-hidden="true" />}
              onClick={openRegistration}
            >
              {t("sponsors.fluxion.register")}
            </Button>
          </div>
        </Stack>
      </Card>
    </Stack>
  );
}
