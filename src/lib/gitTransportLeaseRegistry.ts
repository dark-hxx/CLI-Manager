export interface GitTransportLeaseResource<T> {
  value: T;
  dispose: () => Promise<void>;
}

export interface GitTransportLease<T> {
  contextKey: string;
  value: T;
  release: () => Promise<void>;
}

interface RegistryEntry<T> {
  refCount: number;
  resource: Promise<GitTransportLeaseResource<T>>;
}

export class GitTransportLeaseRegistry<T> {
  private readonly entries = new Map<string, RegistryEntry<T>>();
  private readonly pendingReleases = new Map<string, Promise<void>>();

  async acquire(
    contextKey: string,
    create: () => Promise<GitTransportLeaseResource<T>>,
  ): Promise<GitTransportLease<T>> {
    let entry = this.entries.get(contextKey);
    if (!entry) {
      entry = {
        refCount: 0,
        resource: this.createResource(contextKey, create),
      };
      this.entries.set(contextKey, entry);
    }
    entry.refCount += 1;

    let resource: GitTransportLeaseResource<T>;
    try {
      resource = await entry.resource;
    } catch (error) {
      entry.refCount -= 1;
      if (entry.refCount === 0 && this.entries.get(contextKey) === entry) {
        this.entries.delete(contextKey);
      }
      throw error;
    }

    let released = false;
    return {
      contextKey,
      value: resource.value,
      release: async () => {
        if (released) return;
        released = true;
        await this.release(contextKey, entry, resource);
      },
    };
  }

  private async createResource(
    contextKey: string,
    create: () => Promise<GitTransportLeaseResource<T>>,
  ): Promise<GitTransportLeaseResource<T>> {
    await this.pendingReleases.get(contextKey)?.catch(() => undefined);
    return create();
  }

  private async release(
    contextKey: string,
    entry: RegistryEntry<T>,
    resource: GitTransportLeaseResource<T>,
  ): Promise<void> {
    entry.refCount -= 1;
    if (entry.refCount > 0 || this.entries.get(contextKey) !== entry) return;

    this.entries.delete(contextKey);
    const previousRelease = this.pendingReleases.get(contextKey) ?? Promise.resolve();
    const pendingRelease = previousRelease
      .catch(() => undefined)
      .then(resource.dispose)
      .finally(() => {
        if (this.pendingReleases.get(contextKey) === pendingRelease) {
          this.pendingReleases.delete(contextKey);
        }
      });
    this.pendingReleases.set(contextKey, pendingRelease);
    await pendingRelease;
  }
}
