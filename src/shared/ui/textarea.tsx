import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/utils";

const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "ui-input ui-focus-ring w-full px-3 py-2 text-xs outline-none",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";

export { Textarea };
