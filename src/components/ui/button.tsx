import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "default" | "secondary" | "ghost" | "outline" | "destructive";
type ButtonSize = "default" | "sm" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  default: "ui-btn ui-btn-primary",
  secondary: "ui-btn",
  ghost: "ui-btn ui-btn-ghost",
  outline: "ui-btn ui-btn-outline",
  destructive: "ui-btn ui-btn-destructive",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-8 px-3 py-1.5",
  sm: "h-7 px-2.5 py-1 text-xs",
  icon: "h-7 w-7 p-0",
};

export function Button({ className, variant = "secondary", size = "default", type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(variantClasses[variant], sizeClasses[size], className)} {...props} />;
}
