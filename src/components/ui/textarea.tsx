import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("ui-input ui-focus-ring w-full px-3 py-2 text-xs outline-none", className)} {...props} />;
}
