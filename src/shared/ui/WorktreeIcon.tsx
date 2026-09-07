import type { SVGProps } from "react";

export function WorktreeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M6.5 5.5v5.25A4.75 4.75 0 0 0 11.25 15.5H17"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 10.5h5.25A4.75 4.75 0 0 0 16.5 5.75V5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.75 13.25 17 15.5l-2.25 2.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="6.5" cy="5.5" r="2" fill="var(--surface-container-highest, currentColor)" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="5.5" r="2" fill="var(--surface-container-highest, currentColor)" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="15.5" r="2" fill="var(--surface-container-highest, currentColor)" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
