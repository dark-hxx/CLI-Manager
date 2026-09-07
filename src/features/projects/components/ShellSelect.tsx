import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../../shared/lib/utils";
import { ShellIcon } from "../../../shared/ui/ShellIcon";

export interface ShellSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface ShellSelectProps {
  className?: string;
  value?: string;
  options: readonly ShellSelectOption[];
  onChange?: (value: string) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export function ShellSelect({
  className,
  value,
  options,
  onChange,
  disabled,
  id,
  name,
  ariaLabel,
  placeholder,
}: ShellSelectProps) {
  return (
    <SelectPrimitive.Root
      value={value || undefined}
      onValueChange={onChange}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "ui-input ui-focus-ring flex h-8 w-full items-center justify-between gap-2 px-3 py-1.5 text-xs outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[placeholder]:[&_[data-slot=value]]:text-on-surface-variant",
          className
        )}
      >
        <span data-slot="value" className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {value ? <ShellIcon shell={value} size={16} /> : null}
          <span className="min-w-0 flex-1 truncate">
            <SelectPrimitive.Value placeholder={placeholder} />
          </span>
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown size={10} className="shrink-0 opacity-60 transition-transform data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "ui-select-popover z-[1000] overflow-hidden rounded-xl border border-border bg-surface-container-high py-1 text-xs shadow-lg",
            "data-[state=open]:animate-slide-down"
          )}
          style={{
            width: "var(--radix-select-trigger-width)",
            maxHeight: 280,
          }}
        >
          <SelectPrimitive.Viewport className="overflow-auto p-0">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "relative flex cursor-pointer items-center gap-2 px-3 py-1.5 outline-none",
                  "data-[highlighted]:bg-surface-container-highest",
                  "data-[state=checked]:font-semibold data-[state=checked]:text-primary",
                  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
                )}
              >
                <ShellIcon shell={option.value} size={16} />
                <SelectPrimitive.ItemText asChild>
                  <span className="min-w-0 flex-1 truncate">{option.label || option.value}</span>
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="shrink-0">
                  <Check size={12} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
