/** A bounded map: recent messages, spaces and action ids are kept in memory so they can be looked up by id. */
export class Recent<V> {
  private readonly items = new Map<string, V>();
  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    return this.items.get(key);
  }

  set(key: string, value: V): void {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
  }

  delete(key: string): void {
    this.items.delete(key);
  }
}
