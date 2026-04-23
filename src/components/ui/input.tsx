import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("ui-input ui-focus-ring h-8 w-full px-3 py-1.5 text-xs outline-none", className)} {...props} />;
}
