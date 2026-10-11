/** small inline loading spinner (inherits the text colour) */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-label="Loading"
      role="status"
      className={`inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px] ${className}`}
    />
  );
}
