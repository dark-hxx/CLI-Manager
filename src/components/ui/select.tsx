import {
  Children,
  isValidElement,
  useMemo,
  type ChangeEvent,
  type ReactNode,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface ParsedOption {
  value: string;
  label: string;
  disabled?: boolean;
}

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) {
    const childProps = node.props as { children?: ReactNode };
    return nodeToText(childProps.children);
  }
  return "";
}

function collectOptions(children: ReactNode, acc: ParsedOption[]): void {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const props = child.props as {
        value?: string | number | readonly string[];
        children?: ReactNode;
        disabled?: boolean;
      };
      acc.push({
        value: String(props.value ?? ""),
        label: nodeToText(props.children),
        disabled: !!props.disabled,
      });
      return;
    }
    if (child.type === "optgroup") {
      const props = child.props as { children?: ReactNode };
      collectOptions(props.children, acc);
      return;
    }
    const props = child.props as { children?: ReactNode };
    if (props.children !== undefined) {
      collectOptions(props.children, acc);
    }
  });
}

interface SelectProps {
  className?: string;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  children?: ReactNode;
  name?: string;
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
  /** Invoked when a disabled option is clicked, without changing the value. */
  onDisabledOptionClick?: (value: string) => void;
}

export function Select({
  className,
  value,
  defaultValue,
  onChange,
  disabled,
  children,
  name,
  id,
  "aria-label": ariaLabel,
  placeholder,
  onDisabledOptionClick,
}: SelectProps) {
  const options = useMemo(() => {
    const list: ParsedOption[] = [];
    collectOptions(children, list);
    return list;
  }, [children]);
  const emptyOptionLabel = options.find((option) => option.value === "")?.label;
  const selectableOptions = options.filter((option) => option.value !== "");

  const handleValueChange = (next: string) => {
    if (!onChange) return;
    const fakeEvent = {
      target: { value: next, name },
      currentTarget: { value: next, name },
    } as unknown as ChangeEvent<HTMLSelectElement>;
    onChange(fakeEvent);
  };

  return (
    <SelectPrimitive.Root
      value={value !== undefined ? String(value) : undefined}
      defaultValue={defaultValue !== undefined ? String(defaultValue) : undefined}
      onValueChange={handleValueChange}
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
        <span data-slot="value" className="flex-1 truncate text-left">
          <SelectPrimitive.Value placeholder={placeholder ?? emptyOptionLabel ?? "请选择"} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown
            size={10}
            className="shrink-0 opacity-60 transition-transform data-[state=open]:rotate-180"
          />
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
            {selectableOptions.length === 0 && (
              <div className="px-3 py-2 text-on-surface-variant">无选项</div>
            )}
            {selectableOptions.map((opt) => (
              <SelectPrimitive.Item
                key={opt.value}
                value={opt.value}
                disabled={opt.disabled}
                onPointerDownCapture={(event) => {
                  if (!opt.disabled) return;
                  event.preventDefault();
                  onDisabledOptionClick?.(opt.value);
                }}
                className={cn(
                  "relative flex cursor-pointer items-center gap-2 px-3 py-1.5 outline-none",
                  "data-[highlighted]:bg-surface-container-highest",
                  "data-[state=checked]:font-semibold data-[state=checked]:text-primary",
                  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
                )}
              >
                <SelectPrimitive.ItemText asChild>
                  <span className="flex-1 truncate">{opt.label || opt.value}</span>
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
