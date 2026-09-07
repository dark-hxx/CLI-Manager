import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/utils";

const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "ui-input ui-focus-ring h-8 w-full px-3 py-1.5 text-xs outline-none",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
