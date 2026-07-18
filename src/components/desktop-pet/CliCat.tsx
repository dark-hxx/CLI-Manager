interface CliCatProps {
  className?: string;
  animated?: boolean;
  ariaLabel?: string;
}

export function CliCat({ className, animated = true, ariaLabel }: CliCatProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 34"
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      <g className={animated ? "ui-cpu-cat-run" : undefined}>
        <path className="ui-cpu-cat-tail" d="M37 18c6-1 7-8 2-10" />
        <path className="ui-cpu-cat-body" d="M13 14h19c4 0 7 3 7 7v1c0 3-3 5-6 5H14c-4 0-7-3-7-7s3-6 6-6Z" />
        <path className="ui-cpu-cat-head" d="M10 9 14 3l4 6h7l4-6 4 6v11H10V9Z" />
        <circle className="ui-cpu-cat-eye" cx="17" cy="13" r="1.3" />
        <circle className="ui-cpu-cat-eye" cx="26" cy="13" r="1.3" />
        <path className={animated ? "ui-cpu-cat-leg ui-cpu-cat-leg-a" : "ui-cpu-cat-leg"} d="M16 27v5" />
        <path className={animated ? "ui-cpu-cat-leg ui-cpu-cat-leg-b" : "ui-cpu-cat-leg"} d="M29 27v5" />
      </g>
    </svg>
  );
}
