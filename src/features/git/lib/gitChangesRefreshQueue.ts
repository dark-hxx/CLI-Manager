type RefreshJob = (reportError: boolean) => Promise<void>;
interface RefreshFlight { next: RefreshJob | null; reportError: boolean; promise: Promise<void> }

// 与 singleFlight 不同：在途期间的新请求必须补查一次，写操作不能复用写入前的快照。
export class GitChangesRefreshQueue {
  private flights = new Map<string, RefreshFlight>();

  request(key: string, job: RefreshJob, reportError: boolean): Promise<void> {
    const active = this.flights.get(key);
    if (active) {
      active.next = job;
      active.reportError ||= reportError;
      return active.promise;
    }
    const flight: RefreshFlight = { next: job, reportError, promise: Promise.resolve() };
    this.flights.set(key, flight);
    // 先发布 promise 再执行任务，允许同步 store 订阅者安全地重新请求。
    flight.promise = Promise.resolve().then(async () => {
      try {
        while (flight.next) {
          const next = flight.next;
          const loud = flight.reportError;
          flight.next = null;
          flight.reportError = false;
          await next(loud);
        }
      } finally {
        this.flights.delete(key);
      }
    });
    return flight.promise;
  }
}
