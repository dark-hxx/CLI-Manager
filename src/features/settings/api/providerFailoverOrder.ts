interface FailoverOrderItem {
  sortIndex: number;
  inFailoverQueue: boolean;
}

/**
 * 自动故障切换模式先展示队列成员，再展示未入队供应商；两个分组内部仍以
 * provider.sort_index 为唯一持久化顺序。手动模式不改变供应商目录顺序。
 */
export function orderFailoverProviders<T extends FailoverOrderItem>(
  providers: readonly T[],
  queueFirst: boolean,
): T[] {
  return providers
    .map((provider, originalIndex) => ({ provider, originalIndex }))
    .sort((left, right) => {
      if (queueFirst && left.provider.inFailoverQueue !== right.provider.inFailoverQueue) {
        return left.provider.inFailoverQueue ? -1 : 1;
      }
      return left.provider.sortIndex - right.provider.sortIndex
        || left.originalIndex - right.originalIndex;
    })
    .map(({ provider }) => provider);
}
