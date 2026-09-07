export function singleFlight<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  let inFlight: Promise<TResult> | null = null;

  return (...args) => {
    if (inFlight) return inFlight;

    const current = action(...args);
    inFlight = current;
    const reset = () => {
      if (inFlight === current) inFlight = null;
    };
    void current.then(reset, reset);
    return current;
  };
}
