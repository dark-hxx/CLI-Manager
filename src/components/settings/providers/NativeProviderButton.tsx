import { forwardRef } from "react";
import {
  ActionIcon as MantineActionIcon,
  Button as MantineButton,
  type ActionIconProps,
  type ButtonProps,
} from "@mantine/core";
import { cn } from "@/lib/utils";

function controlTone(variant: string | undefined, color: unknown): string {
  const resolvedVariant = variant ?? "filled";
  const resolvedColor = typeof color === "string" ? color : "cliPrimary";
  const isDanger = resolvedColor === "red";
  const isSuccess = resolvedColor === "green";
  const isMuted = resolvedColor === "gray";

  if (resolvedVariant === "filled") {
    if (isDanger) return "native-provider-control--danger";
    if (isSuccess) return "native-provider-control--success";
    if (isMuted) return "native-provider-control--secondary";
    return "native-provider-control--primary";
  }

  if (resolvedVariant === "light") {
    if (isDanger) return "native-provider-control--soft-danger";
    if (isSuccess) return "native-provider-control--soft-success";
    if (isMuted) return "native-provider-control--secondary";
    return "native-provider-control--soft-primary";
  }

  if (resolvedVariant === "subtle" || resolvedVariant === "transparent") {
    if (isDanger) return "native-provider-control--ghost-danger";
    if (isSuccess) return "native-provider-control--ghost-success";
    return "native-provider-control--ghost";
  }

  if (resolvedVariant === "outline") return "native-provider-control--outline";
  return "native-provider-control--secondary";
}

const NativeProviderButtonBase = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, color, variant, ...props }, ref) => (
    <MantineButton
      {...props}
      ref={ref}
      color={color}
      variant={variant}
      className={cn("native-provider-control", controlTone(variant, color), className)}
    />
  ),
);

NativeProviderButtonBase.displayName = "NativeProviderButton";

const NativeProviderActionIconBase = forwardRef<HTMLButtonElement, ActionIconProps>(
  ({ className, color, variant, ...props }, ref) => (
    <MantineActionIcon
      {...props}
      ref={ref}
      color={color}
      variant={variant}
      className={cn("native-provider-control", controlTone(variant, color), className)}
    />
  ),
);

NativeProviderActionIconBase.displayName = "NativeProviderActionIcon";

// Preserve Mantine's polymorphic surface: provider links keep `component="a"`,
// and the CLI type tabs retain their button ref for roving focus.
export const NativeProviderButton = NativeProviderButtonBase as unknown as typeof MantineButton;
export const NativeProviderActionIcon = NativeProviderActionIconBase as unknown as typeof MantineActionIcon;
